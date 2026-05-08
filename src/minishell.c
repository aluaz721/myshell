#define _POSIX_C_SOURCE 200809L
#define _XOPEN_SOURCE   700

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <unistd.h>
#include <errno.h>
#include <string.h>
#include <signal.h>
#include <fcntl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <pwd.h>

#define BRIGHTBLUE "\x1b[34;1m"
#define DEFAULT    "\x1b[0m"

#define MAX_CMD_LEN  4096
#define MAX_TOKENS   2048
#define MAX_PIPES    64
#define HISTORY_MAX  500

/* ── signal flag ── */
static volatile sig_atomic_t interrupted = 0;

/* ── last exit status (for $?) ── */
static int last_exit_status = 0;

/* ── command history ── */
static char *history[HISTORY_MAX];
static int   history_count = 0;

/* ────────────────────────────────────────────────────────────────────
   Signal handler
   ────────────────────────────────────────────────────────────────── */
static void handle_sigint(int sig) {
    (void)sig;
    interrupted = 1;
    write(STDOUT_FILENO, "\n", 1);
}

/* Ignore SIGINT in child processes that should run to completion      */
static void ignore_sigint(void) {
    struct sigaction sa = {0};
    sa.sa_handler = SIG_IGN;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGINT, &sa, NULL);
}

/* ────────────────────────────────────────────────────────────────────
   History
   ────────────────────────────────────────────────────────────────── */
static void history_add(const char *line) {
    if (line[0] == '\0') return;
    /* avoid duplicate of the most recent entry */
    if (history_count > 0 &&
        strcmp(history[history_count - 1], line) == 0) return;

    if (history_count == HISTORY_MAX) {
        free(history[0]);
        memmove(history, history + 1,
                (HISTORY_MAX - 1) * sizeof(char *));
        history_count--;
    }
    history[history_count] = strdup(line);
    if (!history[history_count]) {
        fprintf(stderr, "Error: strdup() failed. %s.\n", strerror(errno));
    } else {
        history_count++;
    }
}

static void history_free(void) {
    for (int i = 0; i < history_count; i++) {
        free(history[i]);
        history[i] = NULL;
    }
    history_count = 0;
}

/* ────────────────────────────────────────────────────────────────────
   Environment-variable & tilde expansion
   ────────────────────────────────────────────────────────────────── */

/* Expand $VAR, ${VAR}, $?, $$ inside a single token.
   Returns a newly-malloc'd string; caller must free it.             */
static char *expand_vars(const char *token) {
    char  buf[MAX_CMD_LEN];
    int   blen = 0;
    const char *p = token;

    while (*p) {
        if (*p != '$') {
            if (blen < (int)sizeof(buf) - 1)
                buf[blen++] = *p++;
            else
                p++;
            continue;
        }

        p++; /* skip '$' */

        /* $? — exit status of last foreground command */
        if (*p == '?') {
            char tmp[16];
            int  n = snprintf(tmp, sizeof(tmp), "%d", last_exit_status);
            for (int i = 0; i < n && blen < (int)sizeof(buf) - 1; i++)
                buf[blen++] = tmp[i];
            p++;
            continue;
        }

        /* $$ — PID of the shell itself */
        if (*p == '$') {
            char tmp[16];
            int  n = snprintf(tmp, sizeof(tmp), "%d", (int)getpid());
            for (int i = 0; i < n && blen < (int)sizeof(buf) - 1; i++)
                buf[blen++] = tmp[i];
            p++;
            continue;
        }

        /* ${VAR} */
        int braces = (*p == '{');
        if (braces) p++;

        /* collect variable name */
        char name[256];
        int  nlen = 0;
        while (*p && ((*p >= 'A' && *p <= 'Z') ||
                      (*p >= 'a' && *p <= 'z') ||
                      (*p >= '0' && *p <= '9') ||
                      *p == '_')) {
            if (nlen < (int)sizeof(name) - 1)
                name[nlen++] = *p;
            p++;
        }
        name[nlen] = '\0';
        if (braces && *p == '}') p++;

        if (nlen > 0) {
            const char *val = getenv(name);
            if (val) {
                for (int i = 0; val[i] && blen < (int)sizeof(buf) - 1; i++)
                    buf[blen++] = val[i];
            }
        } else {
            /* bare '$' with nothing recognisable after it */
            if (blen < (int)sizeof(buf) - 1)
                buf[blen++] = '$';
        }
    }

    buf[blen] = '\0';
    char *result = strdup(buf);
    if (!result)
        fprintf(stderr, "Error: strdup() failed. %s.\n", strerror(errno));
    return result;
}

