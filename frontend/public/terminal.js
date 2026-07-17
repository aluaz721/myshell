/**
 * terminal.js — multi-tab terminal manager
 *
 * Each tab owns:
 *   - an xterm.js Terminal instance  (renders to its own <div>)
 *   - a FitAddon                     (handles resize for that terminal)
 *   - a WebSocket                    (its own connection to the server)
 *   - a <div> tab button in the tabbar
 *   - a <div> terminal surface in #terminal-container
 *
 * Switching tabs just swaps which surface is visible and which
 * terminal has focus — no teardown/rebuild needed.
 */

"use strict";

// ── Shared xterm theme (same for every tab) ────────────────────────────────────

const THEME = {
  background:          "#0d1117",
  foreground:          "#e6edf3",
  cursor:              "#58a6ff",
  cursorAccent:        "#0d1117",
  selectionBackground: "rgba(88,166,255,0.25)",
  black:         "#484f58", red:           "#ff7b72",
  green:         "#3fb950", yellow:        "#d29922",
  blue:          "#388bfd", magenta:       "#bc8cff",
  cyan:          "#39c5cf", white:         "#b1bac4",
  brightBlack:   "#6e7681", brightRed:     "#ffa198",
  brightGreen:   "#56d364", brightYellow:  "#e3b341",
  brightBlue:    "#79c0ff", brightMagenta: "#d2a8ff",
  brightCyan:    "#56d4dd", brightWhite:   "#f0f6fc",
};

const TERM_OPTIONS = {
  fontFamily:   '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
  fontSize:     14,
  lineHeight:   1.25,
  cursorBlink:  true,
  cursorStyle:  "block",
  scrollback:   5000,
  allowProposedApi: true,
  theme: THEME,
};

// ── State ──────────────────────────────────────────────────────────────────────

// sessions: Map<id, Session>
// Session = {
//   id:          number,
//   term:        Terminal,
//   fitAddon:    FitAddon,
//   ws:          WebSocket | null,
//   tabEl:       HTMLElement,    ← the <div class="tab"> button
//   surfaceEl:   HTMLElement,    ← the <div> xterm renders into
//   reconnTimer: number | null,  ← setTimeout handle
// }
const sessions = new Map();
let   nextId   = 1;
let   activeId = null;  // which tab is currently visible

// ── DOM refs ───────────────────────────────────────────────────────────────────

const tabbar        = document.getElementById("tabbar");
const btnNewTab     = document.getElementById("btn-new-tab");
const termContainer = document.getElementById("terminal-container");
const statusDot     = document.getElementById("status-dot");
const statusLabel   = document.getElementById("status-label");
const sbSize        = document.getElementById("sb-size");

// ── Status helpers (reflect the *active* tab's connection state) ───────────────

function setStatus(state, label) {
  statusDot.className     = "status-dot " + state;
  statusDot.title         = label;
  statusLabel.textContent = label;
}

function updateSizeDisplay(session) {
  sbSize.textContent = `${session.term.cols}×${session.term.rows}`;
}

// ── Create a new session ───────────────────────────────────────────────────────

function createSession() {
  const id = nextId++;

  // 1. Terminal surface div — xterm renders its canvas into this
  const surfaceEl = document.createElement("div");
  surfaceEl.className     = "terminal-surface";
  surfaceEl.style.display = "none";   // hidden until this tab is activated
  termContainer.appendChild(surfaceEl);

  // 2. xterm.js Terminal + addons
  const term       = new Terminal(TERM_OPTIONS);
  const fitAddon   = new FitAddon.FitAddon();
  const linksAddon = new WebLinksAddon.WebLinksAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(linksAddon);
  term.open(surfaceEl);   // attaches canvas to surfaceEl (even while hidden)

  // 3. Tab button in the tabbar
  const tabEl = document.createElement("div");
  tabEl.className  = "tab";
  tabEl.dataset.id = id;
  tabEl.innerHTML  = `
    <span class="tab-icon">⬡</span>
    <span class="tab-title">minishell</span>
    <span class="tab-close" role="button" aria-label="Close tab">×</span>
  `;
  // Insert before the "+" button
  tabbar.insertBefore(tabEl, btnNewTab);

  // 4. Assemble the session object
  const session = { id, term, fitAddon, ws: null, tabEl, surfaceEl, reconnTimer: null };
  sessions.set(id, session);

  // 5. Wire tab click → switch; close button → destroy
  tabEl.addEventListener("click", (e) => {
    if (e.target.classList.contains("tab-close")) {
      destroySession(id);
    } else {
      activateSession(id);
    }
  });

  // 6. Forward keystrokes to the server
  term.onData((data) => {
    const s = sessions.get(id);
    if (s && s.ws && s.ws.readyState === WebSocket.OPEN) {
      s.ws.send(JSON.stringify({ type: "input", data }));
    }
  });

  // 7. Open the WebSocket — this spawns a shell process on the server
  connectSession(session);

  return session;
}

// ── WebSocket connection for one session ───────────────────────────────────────

