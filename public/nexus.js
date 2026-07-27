(function () {
  "use strict";

  const coarse = window.matchMedia("(pointer: coarse)").matches;

  const term = new Terminal({
    cursorBlink: true,
    fontFamily: '"SF Mono", "JetBrains Mono", Menlo, Consolas, "Courier New", monospace, "Symbols Nerd Font Mono"',
    fontSize: coarse ? 14 : 15,
    lineHeight: 1.15,
    letterSpacing: 0,
    // Zellij keeps full mouse-tracking on for the whole session (see the
    // touch-scroll comment below), which makes xterm forward every plain
    // click/drag to Zellij instead of doing local selection -- its built-in
    // bypass is Option-click on macOS, but only once this option is set
    // (default false). Without it there was no key combo that could ever
    // force local selection.
    macOptionClickForcesSelection: true,
    theme: {
      background: "#080d18",
      foreground: "#e8f2fd",
      cursor: "#38bdf8",
      cursorAccent: "#080d18",
      selectionBackground: "#e8f2fd",
      selectionForeground: "#080d18",
      selectionInactiveBackground: "rgba(232,242,253,0.25)",
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
  // OSC 52 -> navigator.clipboard. Zellij owns mouse selection (its tracking
  // claims plain drags) and "copies" on release by emitting OSC 52 -- which
  // xterm silently ignores without this addon, so Zellij would report
  // "N chars sent to clipboard" while nothing ever landed in the real one.
  term.loadAddon(new ClipboardAddon.ClipboardAddon());

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

  // ── keyboard-aware height: iOS shrinks visualViewport for the soft
  // keyboard but does NOT shrink 100dvh (dvh only tracks browser chrome,
  // not the keyboard) -- so without this, the keyboard just overlays the
  // bottom of #app, burying #auxbar's ctrl/esc/arrow keys exactly when
  // they're needed mid-typing. Mirror the real visible height into a CSS
  // var every time it changes; #app's `var(--app-height, 100dvh)` picks it
  // up and the whole column (topbar/stage/auxbar) reflows to fit above the
  // keyboard, then scheduleFit() re-measures the now-correct #frame size.
  if (window.visualViewport) {
    const vv = window.visualViewport;
    function syncAppHeight() {
      document.documentElement.style.setProperty("--app-height", vv.height + "px");
      scheduleFit();
    }
    vv.addEventListener("resize", syncAppHeight);
    vv.addEventListener("scroll", syncAppHeight); // keyboard show/hide also shifts vv's offset without always firing resize
    syncAppHeight();
  }

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

  // ── touch scroll: replay drag as a real wheel event ─────────────────────
  // First attempt forwarded synthetic SGR mouse-wheel escape sequences
  // (button 64/65) straight to the pty, on the theory that real wheel
  // scroll must be reaching Zellij via mouse-report escapes. Wrong: the
  // vendored xterm.js's actual wheel handler branches on
  // `coreMouseService.areMouseEventsActive` (true here -- Zellij enables
  // full mouse tracking for the whole session) into *arrow-key* escapes
  // (ESC[A/ESC[B, or ESCOA/ESCOB under application-cursor-keys mode), not
  // SGR mouse buttons at all (confirmed by reading the shipped bundle).
  // Reimplementing that branching (plus every mode it depends on) ourselves
  // would be fragile and version-specific. Instead, replay the same input
  // xterm already handles correctly on desktop: dispatch a real synthetic
  // WheelEvent on .xterm-screen from touch-drag deltas and let xterm's
  // existing wheel handler do exactly what it does for a physical wheel.
  try {
    const termEl = document.getElementById("term");
    const scrollTrack = document.getElementById("scroll-track");
    const scrollThumb = document.getElementById("scroll-thumb");
    const DRAG_THRESHOLD = 6; // px of movement before a touch counts as a scroll drag, not a tap

    function dispatchWheel(deltaY, clientX, clientY) {
      const target = termEl.querySelector(".xterm-screen") || termEl;
      target.dispatchEvent(new WheelEvent("wheel", {
        deltaY: deltaY, deltaMode: 0, clientX: clientX, clientY: clientY,
        bubbles: true, cancelable: true,
      }));
    }

    let hideTimer = null;
    function showThumb(clientY) {
      if (!scrollTrack) return;
      scrollTrack.classList.add("show");
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => scrollTrack.classList.remove("show"), 900);
      if (scrollThumb && typeof clientY === "number") {
        const trackRect = scrollTrack.getBoundingClientRect();
        const thumbH = 32;
        let top = clientY - trackRect.top - thumbH / 2;
        top = Math.max(0, Math.min(trackRect.height - thumbH, top));
        scrollThumb.style.height = thumbH + "px";
        scrollThumb.style.top = top + "px";
      }
    }

    // Every touch-drag over #term used to become a scroll, unconditionally --
    // #term's `touch-action: none` (see style.css) hands the whole gesture to
    // us, so there was no native fallback and no way to select text by touch
    // at all. Fix: a held-still touch (LONG_PRESS_MS, no movement past
    // DRAG_THRESHOLD) now arms selection mode instead of scroll -- from then
    // on we replay the touch as synthetic mousedown/mousemove/mouseup on
    // .xterm-screen, the same trick already used for wheel scroll above, so
    // xterm's own real (mouse-driven) SelectionService does the actual work
    // instead of us reimplementing selection.
    const LONG_PRESS_MS = 400;

    function dispatchMouse(type, x, y, buttons) {
      const target = termEl.querySelector(".xterm-screen") || termEl;
      target.dispatchEvent(new MouseEvent(type, {
        clientX: x, clientY: y, button: 0, buttons: buttons,
        // Zellij's mouse-tracking otherwise swallows these as mouse-reports
        // instead of a local selection -- altKey satisfies the macOS bypass
        // (macOptionClickForcesSelection, set above), shiftKey satisfies the
        // non-Mac bypass, and touch has no real modifier keys to hold, so
        // both are forced on every synthetic event regardless of platform.
        altKey: true, shiftKey: true,
        bubbles: true, cancelable: true, composed: true,
      }));
    }

    // Not a proportional scrollbar -- Zellij's own scroll depth isn't
    // exposed to us over the wire, so the thumb is just a "you're
    // dragging, here" position cue, not a claim about scrollback depth.
    function bindDragScroll(el, allowSelect) {
      let active = false, dragging = false, selecting = false;
      let startX = 0, startY = 0, lastX = 0, lastY = 0, longPressTimer = null;
      el.addEventListener("touchstart", (e) => {
        if (e.touches.length !== 1) return;
        active = true;
        dragging = false;
        selecting = false;
        startX = lastX = e.touches[0].clientX;
        startY = lastY = e.touches[0].clientY;
        if (allowSelect) {
          const x = startX, y = startY;
          longPressTimer = setTimeout(() => {
            longPressTimer = null;
            selecting = true;
            dispatchMouse("mousedown", x, y, 1);
          }, LONG_PRESS_MS);
        }
      }, { passive: true });
      el.addEventListener("touchmove", (e) => {
        if (!active || e.touches.length !== 1) return;
        const t = e.touches[0];
        if (selecting) {
          e.preventDefault();
          lastX = t.clientX; lastY = t.clientY;
          dispatchMouse("mousemove", t.clientX, t.clientY, 1);
          return;
        }
        if (!dragging) {
          if (Math.abs(t.clientY - startY) < DRAG_THRESHOLD && Math.abs(t.clientX - startX) < DRAG_THRESHOLD) return;
          // crossed the tap/drag threshold before the long-press timer fired
          // -- this is a scroll, not a selection. Disarm the timer.
          if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
          dragging = true; // crossed the tap/drag threshold -- claim this gesture
        }
        e.preventDefault();
        const fingerDelta = t.clientY - lastY;
        lastX = t.clientX; lastY = t.clientY;
        // finger moves down -> reveal earlier content -> same sign as wheel-up
        dispatchWheel(-fingerDelta, t.clientX, t.clientY);
        showThumb(t.clientY);
      }, { passive: false });
      function release() {
        active = false;
        dragging = false;
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
        if (selecting) {
          selecting = false;
          dispatchMouse("mouseup", lastX, lastY, 0);
        }
      }
      el.addEventListener("touchend", release, { passive: true });
      el.addEventListener("touchcancel", release, { passive: true });
    }

    bindDragScroll(termEl, true);
    if (scrollTrack) bindDragScroll(scrollTrack, false);
  } catch (err) { console.error("[nexus] touch scroll setup failed:", err); }

  // Reassigned once the tab bar block below sets up; a no-op until then so
  // an activeTab message arriving before that point can't throw. Only ever
  // updates the highlight -- never sends a tab-switch, so a hard refresh or
  // reconnect can't itself change which tab is focused server-side.
  let syncActiveTab = () => {};

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
      if (typeof ev.data === "string" && ev.data.charCodeAt(0) === 0) {
        try {
          const msg = JSON.parse(ev.data.slice(1));
          if (msg.type === "activeTab") syncActiveTab(msg.name);
        } catch (_) {}
        return;
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
    const webframe = document.getElementById("webframe");
    const webview = document.getElementById("webview");

    // True while a web tab (claude.ai iframe) is showing instead of the
    // terminal. Kept as client-only state: the server has no idea this tab
    // exists (it isn't a Zellij tab), so we must not let a server-driven
    // activeTab sync yank the user off the web pane on reconnect.
    let webActive = false;
    let webLoaded = false;
    let webUrl = null;

    function highlightTab(btn) {
      tabs.forEach((t) => t.setAttribute("aria-selected", String(t === btn)));
      if (wakeBtn) wakeBtn.classList.toggle("hidden", btn.dataset.name !== "llm");
    }
    function selectTab(btn) {
      highlightTab(btn);
      if (btn.dataset.web) {
        // Web pane: swap the terminal card for the iframe. Load src lazily on
        // first open so the remote-browser stream doesn't start until used.
        webActive = true;
        document.body.classList.add("web-active");
        webUrl = btn.dataset.web;
        if (!webLoaded) { webview.src = webUrl; webLoaded = true; }
        frame.classList.add("hidden");
        webframe.classList.remove("hidden");
        return; // no Alt+digit, no term.focus -- this isn't a Zellij tab
      }
      webActive = false;
      document.body.classList.remove("web-active");
      webframe.classList.add("hidden");
      frame.classList.remove("hidden");
      sendInput("\x1b" + btn.dataset.tab); // Alt+<n> = ESC + digit
      term.focus();
      scheduleFit();
    }
    tabs.forEach((btn) => btn.addEventListener("click", () => selectTab(btn)));
    syncActiveTab = (name) => {
      // Ignore server tab-syncs while the user is on the web pane -- the
      // underlying Zellij tab is untouched and re-syncs when they pick a
      // terminal tab again.
      if (webActive) return;
      const btn = tabs.find((t) => t.dataset.name === name);
      if (btn) highlightTab(btn);
    };

    // ── web pane reload: reassigning src reloads the iframe, reconnecting the
    // Selkies stream -- the fix for a stuck/frozen claude.ai view. Can't call
    // contentWindow.reload() (cross-origin), so re-point src at the same URL. ─
    const webreload = document.getElementById("webreload");
    if (webreload) {
      webreload.addEventListener("click", () => {
        if (!webUrl) return;
        webview.src = webUrl; // same value still triggers a fresh load
        webreload.classList.remove("spinning");
        void webreload.offsetWidth; // reflow so the animation can retrigger
        webreload.classList.add("spinning");
      });
    }

    // ── keyboard tab switch: Option/Alt+1..5 ────────────────────────────────
    // Capture-phase on window so it fires before xterm's own key handler and
    // we can stop the keystroke from reaching the terminal (on macOS Option+
    // digit would otherwise type ¡™£¢∞; preventDefault below suppresses that).
    // Keyed off physical e.code (Digit1..Digit5) so it's layout-independent.
    // NOTE: while focus is inside the claude.ai iframe (cross-origin), its
    // keystrokes never reach this listener -- so this switches away from a
    // terminal tab reliably, but not from within the live claude.ai stream.
    window.addEventListener("keydown", (e) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const m = /^Digit([1-5])$/.exec(e.code);
      if (!m) return;
      const idx = parseInt(m[1], 10) - 1;
      if (idx < 0 || idx >= tabs.length) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      selectTab(tabs[idx]);
    }, true);

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