/* Expand a leading '~' to the home directory.
   Returns a pointer to a static buffer (no malloc).                */
static const char *expand_tilde(const char *path) {
    static char expanded[MAX_CMD_LEN];
    if (path[0] != '~') return path;

    struct passwd *pw = getpwuid(getuid());
    if (!pw) {
        fprintf(stderr, "Error: Cannot get passwd entry. %s.\n",
                strerror(errno));
        return NULL;
    }

    int n = snprintf(expanded, sizeof(expanded),
                     "%s%s", pw->pw_dir, path + 1);
    if (n < 0 || (size_t)n >= sizeof(expanded)) {
        fprintf(stderr, "Error: Path too long.\n");
        return NULL;
    }
    return expanded;
}

/* ────────────────────────────────────────────────────────────────────
   Tokenizer
   ────────────────────────────────────────────────────────────────── */
static int tokenize(char *line, char **tokens, int max_tokens) {
    int   count = 0;
    char *p     = line;

    while (*p != '\0') {
        while (*p == ' ' || *p == '\t') p++;
        if (*p == '\0') break;
        if (count >= max_tokens - 1) break;

        if (*p == '"') {
            char buf[MAX_CMD_LEN];
            int  blen = 0;

            while (*p == '"') {
                p++;
                while (*p != '"') {
                    if (*p == '\0') {
                        fprintf(stderr,
                                "Error: Missing closing quote. %s.\n",
                                strerror(errno));
                        return -1;
                    }
                    buf[blen++] = *p++;
                }
                p++;
            }
            buf[blen] = '\0';

            tokens[count] = malloc(blen + 1);
            if (!tokens[count]) {
                fprintf(stderr, "Error: malloc() failed. %s.\n",
                        strerror(errno));
                return -1;
            }
            memcpy(tokens[count], buf, blen + 1);
            count++;

        } else {
            char *start = p;
            while (*p != '\0' && *p != ' ' && *p != '\t' && *p != '"')
                p++;
            int len = (int)(p - start);

            tokens[count] = malloc(len + 1);
            if (!tokens[count]) {
                fprintf(stderr, "Error: malloc() failed. %s.\n",
                        strerror(errno));
                return -1;
            }
            memcpy(tokens[count], start, len);
            tokens[count][len] = '\0';
            count++;
        }
    }

    tokens[count] = NULL;
    return count;
}

static void free_tokens(char **tokens, int count) {
    for (int i = 0; i < count; i++) {
        free(tokens[i]);
        tokens[i] = NULL;
    }
}

/* ────────────────────────────────────────────────────────────────────
   Variable expansion pass (applied after tokenize)
   ────────────────────────────────────────────────────────────────── */
static void expand_tokens(char **tokens, int count) {
    for (int i = 0; i < count; i++) {
        /* tilde expand first */
        if (tokens[i][0] == '~') {
            const char *exp = expand_tilde(tokens[i]);
            if (exp && exp != tokens[i]) {
                char *dup = strdup(exp);
                if (dup) { free(tokens[i]); tokens[i] = dup; }
            }
        }
        /* then variable expand (skip pure redirect operators) */
        if (strcmp(tokens[i], "|")  == 0 ||
            strcmp(tokens[i], ">")  == 0 ||
            strcmp(tokens[i], ">>") == 0 ||
            strcmp(tokens[i], "<")  == 0 ||
            strcmp(tokens[i], "&")  == 0) continue;

        char *exp = expand_vars(tokens[i]);
        if (exp) { free(tokens[i]); tokens[i] = exp; }
    }
}

