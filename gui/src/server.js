/**
 * server.js — minishell GUI backend
 *
 * What this does:
 *   1. Serves the static frontend (public/) over HTTP
 *   2. Upgrades /terminal connections to a WebSocket
 *   3. For each WebSocket, spawns your minishell binary inside a PTY
 *   4. Pipes PTY output → WebSocket (raw bytes → browser)
 *      and WebSocket messages → PTY stdin (keystrokes → shell)
 *   5. Forwards terminal resize events from the browser to the PTY
 */

"use strict";

const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const os     = require("os");
const pty    = require("node-pty");
const { WebSocketServer } = require("ws");

// ── Configuration ─────────────────────────────────────────────────────────────

const PORT        = process.env.PORT || 3000;

// Path to your compiled minishell binary.
// If it's in the same repo, build it first: make -C ..
// You can also set the SHELL_BIN environment variable to override.
const SHELL_BIN = process.env.SHELL_BIN || path.resolve(__dirname, "../../minishell");

// Fall back to /bin/bash if minishell binary not found (handy for development)
const SHELL_PATH  = fs.existsSync(SHELL_BIN) ? SHELL_BIN : "/bin/bash";

const PUBLIC_DIR  = path.resolve(__dirname, "../public");

if (!fs.existsSync(SHELL_BIN)) {
  console.warn(`[warn] minishell binary not found at ${SHELL_BIN}`);
  console.warn(`[warn] Falling back to ${SHELL_PATH}`);
  console.warn(`[warn] Run: make -C .. to build first`);
}

// ── MIME types for static file serving ────────────────────────────────────────

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript",
  ".css":  "text/css",
  ".ico":  "image/x-icon",
  ".png":  "image/png",
  ".svg":  "image/svg+xml",
  ".woff2":"font/woff2",
};

// ── HTTP server (serves public/) ──────────────────────────────────────────────

const httpServer = http.createServer((req, res) => {
  // Normalise URL to prevent directory traversal
  let urlPath = req.url.split("?")[0];
  if (urlPath === "/" || urlPath === "") urlPath = "/index.html";

  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));

  // Ensure the resolved path stays inside PUBLIC_DIR
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === "ENOENT" ? 404 : 500);
      res.end(err.code === "ENOENT" ? "Not found" : "Server error");
      return;
    }
    const ext  = path.extname(filePath);
    const mime = MIME[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  });
});

// ── WebSocket server ───────────────────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true });

// Upgrade HTTP → WebSocket only on /terminal
httpServer.on("upgrade", (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://localhost`);
  if (pathname === "/terminal") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

// ── PTY + WebSocket wiring ─────────────────────────────────────────────────────

wss.on("connection", (ws) => {
  console.log("[ws] client connected — spawning shell");

  // Spawn the shell inside a PTY.
  // node-pty.spawn(file, args, options)
  //   cols/rows: initial terminal dimensions (browser will resize-sync these)
  //   env:       pass through the current process environment so PATH etc. work
  const shellEnv = {
    ...process.env,
    // Ensure PATH is set for execvp() to find external commands
    PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  };
  const shell = pty.spawn(SHELL_PATH, [], {
    name: "xterm-256color",   // $TERM — tells the shell it can use colours
    cols: 120,
    rows: 36,
    cwd:  os.homedir(),
    env:  shellEnv,
  });

  console.log(`[pty] spawned pid ${shell.pid} → ${SHELL_PATH}`);

  // PTY → WebSocket: forward every byte the shell writes to the browser.
  // The data is a string (node-pty decodes it with the PTY's encoding).
  // We send it as-is; xterm.js on the browser side understands ANSI sequences.
  shell.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "output", data }));
    }
  });

  // Shell exited (user typed `exit`, shell crashed, etc.)
  shell.onExit(({ exitCode, signal }) => {
    console.log(`[pty] pid ${shell.pid} exited (code=${exitCode} signal=${signal})`);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "exit", code: exitCode ?? signal }));
      ws.close();
    }
  });

  // WebSocket → PTY: the browser sends JSON messages.
  // Two message types:
  //   { type: "input",  data: "<keystrokes string>" }
  //   { type: "resize", cols: N, rows: M }
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.warn("[ws] non-JSON message, ignoring");
      return;
    }

    if (msg.type === "input") {
      // Write keystrokes directly into the PTY.
      // The PTY's line discipline handles echoing, Ctrl-C translation, etc.
      shell.write(msg.data);

    } else if (msg.type === "resize") {
      // Resize the PTY to match the browser window.
      // Without this, line-wrapping and cursor positioning break on resize.
      const cols = Math.max(1, Math.min(500, msg.cols | 0));
      const rows = Math.max(1, Math.min(200, msg.rows | 0));
      shell.resize(cols, rows);

    } else {
      console.warn("[ws] unknown message type:", msg.type);
    }
  });

  // Client disconnected: kill the shell so it doesn't linger
  ws.on("close", () => {
    console.log(`[ws] client disconnected — killing pid ${shell.pid}`);
    try { shell.kill(); } catch { /* already gone */ }
  });

  ws.on("error", (err) => {
    console.error("[ws] error:", err.message);
    try { shell.kill(); } catch { /* already gone */ }
  });
});

// ── Start ──────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`\n  minishell GUI`);
  console.log(`  ─────────────────────────────`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  shell: ${SHELL_PATH}`);
  console.log(`  public: ${PUBLIC_DIR}\n`);
});