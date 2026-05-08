/**
 * terminal.js — frontend wiring
 *
 * Responsibilities:
 *   1. Create an xterm.js Terminal instance and attach it to the DOM
 *   2. Load xterm addons (FitAddon for resize, WebLinksAddon for URLs)
 *   3. Open a WebSocket to the server's /terminal endpoint
 *   4. Bridge: xterm input → WebSocket → server → PTY → shell
 *              shell → PTY → server → WebSocket → xterm output
 *   5. Send resize events so the PTY always matches the browser window
 *   6. Handle reconnect, status indicators, toolbar buttons
 */

"use strict";

// ── 1. Create the xterm.js Terminal ───────────────────────────────────────────
//
// Terminal(options) — full option list at:
//   https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/
//
const term = new Terminal({
  // Font — use a monospace stack so glyphs align correctly
  fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", "Menlo", monospace',
  fontSize:   14,
  lineHeight: 1.25,
  letterSpacing: 0,

  // Cursor
  cursorBlink: true,
  cursorStyle: "block",

  // Scrollback: how many lines to keep above the viewport
  scrollback: 5000,

  // Allow the terminal to use the clipboard (Ctrl+Shift+C/V)
  allowProposedApi: true,

  // Colour theme — must match --term-bg in style.css
  theme: {
    background:   "#0d1117",
    foreground:   "#e6edf3",
    cursor:       "#58a6ff",
    cursorAccent: "#0d1117",
    selectionBackground: "rgba(88,166,255,0.25)",

    // Standard 16 ANSI colours
    black:         "#484f58",
    red:           "#ff7b72",
    green:         "#3fb950",
    yellow:        "#d29922",
    blue:          "#388bfd",
    magenta:       "#bc8cff",
    cyan:          "#39c5cf",
    white:         "#b1bac4",
    brightBlack:   "#6e7681",
    brightRed:     "#ffa198",
    brightGreen:   "#56d364",
    brightYellow:  "#e3b341",
    brightBlue:    "#79c0ff",
    brightMagenta: "#d2a8ff",
    brightCyan:    "#56d4dd",
    brightWhite:   "#f0f6fc",
  },
});

// ── 2. Load addons ─────────────────────────────────────────────────────────────
//
// Addons extend xterm with extra functionality.  They must be loaded before
// the terminal is opened (before term.open()).

const fitAddon      = new FitAddon.FitAddon();
const webLinksAddon = new WebLinksAddon.WebLinksAddon();

term.loadAddon(fitAddon);
term.loadAddon(webLinksAddon);

// ── 3. Mount xterm into the DOM ────────────────────────────────────────────────
//
// term.open(element) injects a <canvas> (the terminal surface) and a
// transparent <textarea> (keyboard input target) into `element`.

const container = document.getElementById("terminal-container");
term.open(container);

// FitAddon.fit() resizes the xterm canvas to fill the container exactly.
// Call once on mount, then again on every window resize.
fitAddon.fit();

// ── Helpers ────────────────────────────────────────────────────────────────────

const statusDot   = document.getElementById("status-dot");
const statusLabel = document.getElementById("status-label");
const sbPid       = document.getElementById("sb-pid");
const sbSize      = document.getElementById("sb-size");

function setStatus(state, label) {
  statusDot.className   = "status-dot " + state;
  statusDot.title       = label;
  statusLabel.textContent = label;
}

function updateSizeDisplay() {
  sbSize.textContent = `${term.cols}×${term.rows}`;
}

// ── 4. WebSocket connection ────────────────────────────────────────────────────

let ws;             // the active WebSocket (may be replaced on reconnect)
let reconnectTimer; // setTimeout handle for auto-reconnect