/* ────────────────────────────────────────────────────────────────────
   I/O redirection helpers
   ────────────────────────────────────────────────────────────────── */
typedef struct {
    char *in_file;   /* NULL = no redirect */
    char *out_file;  /* NULL = no redirect */
    int   append;    /* 1 = >> , 0 = > */
} Redir;

/*
 * Strip redirection tokens from a segment, fill *redir, and
 * null-terminate the cleaned argv.
 * Returns 0 on success, -1 on error.
 */
static int parse_redir(char **seg, int seg_count,
                        char **clean_argv, int *clean_count,
                        Redir *redir)
{
    redir->in_file  = NULL;
    redir->out_file = NULL;
    redir->append   = 0;
    *clean_count    = 0;

    for (int i = 0; i < seg_count; i++) {
        if (strcmp(seg[i], "<") == 0) {
            if (i + 1 >= seg_count) {
                fprintf(stderr, "Error: Missing filename after '<'.\n");
                return -1;
            }
            redir->in_file = seg[++i];
        } else if (strcmp(seg[i], ">>") == 0) {
            if (i + 1 >= seg_count) {
                fprintf(stderr, "Error: Missing filename after '>>'.\n");
                return -1;
            }
            redir->out_file = seg[++i];
            redir->append   = 1;
        } else if (strcmp(seg[i], ">") == 0) {
            if (i + 1 >= seg_count) {
                fprintf(stderr, "Error: Missing filename after '>'.\n");
                return -1;
            }
            redir->out_file = seg[++i];
            redir->append   = 0;
        } else {
            clean_argv[(*clean_count)++] = seg[i];
        }
    }
    clean_argv[*clean_count] = NULL;
    return 0;
}

/* Apply redirections in a child process. Returns 0 or exits.         */
static int apply_redir(const Redir *redir) {
    if (redir->in_file) {
        int fd = open(redir->in_file, O_RDONLY);
        if (fd < 0) {
            fprintf(stderr, "Error: Cannot open '%s'. %s.\n",
                    redir->in_file, strerror(errno));
            return -1;
        }
        if (dup2(fd, STDIN_FILENO) < 0) {
            fprintf(stderr, "Error: dup2() failed. %s.\n", strerror(errno));
            close(fd);
            return -1;
        }
        close(fd);
    }

    if (redir->out_file) {
        int flags = O_WRONLY | O_CREAT | (redir->append ? O_APPEND : O_TRUNC);
        int fd    = open(redir->out_file, flags, 0644);
        if (fd < 0) {
            fprintf(stderr, "Error: Cannot open '%s'. %s.\n",
                    redir->out_file, strerror(errno));
            return -1;
        }
        if (dup2(fd, STDOUT_FILENO) < 0) {
            fprintf(stderr, "Error: dup2() failed. %s.\n", strerror(errno));
            close(fd);
            return -1;
        }
        close(fd);
    }
    return 0;
}

/* ────────────────────────────────────────────────────────────────────
   Built-in: cd
   ────────────────────────────────────────────────────────────────── */
static void my_cd(char **tokens, int count) {
    if (count > 2) {
        fprintf(stderr, "Error: Too many arguments to cd.\n");
        return;
    }

    const char *target;

    if (count == 1 || strcmp(tokens[1], "~") == 0) {
        struct passwd *pw = getpwuid(getuid());
        if (!pw) {
            fprintf(stderr, "Error: Cannot get passwd entry. %s.\n",
                    strerror(errno));
            return;
        }
        target = pw->pw_dir;
    } else {
        target = expand_tilde(tokens[1]);
        if (!target) return;
    }

    if (chdir(target) != 0) {
        fprintf(stderr, "Error: Cannot change directory to '%s'. %s.\n",
                target, strerror(errno));
        last_exit_status = 1;
    } else {
        last_exit_status = 0;
    }
}

