(function () {
  "use strict";

  const coarse = window.matchMedia("(pointer: coarse)").matches;

  const term = new Terminal({
    cursorBlink: true,
    fontFamily: '"SF Mono", "JetBrains Mono", Menlo, Consolas, "Courier New", monospace, "Symbols Nerd Font Mono"',
    fontSize: coarse ? 14 : 15,
    lineHeight: 1.15,
    letterSpacing: 0,
    theme: {
      background: "#080d18",
      foreground: "#e8f2fd",
      cursor: "#38bdf8",
      cursorAccent: "#080d18",
      selectionBackground: "rgba(56,189,248,0.28)",
      black: "#05080f", red: "#fb7185", green: "#34d399", yellow: "#fbbf24",
      blue: "#38bdf8", magenta: "#a78bfa", cyan: "#6ee7ff", white: "#e8f2fd",
      brightBlack: "#3b4a63", brightRed: "#fda4af", brightGreen: "#6ee7b7",
      brightYellow: "#fde68a", brightBlue: "#7dd3fc", brightMagenta: "#c4b5fd",
      brightCyan: "#a5f3fc", brightWhite: "#ffffff",
    },
  });

  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon());

  const frame = document.getElementById("frame");
  const boot = document.getElementById("boot");
  const statusEl = document.getElementById("status");
  const statusLabel = statusEl.querySelector(".status-label");

  term.open(document.getElementById("term"));

  // xterm paints glyphs onto a canvas, which only honors fonts already loaded
  // at draw time — request the symbols font, then repaint once it resolves.
  if (document.fonts && document.fonts.load) {
    document.fonts.load('14px "Symbols Nerd Font Mono"').then(() => term.refresh(0, term.rows - 1)).catch(() => {});
  }

  // ── sizing: fit against the visible frame, push the new size to the pty ───
  // Debounced with setTimeout, not requestAnimationFrame: an rAF scheduled
  // while the tab is backgrounded (alt-tab, another window focused, etc.)
  // never fires until the tab is foregrounded again, which left the old
  // rAF-gated version permanently stuck -- the in-flight guard was cleared
  // only inside the rAF callback, so one resize event landing at the wrong
  // moment wedged `scheduleFit` into a no-op for the rest of the page's life
  // (matches the reported symptom exactly: correct once at load, frozen on
  // every resize after). setTimeout always eventually fires even throttled
  // in the background, so the guard can never get permanently stuck.
  let fitTimer = null;
  function scheduleFit() {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      fitTimer = null;
      if (frame.clientWidth > 0 && frame.clientHeight > 0) {
        try { fit.fit(); } catch (err) { console.error("[nexus] fit.fit() failed:", err); }
      }
    }, 60);
  }
  new ResizeObserver(scheduleFit).observe(frame);
  window.addEventListener("resize", scheduleFit);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", scheduleFit);

  // Belt-and-suspenders: poll the frame's own box size and re-fit if it
  // moved without a matching event ever reaching us (covers any other
  // resize-notification failure mode beyond the one above).
  let lastW = 0, lastH = 0;
  setInterval(() => {
    if (frame.clientWidth !== lastW || frame.clientHeight !== lastH) {
      lastW = frame.clientWidth;
      lastH = frame.clientHeight;
      scheduleFit();
    }
  }, 500);

  // ── connection state ──────────────────────────────────────────────────────
  let ws = null;
  let reconnectDelay = 1000;
  let reconnectTimer = null;
  let booted = false;

  function setStatus(state, label) {
    statusEl.dataset.state = state;
    statusLabel.textContent = label;
  }

  function sendResize() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send("\x00" + JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    }
  }
  term.onResize(sendResize);

  function connect(isReconnect) {
    if (isReconnect) term.reset();
    setStatus("connecting", isReconnect ? "reconnecting" : "connecting");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(proto + "//" + location.host + "/ws");

    ws.onopen = () => {
      reconnectDelay = 1000;
      setStatus("connected", "connected");
      scheduleFit();
      sendResize();
    };

    ws.onmessage = (ev) => {
      if (!booted) {
        booted = true;
        boot.classList.add("hidden");
      }
      term.write(typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data));
    };

    ws.onclose = () => {
      setStatus("reconnecting", "reconnecting");
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => connect(true), reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
    };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }

  function sendInput(data) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
  }

  // ── sticky ctrl: arms, then the next single keystroke becomes ctrl+key ────
  let ctrlArmed = false;
  const ctrlBtn = document.querySelector(".key-ctrl");
  function setCtrl(on) {
    ctrlArmed = on;
    ctrlBtn.setAttribute("aria-pressed", String(on));
  }

  term.onData((d) => {
    if (ctrlArmed && d.length === 1) {
      const c = d.charCodeAt(0);
      if (c >= 0x20 && c < 0x7f) d = String.fromCharCode(c & 0x1f); // a->\x01 … c->\x03
      setCtrl(false);
    }
    sendInput(d);
  });

  // ── tab bar → drive Zellij tabs via Alt+digit bytes (Phase 0, Path B) ─────
  // Wrapped defensively: this whole block sits between the resize/connect
  // setup above and the final connect() call below, so any DOM mismatch here
  // (e.g. markup/script version skew) must never throw past this block and
  // take out the rest of the script -- that's exactly the kind of single
  // point of failure that could silently disable everything after it.
  try {
    const tabs = Array.from(document.querySelectorAll(".tab"));
    const wakeBtn = document.getElementById("wake");
    const wakeLabel = wakeBtn && wakeBtn.querySelector(".wake-label");
    function selectTab(btn) {
      tabs.forEach((t) => t.setAttribute("aria-selected", String(t === btn)));
      if (wakeBtn) wakeBtn.classList.toggle("hidden", btn.dataset.name !== "llm");
      sendInput("\x1b" + btn.dataset.tab); // Alt+<n> = ESC + digit
      term.focus();
    }
    tabs.forEach((btn) => btn.addEventListener("click", () => selectTab(btn)));

    // ── wake button: fires the WoL magic packet for the llm tab's desktop ──
    if (wakeBtn) {
      let waking = false;
      wakeBtn.addEventListener("click", async () => {
        if (waking) return;
        waking = true;
        wakeLabel.textContent = "waking…";
        wakeBtn.classList.add("sent");
        try {
          await fetch("/api/wake", { method: "POST" });
        } catch (err) { console.error("[nexus] /api/wake failed:", err); }
        setTimeout(() => {
          wakeLabel.textContent = "wake";
          wakeBtn.classList.remove("sent");
          waking = false;
        }, 2000);
        term.focus();
      });
    }
  } catch (err) { console.error("[nexus] tab bar / wake button setup failed:", err); }

  // ── configure popover: one global font size for the whole app ────────────
  try {
    const FONT_MIN = 10, FONT_MAX = 24;
    let fontSize = term.options.fontSize;
    try {
      const saved = parseInt(localStorage.getItem("nexus-font-size"), 10);
      if (saved >= FONT_MIN && saved <= FONT_MAX) fontSize = saved;
    } catch (_) {}

    const configureBtn = document.getElementById("configure");
    const configurePanel = document.getElementById("configure-panel");
    const fontValue = document.getElementById("font-value");
    const fontDec = document.getElementById("font-dec");
    const fontInc = document.getElementById("font-inc");

    function applyFontSize(size) {
      fontSize = Math.max(FONT_MIN, Math.min(FONT_MAX, size));
      term.options.fontSize = fontSize;
      if (fontValue) fontValue.textContent = String(fontSize);
      try { localStorage.setItem("nexus-font-size", String(fontSize)); } catch (_) {}
      scheduleFit();
    }
    applyFontSize(fontSize);

    if (configureBtn && configurePanel) {
      configureBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const nowHidden = configurePanel.classList.toggle("hidden");
        configureBtn.setAttribute("aria-expanded", String(!nowHidden));
      });
      configurePanel.addEventListener("click", (e) => e.stopPropagation());
      document.addEventListener("click", () => {
        configurePanel.classList.add("hidden");
        configureBtn.setAttribute("aria-expanded", "false");
      });
    }
    if (fontDec) fontDec.addEventListener("click", () => applyFontSize(fontSize - 1));
    if (fontInc) fontInc.addEventListener("click", () => applyFontSize(fontSize + 1));
  } catch (err) { console.error("[nexus] configure panel setup failed:", err); }

  // ── cursor style + blink ──────────────────────────────────────────────────
  try {
    const CURSOR_STYLES = ["block", "underline", "bar"];
    const cursorStyleBtns = Array.from(document.querySelectorAll("#cursor-style-group .segctl-btn"));
    const cursorBlinkBtn = document.getElementById("cursor-blink-btn");

    let cursorStyle = localStorage.getItem("nexus-cursor-style");
    if (!CURSOR_STYLES.includes(cursorStyle)) cursorStyle = "block";
    let cursorBlink = localStorage.getItem("nexus-cursor-blink");
    cursorBlink = cursorBlink === null ? true : cursorBlink === "true";

    function applyCursorStyle(style) {
      cursorStyle = style;
      term.options.cursorStyle = style;
      cursorStyleBtns.forEach((btn) => {
        btn.setAttribute("aria-selected", String(btn.dataset.cursorStyle === style));
      });
      try { localStorage.setItem("nexus-cursor-style", style); } catch (_) {}
    }
    function applyCursorBlink(on) {
      cursorBlink = on;
      term.options.cursorBlink = on;
      if (cursorBlinkBtn) cursorBlinkBtn.setAttribute("aria-checked", String(on));
      try { localStorage.setItem("nexus-cursor-blink", String(on)); } catch (_) {}
    }
    applyCursorStyle(cursorStyle);
    applyCursorBlink(cursorBlink);

    cursorStyleBtns.forEach((btn) => {
      btn.addEventListener("click", () => applyCursorStyle(btn.dataset.cursorStyle));
    });
    if (cursorBlinkBtn) cursorBlinkBtn.addEventListener("click", () => applyCursorBlink(!cursorBlink));
  } catch (err) { console.error("[nexus] cursor style setup failed:", err); }

  // ── extra keys row (home/end/pgup/pgdn) -- off by default, mostly useful
  // on mobile where those keys don't exist ─────────────────────────────────
  try {
    const extraKeysToggle = document.getElementById("extra-keys-toggle");
    const auxExtra = document.getElementById("auxbar-extra");
    let extraKeysOn = localStorage.getItem("nexus-extra-keys") === "true";

    function applyExtraKeys(on) {
      extraKeysOn = on;
      if (auxExtra) auxExtra.classList.toggle("hidden", !on);
      if (extraKeysToggle) extraKeysToggle.setAttribute("aria-checked", String(on));
      try { localStorage.setItem("nexus-extra-keys", String(on)); } catch (_) {}
      scheduleFit(); // auxbar height can change, which changes #stage's available height
    }
    applyExtraKeys(extraKeysOn);
    if (extraKeysToggle) extraKeysToggle.addEventListener("click", () => applyExtraKeys(!extraKeysOn));
  } catch (err) { console.error("[nexus] extra keys setup failed:", err); }

  // ── copy on select ─────────────────────────────────────────────────────
  try {
    const copySelectToggle = document.getElementById("copy-select-toggle");
    let copyOnSelect = localStorage.getItem("nexus-copy-on-select");
    copyOnSelect = copyOnSelect === null ? true : copyOnSelect === "true";

    function applyCopyOnSelect(on) {
      copyOnSelect = on;
      if (copySelectToggle) copySelectToggle.setAttribute("aria-checked", String(on));
      try { localStorage.setItem("nexus-copy-on-select", String(on)); } catch (_) {}
    }
    applyCopyOnSelect(copyOnSelect);
    if (copySelectToggle) copySelectToggle.addEventListener("click", () => applyCopyOnSelect(!copyOnSelect));

    term.onSelectionChange(() => {
      if (!copyOnSelect) return;
      const sel = term.getSelection();
      if (sel && sel.length > 0 && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(sel).catch((err) => console.error("[nexus] copy-on-select failed:", err));
      }
    });
  } catch (err) { console.error("[nexus] copy-on-select setup failed:", err); }

  // ── scrollback length ──────────────────────────────────────────────────
  try {
    const scrollbackSelect = document.getElementById("scrollback-select");
    const SCROLLBACK_DEFAULT = 1000;
    let scrollback = parseInt(localStorage.getItem("nexus-scrollback"), 10);
    if (!Number.isFinite(scrollback) || scrollback <= 0) scrollback = SCROLLBACK_DEFAULT;
    term.options.scrollback = scrollback;
    if (scrollbackSelect) {
      scrollbackSelect.value = String(scrollback);
      scrollbackSelect.addEventListener("change", () => {
        const v = parseInt(scrollbackSelect.value, 10);
        if (Number.isFinite(v) && v > 0) {
          term.options.scrollback = v;
          try { localStorage.setItem("nexus-scrollback", String(v)); } catch (_) {}
        }
      });
    }
  } catch (err) { console.error("[nexus] scrollback setup failed:", err); }

  // ── logout: ends the Authentik outpost session only -- the Zellij session
  // and every pane's process live entirely server-side, decoupled from the
  // browser's auth cookie, so this never touches the terminals themselves ──
  try {
    const logoutBtn = document.getElementById("logout");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", () => {
        location.href = "/outpost.goauthentik.io/sign_out";
      });
    }
  } catch (err) { console.error("[nexus] logout button setup failed:", err); }

  // ── aux keys ──────────────────────────────────────────────────────────────
  const AUX = {
    esc: "\x1b", tab: "\t",
    up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D",
    home: "\x1b[1~", end: "\x1b[4~", pgup: "\x1b[5~", pgdn: "\x1b[6~",
  };
  document.querySelectorAll("#auxbar .key").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const k = btn.dataset.key;
      if (k === "ctrl") { setCtrl(!ctrlArmed); term.focus(); return; }
      if (AUX[k]) { sendInput(AUX[k]); if (ctrlArmed) setCtrl(false); }
      term.focus();
      e.preventDefault();
    });
  });

  scheduleFit();
  connect(false);
})();