function connectSession(session) {
  clearTimeout(session.reconnTimer);

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws    = new WebSocket(`${proto}://${location.host}/terminal`);
  session.ws  = ws;

  if (session.id === activeId) setStatus("connecting", "connecting…");

  ws.addEventListener("open", () => {
    if (session.id === activeId) setStatus("connected", "connected");
    sendResize(session);
  });

  ws.addEventListener("message", (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === "output") {
      session.term.write(msg.data);
    } else if (msg.type === "exit") {
      if (session.id === activeId)
        setStatus("disconnected", `exited (${msg.code})`);
      showExitOverlay(session, msg.code);
    }
  });

  ws.addEventListener("close", (event) => {
    if (event.code !== 1000) {
      if (session.id === activeId) setStatus("connecting", "reconnecting…");
      session.reconnTimer = setTimeout(() => connectSession(session), 3000);
    } else {
      if (session.id === activeId) setStatus("disconnected", "disconnected");
    }
  });

  ws.addEventListener("error", () => {
    if (session.id === activeId) setStatus("disconnected", "connection error");
  });
}

// ── Activate (switch to) a session ────────────────────────────────────────────

function activateSession(id) {
  const session = sessions.get(id);
  if (!session) return;

  // Hide all surfaces and deactivate all tab buttons
  for (const [, s] of sessions) {
    s.surfaceEl.style.display = "none";
    s.tabEl.classList.remove("active");
  }

  // Show this session's surface and mark its tab active
  session.surfaceEl.style.display = "block";
  session.tabEl.classList.add("active");
  activeId = id;

  // Re-fit after becoming visible — the canvas may not have been sized
  // correctly while it was hidden
  session.fitAddon.fit();
  sendResize(session);
  session.term.focus();

  // Reflect this tab's connection status in the status bar
  const wsState = session.ws ? session.ws.readyState : -1;
  if      (wsState === WebSocket.OPEN)       setStatus("connected",    "connected");
  else if (wsState === WebSocket.CONNECTING) setStatus("connecting",   "connecting…");
  else                                        setStatus("disconnected", "disconnected");

  updateSizeDisplay(session);
}

// ── Destroy a session ──────────────────────────────────────────────────────────

function destroySession(id) {
  const session = sessions.get(id);
  if (!session) return;

  // Close the WebSocket — server kills the PTY and shell on close
  clearTimeout(session.reconnTimer);
  if (session.ws) session.ws.close(1000, "tab closed");

  // Dispose xterm (frees canvas memory)
  session.term.dispose();

  // Remove DOM nodes
  session.tabEl.remove();
  session.surfaceEl.remove();

  sessions.delete(id);

  // If we just closed the active tab, switch to another one
  if (activeId === id) {
    activeId = null;
    const remaining = [...sessions.keys()];
    if (remaining.length > 0) {
      activateSession(remaining[remaining.length - 1]);
    } else {
      // No tabs left — open a fresh one automatically
      const s = createSession();
      activateSession(s.id);
    }
  }
}

// ── Resize ─────────────────────────────────────────────────────────────────────

function sendResize(session) {
  if (session.ws && session.ws.readyState === WebSocket.OPEN) {
    session.ws.send(JSON.stringify({
      type: "resize",
      cols: session.term.cols,
      rows: session.term.rows,
    }));
  }
  if (session.id === activeId) updateSizeDisplay(session);
}

const resizeObserver = new ResizeObserver(() => {
  if (activeId === null) return;
  const session = sessions.get(activeId);
  if (!session) return;
  session.fitAddon.fit();
  sendResize(session);
});
resizeObserver.observe(termContainer);

// ── Toolbar buttons ────────────────────────────────────────────────────────────

btnNewTab.addEventListener("click", () => {
  const s = createSession();
  activateSession(s.id);
});

document.getElementById("btn-clear").addEventListener("click", () => {
  if (activeId === null) return;
  const session = sessions.get(activeId);
  if (session && session.ws && session.ws.readyState === WebSocket.OPEN) {
    session.ws.send(JSON.stringify({ type: "input", data: "\x0c" }));
  }
});

document.getElementById("btn-reconnect").addEventListener("click", () => {
  if (activeId === null) return;
  const session = sessions.get(activeId);
  if (session) {
    if (session.ws) session.ws.close();
    connectSession(session);
  }
});

document.getElementById("btn-close").addEventListener("click", () => {
  if (activeId !== null) destroySession(activeId);
});

// ── Exit overlay ───────────────────────────────────────────────────────────────

function showExitOverlay(session, code) {
  session.surfaceEl.querySelectorAll(".exit-overlay").forEach(el => el.remove());

  const overlay = document.createElement("div");
  overlay.className = "exit-overlay";

  const p   = document.createElement("p");
  p.textContent = `Shell exited with code ${code}.`;

  const btn = document.createElement("button");
  btn.textContent = "Restart shell";
  btn.addEventListener("click", () => {
    overlay.remove();
    session.term.clear();
    connectSession(session);
  });

  overlay.appendChild(p);
  overlay.appendChild(btn);
  session.surfaceEl.style.position = "relative";
  session.surfaceEl.appendChild(overlay);
}

// ── Boot: open the first session ──────────────────────────────────────────────

const first = createSession();
activateSession(first.id);