/* ────────────────────────────────────────────────────────────────────
   Built-in: history
   ────────────────────────────────────────────────────────────────── */
static void my_history(void) {
    for (int i = 0; i < history_count; i++)
        printf("%4d  %s\n", i + 1, history[i]);
    last_exit_status = 0;
}

/* ────────────────────────────────────────────────────────────────────
   Built-in: export
   ────────────────────────────────────────────────────────────────── */
static void my_export(char **tokens, int count) {
    if (count < 2) {
        /* print all environment variables */
        extern char **environ;
        for (char **e = environ; *e; e++)
            printf("export %s\n", *e);
        last_exit_status = 0;
        return;
    }
    for (int i = 1; i < count; i++) {
        char *eq = strchr(tokens[i], '=');
        if (!eq) {
            /* export NAME  — mark existing variable for export */
            /* putenv requires "NAME=VALUE" format; skip bare names */
            continue;
        }
        if (putenv(tokens[i]) != 0) {
            fprintf(stderr, "Error: putenv() failed. %s.\n", strerror(errno));
            last_exit_status = 1;
            return;
        }
    }
    last_exit_status = 0;
}

/* ────────────────────────────────────────────────────────────────────
   Built-in: unset
   ────────────────────────────────────────────────────────────────── */
static void my_unset(char **tokens, int count) {
    for (int i = 1; i < count; i++) {
        if (unsetenv(tokens[i]) != 0) {
            fprintf(stderr, "Error: unsetenv() failed. %s.\n",
                    strerror(errno));
            last_exit_status = 1;
            return;
        }
    }
    last_exit_status = 0;
}

/* ────────────────────────────────────────────────────────────────────
   Execute a single (non-pipeline) external command
   ────────────────────────────────────────────────────────────────── */
static void exec_cmd(char **argv, const Redir *redir, int background) {
    pid_t pid = fork();
    if (pid < 0) {
        fprintf(stderr, "Error: fork() failed. %s.\n", strerror(errno));
        last_exit_status = 1;
        return;
    }

    if (pid == 0) {
        /* child */
        if (background) ignore_sigint();

        if (apply_redir(redir) < 0) exit(EXIT_FAILURE);

        execvp(argv[0], argv);
        fprintf(stderr, "Error: exec() failed. %s.\n", strerror(errno));
        exit(EXIT_FAILURE);
    }

    /* parent */
    if (background) {
        printf("[bg] %d\n", (int)pid);
        last_exit_status = 0;
    } else {
        int status;
        if (waitpid(pid, &status, 0) < 0) {
            if (errno != EINTR)
                fprintf(stderr, "Error: wait() failed. %s.\n",
                        strerror(errno));
            last_exit_status = 1;
        } else {
            last_exit_status = WIFEXITED(status)
                               ? WEXITSTATUS(status)
                               : 128 + WTERMSIG(status);
        }
    }
}

/* ────────────────────────────────────────────────────────────────────
   Pipeline execution
   ────────────────────────────────────────────────────────────────── */
