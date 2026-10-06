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
    // Tokyo Night (night). Keep selection/background in step with the Zellij
    // theme in zellij/config.kdl -- Zellij draws its own mouse selection
    // (text_selected); this selectionBackground covers Option-drag selection.
    theme: {
      background: "#1a1b26",
      foreground: "#c0caf5",
      cursor: "#c0caf5",
      cursorAccent: "#1a1b26",
      selectionBackground: "#364a82",
      selectionForeground: "#c0caf5",
      selectionInactiveBackground: "#2e3c64",
      black: "#15161e", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68",
      blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6",
      brightBlack: "#414868", brightRed: "#ff899d", brightGreen: "#9fe044",
      brightYellow: "#faba4a", brightBlue: "#8db0ff", brightMagenta: "#c7a9ff",
      brightCyan: "#a4daff", brightWhite: "#c0caf5",
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
  // bottom of #app, burying the bottom of the terminal exactly when it's
  // needed mid-typing. Mirror the real visible height into a CSS
  // var every time it changes; #app's `var(--app-height, 100dvh)` picks it
  // up and the whole column (topbar/stage) reflows to fit above the
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
  let lastRx = 0; // time of the last frame of any kind from the server

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
    const sock = new WebSocket(proto + "//" + location.host + "/ws");
    ws = sock;
    // Every handler ignores events from a socket that has been replaced, so
    // a late close from an abandoned socket can't schedule a second connect.
    sock.onopen = () => {
      if (ws !== sock) return;
      lastRx = Date.now();
      reconnectDelay = 1000;
      setStatus("connected", "connected");
      scheduleFit();
      sendResize();
    };

    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      lastRx = Date.now();
      if (!booted) {
        booted = true;
        boot.classList.add("hidden");
      }
      if (typeof ev.data === "string" && ev.data.charCodeAt(0) === 0) {
        try {
          const msg = JSON.parse(ev.data.slice(1));
          if (msg.type === "pong") return;
          if (msg.type === "activeTab") {
            syncActiveTab(msg.name);
            setStatus("connected", "connected");
          }
          if (msg.type === "toolError") setStatus("error", msg.message);
        } catch (_) {}
        return;
      }
      term.write(typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data));
    };

    sock.onclose = () => {
      if (ws !== sock) return;
      setStatus("reconnecting", "reconnecting");
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => connect(true), reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
    };
    sock.onerror = () => { try { sock.close(); } catch (_) {} };
  }

  // Drop the current socket (even one the browser still thinks is open) and
  // connect again right away, skipping the backoff.
  function forceReconnect() {
    const old = ws;
    ws = null;
    if (old) { try { old.close(); } catch (_) {} }
    clearTimeout(reconnectTimer);
    reconnectDelay = 1000;
    connect(true);
  }

  // ── liveness: a socket can be dead without the browser noticing for
  // minutes (device slept, Wi-Fi/VPN/cell switch), leaving a prompt that
  // looks alive but swallows keystrokes. Ping while visible; the server
  // answers with a pong, so silence past LIVENESS_MS means the link is dead. ─
  const PING_MS = 10000;
  const LIVENESS_MS = 30000;
  function ping() {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send("\x00" + JSON.stringify({ type: "ping" }));
  }
  setInterval(() => {
    if (document.hidden || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastRx > LIVENESS_MS) { forceReconnect(); return; }
    ping();
  }, PING_MS);

  // On wake / network change / return from bfcache: don't wait for the next
  // interval -- probe now and reconnect if no reply comes back within 3s.
  function checkNow() {
    if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
      forceReconnect();
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return; // still connecting
    const sent = Date.now();
    ping();
    setTimeout(() => { if (lastRx < sent) forceReconnect(); }, 3000);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checkNow(); });
  window.addEventListener("online", checkNow);
  window.addEventListener("pageshow", (e) => { if (e.persisted) checkNow(); });

  function sendInput(data) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
  }

  // ── image paste/drop → upload to the host inbox, type the path ───────────
  // Cmd+V a screenshot (or drag an image file onto the page) and it uploads
  // to /api/upload, which writes it into the claude-helper inbox bind-mount;
  // the resulting path is then typed into the focused pane so whatever's
  // running there (usually claude) can open it immediately. Text paste is
  // untouched -- this only claims the event when an image file is present.
  try {
    const INBOX_HOST = "/mnt/user/appdata/claude-helper/inbox/";

    function inboxPrefix() {
      const active = document.querySelector('.tab[aria-selected="true"]');
      // The claude tab lives inside the claude-helper container, where the
      // host filesystem is mounted at /host; every other tab is a host-side
      // shell (or close enough) that sees the native path.
      return (active && active.dataset.name === "claude") ? "/host" + INBOX_HOST : INBOX_HOST;
    }

    // Transient feedback pill -- uploads used to fail silently (console only),
    // which made "I pasted and nothing happened" undiagnosable from the UI.
    let toastEl = null, toastTimer = null;
    function toast(msg, ok) {
      if (!toastEl) {
        toastEl = document.createElement("div");
        toastEl.className = "toast";
        document.body.appendChild(toastEl);
      }
      toastEl.textContent = msg;
      toastEl.classList.toggle("err", !ok);
      toastEl.classList.add("show");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2600);
    }

    // macOS screenshots (and some apps) can land in the clipboard as
    // image/tiff or other formats the server rejects -- re-encode anything
    // that isn't already an accepted type to PNG via canvas.
    async function toPngBlob(file) {
      if (/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return file;
      const bmp = await createImageBitmap(file);
      const canvas = document.createElement("canvas");
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      canvas.getContext("2d").drawImage(bmp, 0, 0);
      bmp.close();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("could not convert " + (file.type || "unknown type") + " to png");
      return blob;
    }

    async function uploadImage(file) {
      const body = await toPngBlob(file);
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: { "content-type": body.type || "image/png" },
        body: body,
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw new Error(j.error || ("upload failed: " + res.status));
      sendInput(inboxPrefix() + j.file + " ");
      term.focus();
      toast("image uploaded → " + j.file, true);
    }

    function reportUploadError(err) {
      console.error("[nexus] image upload failed:", err);
      toast("image upload failed: " + (err && err.message ? err.message : err), false);
    }

    function imageFromDataTransfer(dt) {
      if (!dt) return null;
      for (const item of dt.items || []) {
        if (item.kind === "file" && item.type.startsWith("image/")) return item.getAsFile();
      }
      return null;
    }

    window.addEventListener("paste", (e) => {
      if (document.body.classList.contains("web-active")) return; // claude.ai iframe owns its own paste
      const dt = e.clipboardData;
      const file = imageFromDataTransfer(dt);
      if (!file) {
        // Plain text: stay silent, xterm's normal paste path owns it. Anything
        // else is a failed image-paste attempt -- say so, with what we saw,
        // instead of doing nothing (undiagnosable from the UI otherwise).
        const types = dt ? Array.from(dt.items || []).map((i) => i.kind + ":" + i.type) : [];
        if (types.some((t) => t.startsWith("string:text/"))) return;
        toast(types.length ? "no image in paste (got " + types.join(", ") + ")" : "clipboard is empty (screenshot to clipboard is ⌘⌃⇧ 4)", false);
        return;
      }
      e.preventDefault();
      uploadImage(file).catch(reportUploadError);
    });

    window.addEventListener("dragover", (e) => {
      if (document.body.classList.contains("web-active")) return;
      if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) e.preventDefault();
    });
    window.addEventListener("drop", (e) => {
      if (document.body.classList.contains("web-active")) return;
      const file = imageFromDataTransfer(e.dataTransfer);
      if (!file) return;
      e.preventDefault();
      uploadImage(file).catch(reportUploadError);
    });
  } catch (err) { console.error("[nexus] image inbox setup failed:", err); }

  term.onData((d) => sendInput(d));

  // ── tab bar → select tools by name, restoring missing tabs server-side ──
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
    const webviewTpl = document.getElementById("webview-tpl");
    const webpop = document.getElementById("webpop");

    // True while a web tab (claude.ai / chatgpt iframe) is showing instead of the
    // terminal. Kept as client-only state: the server has no idea this tab
    // exists (it isn't a Zellij tab), so we must not let a server-driven
    // activeTab sync yank the user off the web pane on reconnect.
    let webActive = false;
    let webUrl = null;
    let webview = null;          // the visible web tab's iframe
    const webviews = new Map();  // tab name -> its iframe, created on first select

    function showWebview(btn) {
      let el = webviews.get(btn.dataset.name);
      if (!el) {
        el = webviewTpl.content.firstElementChild.cloneNode(true);
        el.title = btn.querySelector(".tab-label").textContent;
        el.src = btn.dataset.web;
        webframe.appendChild(el);
        webviews.set(btn.dataset.name, el);
      }
      webviews.forEach((v) => v.classList.toggle("hidden", v !== el));
      webview = el;
      webUrl = btn.dataset.web;
      webframe.setAttribute("aria-label", el.title);
      if (webpop) webpop.href = webUrl;
    }

    function highlightTab(btn) {
      tabs.forEach((t) => t.setAttribute("aria-selected", String(t === btn)));
      if (wakeBtn) wakeBtn.classList.toggle("hidden", btn.dataset.name !== "llm");
    }
    function selectTab(btn) {
      if (btn.dataset.web) {
        highlightTab(btn);
        // Web pane: swap the terminal card for this tab's iframe. Each iframe
        // is created on first open (so its remote-browser stream doesn't start
        // until used) and kept alive while hidden.
        webActive = true;
        document.body.classList.add("web-active");
        showWebview(btn);
        frame.classList.add("hidden");
        webframe.classList.remove("hidden");
        return; // this isn't a Zellij tab
      }
      webActive = false;
      document.body.classList.remove("web-active");
      webframe.classList.add("hidden");
      frame.classList.remove("hidden");
      sendInput("\x00" + JSON.stringify({ type: "selectTool", name: btn.dataset.name }));
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
        if (!webview) return;
        webview.src = webUrl; // same value still triggers a fresh load
        webreload.classList.remove("spinning");
        void webreload.offsetWidth; // reflow so the animation can retrigger
        webreload.classList.add("spinning");
      });
    }

    // ── keyboard tab switch: Option/Alt+1..9 ────────────────────────────────
    // Capture-phase on window so it fires before xterm's own key handler and
    // we can stop the keystroke from reaching the terminal (on macOS Option+
    // digit would otherwise type ¡™£¢∞; preventDefault below suppresses that).
    // Keyed off physical e.code (Digit1..Digit9) so it's layout-independent.
    // NOTE: while focus is inside the claude.ai iframe (cross-origin), its
    // keystrokes never reach this listener -- so this switches away from a
    // terminal tab reliably, but not from within the live claude.ai stream.
    window.addEventListener("keydown", (e) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const m = /^Digit([1-9])$/.exec(e.code);
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

  // ── Recover buttons (configure menu): fix one stuck piece at a time ──────
  try {
    const hint = document.getElementById("rec-tab-hint");
    const current = () => document.querySelector('.tab[aria-selected="true"]');
    const label = (btn) => btn ? btn.querySelector(".tab-label").textContent : "current tab";
    document.getElementById("configure").addEventListener("click", () => {
      if (hint) hint.textContent = label(current());
    });

    let pill = null, pillTimer = null;
    function notify(msg, ok) {
      if (!pill) {
        pill = document.createElement("div");
        pill.className = "toast";
        document.body.appendChild(pill);
      }
      pill.textContent = msg;
      pill.classList.toggle("err", !ok);
      pill.classList.add("show");
      clearTimeout(pillTimer);
      pillTimer = setTimeout(() => pill.classList.remove("show"), 3500);
    }
    async function recover(body) {
      const res = await fetch("/api/recover", {
        method: "POST",
        headers: { "content-type": "application/json", "x-nexus-recover": "1" },
        body: JSON.stringify(body),
      });
      const out = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
      if (!out.ok) throw new Error(out.error || `HTTP ${res.status}`);
      return out.result;
    }
    const busy = new Set();
    function wire(id, fn) {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("click", async () => {
        if (busy.has(id)) return;
        busy.add(id);
        // Close the menu so the tab being recovered is visible.
        document.getElementById("configure-panel").classList.add("hidden");
        document.getElementById("configure").setAttribute("aria-expanded", "false");
        el.classList.add("busy");
        try { await fn(); } catch (err) { notify(`Recover failed: ${err.message}`, false); }
        finally { busy.delete(id); el.classList.remove("busy"); }
      });
    }

    wire("rec-reconnect", () => { forceReconnect(); notify("Reconnecting…", true); });
    wire("rec-reload", () => location.reload());
    wire("rec-bridge", async () => {
      if (!confirm("Restart the nexus web server?\n\nTerminal sessions keep running. Every open device reconnects in a few seconds.")) return;
      await recover({ action: "bridge" });
      notify("Bridge restarting — reconnecting…", true);
    });
    wire("rec-tab", async () => {
      const tab = current();
      if (!tab) return;
      const name = tab.dataset.name;
      if (tab.dataset.web) {
        if (!confirm(`Restart the ${label(tab)} browser?\n\nIts container restarts (~20 s). You stay logged in.`)) return;
        notify(`Restarting ${label(tab)} browser…`, true);
        await recover({ action: "browser", name });
        const reload = document.getElementById("webreload");
        if (reload) reload.click();
        notify(`${label(tab)} browser restarted`, true);
        return;
      }
      const warn = name === "claude"
        ? "This ends the running Claude Code session. Resume it afterwards with: claude --continue"
        : `Whatever is running in the ${label(tab)} tab is closed and the tab reconnects.`;
      if (!confirm(`Restart the ${label(tab)} tab?\n\n${warn}`)) return;
      const result = await recover({ action: "tool", name });
      notify(`${label(tab)}: ${result}`, true);
    });

    // ── Maintenance panel ──────────────────────────────────────────────────
    const maint = document.getElementById("maint");
    const mBody = document.getElementById("maint-body");
    const mSub = document.getElementById("maint-sub");
    const mKill = document.getElementById("maint-kill");
    const mRefresh = document.getElementById("maint-refresh");
    const TAB_ORDER = ["Claude Terminal", "Codex Terminal", "Antigravity Terminal", "OpenCode"];
    const CHIP = { nexus: ["chip-nexus", "nexus"], attached: ["chip-attached", "in use"],
      service: ["chip-service", "service"], orphan: ["chip-orphan", "orphaned"] };
    let lastScan = null;

    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const mem = (kb) => kb >= 1048576 ? (kb / 1048576).toFixed(1) + " GB" : Math.round(kb / 1024) + " MB";
    function ago(sec) {
      const d = Math.max(0, Math.round(Date.now() / 1000 - sec));
      if (d < 3600) return Math.round(d / 60) + " min";
      if (d < 172800) return Math.round(d / 3600) + " h";
      return Math.round(d / 86400) + " days";
    }

    function selected() {
      return [...mBody.querySelectorAll("input.m-pick:checked")].map((c) => ({ pid: +c.dataset.pid, start: +c.dataset.start }));
    }
    function updateKill() {
      const n = selected().length;
      mKill.disabled = n === 0;
      mKill.textContent = n ? `Kill ${n} selected` : "Kill selected";
    }

    function render(scan) {
      const ss = scan.sessions;
      const orphans = ss.filter((x) => x.killable);
      const reclaim = orphans.reduce((t, x) => t + x.rssKB, 0);
      const zombies = scan.zombies.reduce((t, z) => t + z.count, 0);
      mSub.innerHTML = orphans.length
        ? `<b>${orphans.length} orphaned</b> session${orphans.length > 1 ? "s" : ""} holding ${mem(reclaim)} · ` +
          `${ss.length - orphans.length} protected · ${zombies} zombie${zombies === 1 ? "" : "s"}`
        : `No orphans · ${ss.length} session${ss.length === 1 ? "" : "s"}, all protected · ${zombies} zombie${zombies === 1 ? "" : "s"}`;
      mSub.innerHTML += ` <span class="muted">· scanned ${new Date(scan.scannedAt * 1000).toLocaleTimeString()}</span>`;

      let html = "";
      for (const tab of TAB_ORDER) {
        const rows = ss.filter((x) => x.tab === tab)
          .sort((a, b) => (b.killable - a.killable) || (a.startedAt - b.startedAt));
        const o = rows.filter((x) => x.killable).length;
        html += `<section class="maint-section"><h3>${esc(tab)}<span class="count">${rows.length} session${rows.length === 1 ? "" : "s"}${o ? ` · ${o} orphaned` : ""}</span></h3>`;
        if (!rows.length) { html += `<div class="maint-empty">Nothing running.</div></section>`; continue; }
        html += `<table class="maint-table sessions"><thead><tr>
          <th>${o ? `<input type="checkbox" class="m-all" data-tab="${esc(tab)}" title="Select all orphaned">` : ""}</th>
          <th>Status</th><th>Where</th><th class="num">PID</th><th class="num">Running</th>
          <th class="num">Memory</th><th class="num">CPU</th><th>Why / command</th></tr></thead><tbody>`;
        for (const x of rows) {
          const [cls, label] = CHIP[x.status] || ["chip-attached", x.status];
          html += `<tr class="${x.killable ? "is-orphan" : ""}">
            <td>${x.killable ? `<input type="checkbox" class="m-pick" data-tab="${esc(tab)}" data-pid="${x.pid}" data-start="${x.start}">` : ""}</td>
            <td><span class="chip ${cls}">${label}</span></td>
            <td>${esc(x.container)}</td>
            <td class="num">${x.pid}</td>
            <td class="num">${ago(x.startedAt)}</td>
            <td class="num">${mem(x.rssKB)}</td>
            <td class="num">${x.cpuPct}%</td>
            <td><div>${esc(x.reason)}</div><div class="cmd">${esc(x.cmd)}${x.procs > 1 ? ` <span class="muted">(+${x.procs - 1} child process${x.procs > 2 ? "es" : ""})</span>` : ""}</div></td></tr>`;
        }
        html += `</tbody></table></section>`;
      }
      html += `<section class="maint-section"><h3>Zombies<span class="count">${zombies} — already dead, use no memory; only their parent can clear them</span></h3>`;
      if (!scan.zombies.length) html += `<div class="maint-empty">None.</div>`;
      else {
        html += `<table class="maint-table"><thead><tr><th>Where</th><th class="num">Count</th><th>Parent</th><th>What they were</th><th>Fix</th></tr></thead><tbody>`;
        for (const z of scan.zombies) {
          const what = Object.entries(z.names).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, c]) => `${esc(n)} ×${c}`).join(", ");
          const fix = z.parentIsInit
            ? (z.container === "host" ? "host init will reap them" : `the container's PID 1 never reaps — add <code>init: true</code> to ${esc(z.container)} (needs a recreate)`)
            : "cleared when the parent exits or reaps them";
          html += `<tr><td>${esc(z.container)}</td><td class="num">${z.count}</td>
            <td><span class="cmd">${esc(z.parentCmd)}</span> <span class="muted">pid ${z.parentPid}</span></td>
            <td class="muted">${what}</td><td class="muted">${fix}</td></tr>`;
        }
        html += `</tbody></table>`;
      }
      html += `</section>`;
      mBody.innerHTML = html;
      mBody.querySelectorAll("input.m-all").forEach((all) => all.addEventListener("change", () => {
        mBody.querySelectorAll(`input.m-pick[data-tab="${CSS.escape(all.dataset.tab)}"]`).forEach((c) => { c.checked = all.checked; });
        updateKill();
      }));
      mBody.querySelectorAll("input.m-pick").forEach((c) => c.addEventListener("change", updateKill));
      updateKill();
    }

    async function scanNow() {
      mRefresh.classList.add("busy");
      mSub.textContent = "Scanning… (takes a few seconds)";
      try {
        const r = await fetch("/api/maint/scan", { cache: "no-store" });
        const out = await r.json();
        if (!out.ok) throw new Error(out.error || `HTTP ${r.status}`);
        lastScan = out;
        render(out);
      } catch (err) {
        mSub.textContent = `Scan failed: ${err.message}`;
      } finally { mRefresh.classList.remove("busy"); }
    }
    function openMaint() { maint.classList.remove("hidden"); scanNow(); }
    function closeMaint() { maint.classList.add("hidden"); term.focus(); }

    wire("rec-maint", async () => openMaint());
    mRefresh.addEventListener("click", scanNow);
    document.getElementById("maint-close").addEventListener("click", closeMaint);
    maint.addEventListener("click", (e) => { if (e.target === maint) closeMaint(); });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !maint.classList.contains("hidden")) { e.stopPropagation(); closeMaint(); }
    }, true);
    mKill.addEventListener("click", async () => {
      const targets = selected();
      if (!targets.length || !lastScan) return;
      const rows = lastScan.sessions.filter((x) => targets.some((t) => t.pid === x.pid));
      const total = rows.reduce((t, x) => t + x.rssKB, 0);
      const list = rows.map((x) => `• ${x.tool} — ${x.container}, pid ${x.pid}, ${mem(x.rssKB)}, running ${ago(x.startedAt)}`).join("\n");
      if (!confirm(`Kill ${rows.length} orphaned session${rows.length > 1 ? "s" : ""} (${mem(total)})?\n\n${list}\n\nThe server re-checks each one first and refuses anything that is a nexus tab or still in use.`)) return;
      mKill.classList.add("busy"); mKill.disabled = true;
      try {
        const r = await fetch("/api/maint/kill", {
          method: "POST",
          headers: { "content-type": "application/json", "x-nexus-recover": "1" },
          body: JSON.stringify({ targets }),
        });
        const out = await r.json();
        if (!out.ok) throw new Error(out.error || `HTTP ${r.status}`);
        const done = out.results.filter((x) => x.ok);
        const refused = out.results.filter((x) => !x.ok);
        const freed = done.reduce((t, x) => t + (x.freedKB || 0), 0);
        notify(`Killed ${done.length}, freed ${mem(freed)}` + (refused.length ? ` · ${refused.length} refused: ${refused[0].error}` : ""), refused.length === 0);
      } catch (err) {
        notify(`Kill failed: ${err.message}`, false);
      } finally {
        mKill.classList.remove("busy");
        scanNow();
      }
    });
  } catch (err) { console.error("[nexus] recover setup failed:", err); }

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

  scheduleFit();
  connect(false);
})();