function connect() {
  // Use ws:// or wss:// depending on whether the page is served over HTTPS
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url   = `${proto}://${location.host}/terminal`;

  clearTimeout(reconnectTimer);
  setStatus("connecting", "connecting…");

  ws = new WebSocket(url);

  // ── Connection opened ──────────────────────────────────────────────────────
  ws.addEventListener("open", () => {
    setStatus("connected", "connected");

    // After opening, sync the PTY size to the current terminal dimensions.
    // (The server defaults to 120×36; the browser window may differ.)
    sendResize();
  });

  // ── Message from server ────────────────────────────────────────────────────
  //
  // The server sends two kinds of JSON messages:
  //   { type: "output", data: "<string>" }  — raw terminal bytes from the shell
  //   { type: "exit",   code: N }           — shell process exited
  //
  ws.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      // Shouldn't happen, but be defensive
      console.warn("non-JSON message from server:", event.data);
      return;
    }

    if (msg.type === "output") {
      // Write shell output to the terminal.
      // xterm.js handles all ANSI escape sequences (colours, cursor, etc.)
      term.write(msg.data);

    } else if (msg.type === "exit") {
      setStatus("disconnected", `exited (${msg.code})`);
      showExitOverlay(msg.code);
    }
  });

  // ── Connection closed ──────────────────────────────────────────────────────
  ws.addEventListener("close", (event) => {
    // code 1000 = normal closure (shell exited cleanly); don't auto-reconnect
    if (event.code !== 1000) {
      setStatus("connecting", "reconnecting…");
      reconnectTimer = setTimeout(connect, 3000);
    } else {
      setStatus("disconnected", "disconnected");
    }
  });

  // ── Connection error ───────────────────────────────────────────────────────
  ws.addEventListener("error", () => {
    setStatus("disconnected", "connection error");
    // The "close" event fires after "error", so reconnect is handled there.
  });
}

// ── 5. Input: xterm → WebSocket ───────────────────────────────────────────────
//
// term.onData fires whenever the user types into the terminal.
// `data` is a string: single characters for normal keys, multi-char escape
// sequences for arrows/function keys/Ctrl combos.
//
// We forward it as-is to the server, which writes it into the PTY.
// The PTY's line discipline handles echoing and Ctrl-C/D/Z translation.

term.onData((data) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "input", data }));
  }
});

// ── 6. Resize: keep PTY in sync with browser window ───────────────────────────
//
// When the browser window changes size:
//   a. Re-fit xterm to its container  →  updates term.cols and term.rows
//   b. Send the new dimensions to the server  →  server calls pty.resize()
//
// If you skip this, the shell thinks the terminal is still 120×36 wide and
// output will wrap/truncate at the wrong column.

function sendResize() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    updateSizeDisplay();
  }
}

const resizeObserver = new ResizeObserver(() => {
  fitAddon.fit();
  sendResize();
});
resizeObserver.observe(container);

// Fallback for browsers without ResizeObserver (shouldn't be needed in 2025)
window.addEventListener("resize", () => {
  fitAddon.fit();
  sendResize();
});

// ── Toolbar buttons ────────────────────────────────────────────────────────────

// Clear: send Ctrl+L to the shell (shell clears its own screen)
document.getElementById("btn-clear").addEventListener("click", () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "input", data: "\x0c" })); // \x0c = Ctrl+L
  }
});

// Reconnect button: close current socket and open a fresh one
document.getElementById("btn-reconnect").addEventListener("click", () => {
  if (ws) ws.close();
  connect();
});

// Traffic-light close: close the WebSocket (shell exits when its PTY closes)
document.getElementById("btn-close").addEventListener("click", () => {
  if (ws) ws.close(1000, "user closed");
  setStatus("disconnected", "closed");
});

// New tab button: open a fresh page in a new browser tab
// (each browser tab gets its own WebSocket → its own PTY → its own shell)
document.getElementById("btn-new-tab").addEventListener("click", () => {
  window.open(location.href, "_blank");
});

// ── Exit overlay ───────────────────────────────────────────────────────────────
//
// Shown when the shell process exits (user typed `exit`, or the shell crashed).
// Lets the user reconnect without refreshing the page.

function showExitOverlay(code) {
  // Remove any existing overlay first
  document.querySelector(".exit-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "exit-overlay";

  const p = document.createElement("p");
  p.textContent = `Shell exited with code ${code}.`;

  const btn = document.createElement("button");
  btn.textContent = "Restart shell";
  btn.addEventListener("click", () => {
    overlay.remove();
    term.clear();
    connect();
  });

  overlay.appendChild(p);
  overlay.appendChild(btn);

  // Insert relative to the terminal wrapper
  container.style.position = "relative";
  container.appendChild(overlay);
}

// ── Kick off ───────────────────────────────────────────────────────────────────

connect();
updateSizeDisplay();
term.focus();