static void exec_pipeline(char ***segments, int *seg_counts,
                           int ncmd, int background) {
    if (ncmd == 1) {
        /* single command — parse its own redirections */
        char *clean[MAX_TOKENS];
        int   clean_count;
        Redir redir;
        if (parse_redir(segments[0], seg_counts[0],
                        clean, &clean_count, &redir) < 0) return;
        exec_cmd(clean, &redir, background);
        return;
    }

    int    pipes[MAX_PIPES - 1][2];
    pid_t  pids[MAX_PIPES];

    for (int i = 0; i < ncmd - 1; i++) {
        if (pipe(pipes[i]) < 0) {
            fprintf(stderr, "Error: pipe() failed. %s.\n", strerror(errno));
            for (int j = 0; j < i; j++) {
                close(pipes[j][0]);
                close(pipes[j][1]);
            }
            last_exit_status = 1;
            return;
        }
    }

    for (int i = 0; i < ncmd; i++) {
        /* parse redirections for this segment */
        char *clean[MAX_TOKENS];
        int   clean_count;
        Redir redir;
        if (parse_redir(segments[i], seg_counts[i],
                        clean, &clean_count, &redir) < 0) {
            /* close all pipes and wait for already-started children */
            for (int k = 0; k < ncmd - 1; k++) {
                close(pipes[k][0]);
                close(pipes[k][1]);
            }
            for (int k = 0; k < i; k++)
                waitpid(pids[k], NULL, 0);
            last_exit_status = 1;
            return;
        }

        pids[i] = fork();
        if (pids[i] < 0) {
            fprintf(stderr, "Error: fork() failed. %s.\n", strerror(errno));
            for (int k = 0; k < ncmd - 1; k++) {
                close(pipes[k][0]);
                close(pipes[k][1]);
            }
            for (int k = 0; k < i; k++)
                waitpid(pids[k], NULL, 0);
            last_exit_status = 1;
            return;
        }

        if (pids[i] == 0) {
            /* child: wire up pipes */
            if (i > 0 && redir.in_file == NULL) {
                if (dup2(pipes[i - 1][0], STDIN_FILENO) < 0) {
                    perror("dup2"); exit(EXIT_FAILURE);
                }
            }
            if (i < ncmd - 1 && redir.out_file == NULL) {
                if (dup2(pipes[i][1], STDOUT_FILENO) < 0) {
                    perror("dup2"); exit(EXIT_FAILURE);
                }
            }
            for (int k = 0; k < ncmd - 1; k++) {
                close(pipes[k][0]);
                close(pipes[k][1]);
            }
            /* apply any explicit file redirections (override pipe ends) */
            if (apply_redir(&redir) < 0) exit(EXIT_FAILURE);

            execvp(clean[0], clean);
            fprintf(stderr, "Error: exec() failed. %s.\n", strerror(errno));
            exit(EXIT_FAILURE);
        }
    }

    /* parent: close all pipe ends */
    for (int i = 0; i < ncmd - 1; i++) {
        close(pipes[i][0]);
        close(pipes[i][1]);
    }

    if (background) {
        printf("[bg pipeline] pids:");
        for (int i = 0; i < ncmd; i++) printf(" %d", (int)pids[i]);
        printf("\n");
        last_exit_status = 0;
    } else {
        int last_status = 0;
        for (int i = 0; i < ncmd; i++) {
            int status;
            if (waitpid(pids[i], &status, 0) < 0 && errno != EINTR)
                fprintf(stderr, "Error: wait() failed. %s.\n",
                        strerror(errno));
            if (i == ncmd - 1)
                last_status = WIFEXITED(status)
                              ? WEXITSTATUS(status)
                              : 128 + WTERMSIG(status);
        }
        last_exit_status = last_status;
    }
}

/* ────────────────────────────────────────────────────────────────────
   Pipeline splitter
   ────────────────────────────────────────────────────────────────── */
static int split_pipeline(char **tokens, int count,
                           char **seg_tokens[],
                           int    seg_counts[])
{
    int seg   = 0;
    int start = 0;

    for (int i = 0; i <= count; i++) {
        if (tokens[i] == NULL || strcmp(tokens[i], "|") == 0) {
            if (i == start) {
                fprintf(stderr, "Error: Empty command in pipeline.\n");
                return -1;
            }
            if (seg >= MAX_PIPES) {
                fprintf(stderr, "Error: Too many pipe segments.\n");
                return -1;
            }
            seg_tokens[seg] = tokens + start;
            seg_counts[seg] = i - start;
            tokens[i]       = NULL;
            seg++;
            start = i + 1;
        }
    }
    return seg;
}

/* ────────────────────────────────────────────────────────────────────
   Reap background children (non-blocking)
   ────────────────────────────────────────────────────────────────── */
static void reap_background(void) {
    pid_t pid;
    int   status;
    while ((pid = waitpid(-1, &status, WNOHANG)) > 0) {
        int code = WIFEXITED(status)
                   ? WEXITSTATUS(status)
                   : 128 + WTERMSIG(status);
        printf("[done] %d  exit %d\n", (int)pid, code);
    }
}

