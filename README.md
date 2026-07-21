# [UNIX Shell & Broswer-Based Terminal](https://minishell-6xs8.onrender.com)

A POSIX-like shell written in C, with a web-based terminal GUI.

Live URL: https://minishell-6xs8.onrender.com

```
Browser (xterm.js)  ←──WebSocket──→  Node.js server  ←──PTY──→  minishell (C)
```

## Features

| Feature | Notes |
|---|---|
| Pipelines | `ls \| grep .c \| wc -l` — up to 64 segments |
| I/O redirection | `>` `>>` `<` — works inside pipelines too |
| Background jobs | `sleep 10 &` — shell reaps them at each prompt |
| Variable expansion | `$VAR` `${VAR}` `$?` `$$` |
| Tilde expansion | `~/foo` → `/home/user/foo` |
| Command history | 500-entry ring buffer, deduplicated |
| Built-ins | `cd` `exit [n]` `history` `export` `unset` |

## Project layout

```
myshell/
├── minishell.c        ← the shell (C)
├── Makefile
├── Dockerfile
├── docker-compose.yml
└── frontend/
    ├── package.json
    ├── src/
    │   └── server.js  ← Node.js WebSocket + PTY bridge
    └── public/
        ├── index.html
        ├── style.css
        └── terminal.js
```

## Build and Run with Docker
```bash
docker compose up --build
```

Open **http://localhost:3000** in your browser.


## Quick start without Docker 

### 1. Build the shell

```bash
make          # produces ./minishell
```

### 2. Install GUI dependencies

```bash
cd frontend
npm install
```

`node-pty` compiles a native addon — you need `python3`, `make`, and a C++
compiler. On Ubuntu/Debian: `sudo apt install build-essential python3`.
On macOS Xcode Command Line Tools are enough.

### 3. Run

```bash
# from the frontend/ directory
SHELL_BIN={pwd}../minishell /usr/bin/node src/server.js
```

Open **http://localhost:3000** in your browser.


## How the integration works

```
User types a key
      │
      ▼
xterm.js (browser)
  term.onData(data)
      │  JSON { type:"input", data:"ls\r" }
      ▼
WebSocket  ──────────────────────────────────────────────────────►  server.js
                                                                       │
                                                                       │  shell.write(data)
                                                                       ▼
                                                                   node-pty
                                                                   (PTY master)
                                                                       │
                                                              ─ ─ ─ ─ ─│─ ─ ─ ─ ─
                                                              kernel line discipline
                                                              ─ ─ ─ ─ ─│─ ─ ─ ─ ─
                                                                       │
                                                                       ▼
                                                                   minishell (C)
                                                              reads from stdin,
                                                              writes to stdout
                                                                       │
                                                              ─ ─ ─ ─ ─│─ ─ ─ ─ ─
                                                                       │
                                                                   node-pty
                                                                   shell.onData(out)
                                                                       │
                                                           JSON { type:"output", data }
WebSocket  ◄──────────────────────────────────────────────────────────┘
      │
      ▼
xterm.js
  term.write(data)
      │
      ▼
Canvas renders ANSI output
```

### Resize flow

When the browser window changes size:

1. `ResizeObserver` fires
2. `fitAddon.fit()` recalculates `term.cols` and `term.rows` to fill the DOM element
3. `terminal.js` sends `{ type:"resize", cols, rows }` over the WebSocket
4. `server.js` calls `shell.resize(cols, rows)` on the PTY
5. The kernel sends `SIGWINCH` to `minishell`
6. The shell's `readline` (or your own logic if you handle it) redraws

### Multiple sessions

Each browser tab that opens `ws://localhost:3000/terminal` gets its own
WebSocket connection → its own `pty.spawn()` call → its own independent
shell process. No shared state.