/* ────────────────────────────────────────────────────────────────────
   main
   ────────────────────────────────────────────────────────────────── */
int main(void) {
    /* register SIGINT handler */
    struct sigaction sa = {0};
    sa.sa_handler = handle_sigint;
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = 0;
    if (sigaction(SIGINT, &sa, NULL) < 0) {
        fprintf(stderr, "Error: Cannot register signal handler. %s.\n",
                strerror(errno));
        return EXIT_FAILURE;
    }

    /* ignore SIGTTOU so background processes don't stop on tty writes */
    signal(SIGTTOU, SIG_IGN);

    char  line[MAX_CMD_LEN];
    char *tokens[MAX_TOKENS];

    while (1) {
        interrupted = 0;

        /* reap any finished background jobs */
        reap_background();

        /* print prompt: [cwd]$ */
        char cwd[MAX_CMD_LEN];
        if (getcwd(cwd, sizeof(cwd)) == NULL) {
            fprintf(stderr,
                    "Error: Cannot get current working directory. %s.\n",
                    strerror(errno));
            return EXIT_FAILURE;
        }
        printf("[%s%s%s]$ ", BRIGHTBLUE, cwd, DEFAULT);
        fflush(stdout);

        /* read a line */
        if (fgets(line, sizeof(line), stdin) == NULL) {
            if (interrupted) { continue; }
            if (feof(stdin) || errno == EINTR) {
                printf("\n");
                history_free();
                return EXIT_SUCCESS;
            }
            fprintf(stderr, "Error: Failed to read from stdin. %s.\n",
                    strerror(errno));
            history_free();
            return EXIT_FAILURE;
        }

        if (interrupted) continue;

        /* strip trailing newline */
        size_t len = strlen(line);
        if (len > 0 && line[len - 1] == '\n') line[--len] = '\0';

        /* blank line */
        if (len == 0) continue;

        /* detect background operator ('&' as last token) */
        int background = 0;
        if (len > 0 && line[len - 1] == '&') {
            background = 1;
            line[--len] = '\0';
            /* strip trailing whitespace before '&' */
            while (len > 0 && (line[len - 1] == ' ' ||
                                line[len - 1] == '\t'))
                line[--len] = '\0';
        }

        /* tokenize */
        int count = tokenize(line, tokens, MAX_TOKENS);
        if (count < 0) return EXIT_FAILURE;
        if (count == 0) continue;

        /* expand variables and tildes */
        expand_tokens(tokens, count);

        /* add to history (before built-ins so history shows everything) */
        history_add(line);

        /* ── built-ins ── */
        if (strcmp(tokens[0], "exit") == 0) {
            int code = (count >= 2) ? atoi(tokens[1]) : 0;
            free_tokens(tokens, count);
            history_free();
            return code;
        }

        if (strcmp(tokens[0], "cd") == 0) {
            my_cd(tokens, count);
            free_tokens(tokens, count);
            continue;
        }

        if (strcmp(tokens[0], "history") == 0) {
            my_history();
            free_tokens(tokens, count);
            continue;
        }

        if (strcmp(tokens[0], "export") == 0) {
            my_export(tokens, count);
            free_tokens(tokens, count);
            continue;
        }

        if (strcmp(tokens[0], "unset") == 0) {
            my_unset(tokens, count);
            free_tokens(tokens, count);
            continue;
        }

        /* ── external commands / pipeline ── */
        char *tokens_copy[MAX_TOKENS];
        char **seg_tokens[MAX_PIPES];
        int    seg_counts[MAX_PIPES];

        memcpy(tokens_copy, tokens, (count + 1) * sizeof(char *));

        int ncmd = split_pipeline(tokens, count, seg_tokens, seg_counts);
        if (ncmd < 0) {
            free_tokens(tokens_copy, count);
            continue;
        }

        exec_pipeline(seg_tokens, seg_counts, ncmd, background);
        free_tokens(tokens_copy, count);
    }

    history_free();
    return EXIT_SUCCESS;
}