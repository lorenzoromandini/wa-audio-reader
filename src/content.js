/**
 * Content script (mondo isolato) — gira solo su web.whatsapp.com.
 *
 * Trova i messaggi vocali, aggiunge sotto ognuno il pulsante "Trascrivi",
 * recupera l'audio tramite il page-hook (senza riprodurlo) e mostra il testo
 * dentro la chat. Le trascrizioni vengono salvate in storage.local e riusate.
 */
(() => {
  "use strict";

  const Core = globalThis.WaTtCore;
  if (!Core) return;

  const RELOAD_HINT =
    "L'estensione è stata aggiornata: ricarica la pagina di WhatsApp Web (Ctrl+Maiusc+R).";

  /** Indizi che identificano un messaggio vocale. Le classi di WhatsApp sono
      generate/atomiche, gli attributi data-icon e gli aria-label sopravvivono. */
  const VOICE_HINT_SELECTOR = [
    '[data-icon="ptt-status"]',
    '[data-icon="ptt-play"]',
    '[data-icon="audio-play"]',
    '[aria-label*="voice message" i]',
    '[aria-label*="voice note" i]',
    '[aria-label*="messaggio vocale" i]',
    '[aria-label*="nota vocale" i]'
  ].join(",");

  const STATUS_IDLE = "wa-tt-status";
  const STATUS_BUSY = "wa-tt-status wa-tt-busy";
  const STATUS_ERROR = "wa-tt-status wa-tt-error";

  let settings = Core.sanitizeSettings({});
  let stopped = false;
  let observer = null;
  let autoObserver = null;
  let safetyTimer = null;
  let scanTimer = null;
  let resizeTimer = null;
  let hookCheckedAt = 0;
  let requestSeq = 0;
  let fallbackKeySeq = 0;
  let uiSeq = 0;
  let autoPumping = false;
  let autoQueue = [];
  let captureChain = Promise.resolve();

  const pending = new Map();
  const uiByRow = new WeakMap();
  const rowKeyByRow = new WeakMap();
  const autoObserved = new WeakSet();
  const autoQueued = new WeakSet();
  const inFlight = new WeakSet();
  const wraps = new Set();

  // ------------------------------------------------------------- utilities

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  const ICON_PATHS = {
    transcript: "M4 6h16v2H4V6zm0 5h16v2H4v-2zm0 5h10v2H4v-2z",
    copy:
      "M16 1H4a2 2 0 0 0-2 2v12h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z",
    redo:
      "M17.65 6.35A8 8 0 1 0 20 12h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"
  };

  function icon(name, size) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", String(size || 15));
    svg.setAttribute("height", String(size || 15));
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("fill", "currentColor");
    path.setAttribute("d", ICON_PATHS[name] || ICON_PATHS.transcript);
    svg.appendChild(path);
    return svg;
  }

  /** Un vero click: React spesso reagisce ai pointer event, non a .click(). */
  function press(node) {
    const opts = { bubbles: true, cancelable: true, composed: true };
    try {
      node.dispatchEvent(new PointerEvent("pointerdown", opts));
      node.dispatchEvent(new MouseEvent("mousedown", opts));
      node.dispatchEvent(new PointerEvent("pointerup", opts));
      node.dispatchEvent(new MouseEvent("mouseup", opts));
    } catch (_) {}
    try {
      node.click();
    } catch (_) {}
  }

  function waitFor(fn, timeout, step) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        let value = null;
        try {
          value = fn();
        } catch (_) {
          value = null;
        }
        if (value) return resolve(value);
        if (Date.now() - started > timeout) return resolve(null);
        setTimeout(tick, step || 100);
      };
      tick();
    });
  }

  function contextAlive() {
    try {
      return !!(browser.runtime && browser.runtime.id);
    } catch (_) {
      return false;
    }
  }

  function isOrphanError(err) {
    return /context invalidated|extension context|receiving end does not exist|message port closed/i.test(
      String((err && err.message) || err || "")
    );
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {}
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "readonly");
      area.style.position = "fixed";
      area.style.opacity = "0";
      area.style.pointerEvents = "none";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }

  // ---------------------------------------------------- ponte col page-hook

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__waTt !== "res") return;
    const resolve = pending.get(ev.data.id);
    if (!resolve) return;
    pending.delete(ev.data.id);
    resolve(ev.data);
  });

  function askPage(action, extra, timeout) {
    return new Promise((resolve) => {
      const id = ++requestSeq;
      pending.set(id, resolve);
      try {
        window.postMessage(Object.assign({ __waTt: "req", id, action }, extra || {}), "*");
      } catch (err) {
        pending.delete(id);
        resolve({ ok: false, error: String(err) });
        return;
      }
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve({ ok: false, error: "timeout" });
        }
      }, timeout || 5000);
    });
  }

  async function ensureHook() {
    if (Date.now() - hookCheckedAt < 4000) return;
    const res = await askPage("ping", {}, 3000);
    if (!res || !res.ok) {
      throw new Error(
        "Il componente pagina non è attivo. Ricarica la pagina di WhatsApp Web (Ctrl+Maiusc+R) e riprova."
      );
    }
    hookCheckedAt = Date.now();
  }

  // -------------------------------------------------------- audio: cattura

  function labelOf(node) {
    return ((node.getAttribute("aria-label") || "") + " " + (node.textContent || "")).trim();
  }

  function isSpeedButton(node) {
    const text = (node.textContent || "").trim();
    return /\b\d{1,2}([.,]\d)?\s*[x×]\b/i.test(text);
  }

  function isDownloadButton(node) {
    const label = (node.getAttribute("aria-label") || "").toLowerCase();
    const text = (node.textContent || "").toLowerCase();
    return (
      /download|scarica|descargar|herunterladen|télécharger/.test(label) ||
      text.indexOf("download") !== -1
    );
  }

  function isPauseButton(node) {
    return /pause|pausa|in riproduzione/i.test(labelOf(node));
  }

  /**
   * Il controllo principale (play/pausa/download) è il pulsante che precede lo
   * slider di avanzamento. Il controllo velocità ("1x", "1,5x") viene dopo.
   */
  function findTransportButton(row) {
    const buttons = Array.from(row.querySelectorAll("button")).filter(
      (b) => !b.closest("[data-wa-tt-ui]")
    );
    if (!buttons.length) return null;
    const slider = row.querySelector('[role="slider"]');
    if (slider) {
      const before = buttons.filter(
        (b) => b.compareDocumentPosition(slider) & Node.DOCUMENT_POSITION_FOLLOWING
      );
      if (before.length) return before[before.length - 1];
    }
    const nonSpeed = buttons.filter((b) => !isSpeedButton(b));
    const labelled = nonSpeed.find((b) =>
      /play|pause|download|riproduci|pausa|scarica/i.test(labelOf(b))
    );
    return labelled || nonSpeed[0] || null;
  }

  /** Un vocale mai aperto mostra "download" al posto di play: lo premiamo. */
  async function ensureDownloaded(row, onStatus) {
    const btn = findTransportButton(row);
    if (!btn || !isDownloadButton(btn)) return;
    onStatus("Scarico l'audio da WhatsApp…");
    press(btn);
    const next = await waitFor(
      () => {
        const candidate = findTransportButton(row);
        return candidate && !isDownloadButton(candidate) ? candidate : null;
      },
      30000,
      300
    );
    if (!next) {
      throw new Error("WhatsApp non ha completato il download dell'audio. Riprova fra qualche secondo.");
    }
  }

  function mapCaptureError(code) {
    if (code === "timeout") {
      return "Non sono riuscito a recuperare l'audio: WhatsApp non ha avviato il download. Riprova.";
    }
    if (code === "too-large") return "L'audio è troppo grande (oltre 25 MB).";
    return "Recupero dell'audio non riuscito" + (code ? ": " + code : ".");
  }

  /**
   * Recupera i byte del vocale senza farlo sentire: arma il page-hook,
   * preme il play di WhatsApp (che scarica/decrittografa) e lascia che il
   * hook intercetti la play() restituendo i byte al posto del suono.
   */
  async function captureRow(row, onStatus) {
    await ensureHook();
    await ensureDownloaded(row, onStatus);

    let btn = findTransportButton(row);
    if (!btn) {
      throw new Error("Controlli del vocale non trovati. Ricarica la pagina di WhatsApp Web e riprova.");
    }
    if (isPauseButton(btn)) {
      press(btn);
      await sleep(350);
      btn = findTransportButton(row) || btn;
    }
    if (isDownloadButton(btn)) {
      throw new Error("L'audio non è ancora scaricato da WhatsApp. Riprova fra qualche secondo.");
    }

    const captured = askPage("arm", { ms: 40000 }, 45000);
    await sleep(30);
    onStatus("Recupero l'audio…");
    press(btn);

    let res;
    try {
      res = await captured;
    } finally {
      await askPage("hold", { ms: 2500 }, 3000);
      const stopBtn = findTransportButton(row);
      if (stopBtn) {
        try {
          press(stopBtn);
        } catch (_) {}
      }
      await sleep(350);
      await askPage("silence", {}, 3000);
      await askPage("disarm", {}, 3000);
    }

    if (!res || !res.ok || !res.base64) throw new Error(mapCaptureError(res && res.error));
    return { base64: res.base64, mimeType: res.type || "audio/ogg", size: res.size || 0 };
  }

  /** Serializza le catture: il page-hook può armare una sola cattura per volta. */
  function withCaptureLock(task) {
    const run = captureChain.then(task, task);
    captureChain = run.catch(() => {});
    return run;
  }

  // -------------------------------------------------- riconoscimento messaggi

  function messageRowFor(node) {
    if (!node || !node.closest) return null;
    const scope = node.closest("#main") || document.body;
    let cur = node;
    let best = null;
    while (cur && cur !== scope && cur !== document.body) {
      if (cur.matches && cur.matches('[data-id], div[role="row"]')) best = cur;
      cur = cur.parentElement;
    }
    return best || node.closest('[data-id], div[role="row"]');
  }

  function rowId(row) {
    if (!row) return "";
    if (row.hasAttribute && row.hasAttribute("data-id")) return row.getAttribute("data-id") || "";
    const ancestor = row.closest ? row.closest("[data-id]") : null;
    if (ancestor && ancestor !== row) return ancestor.getAttribute("data-id") || "";
    const descendant = row.querySelector ? row.querySelector("[data-id]") : null;
    if (descendant) return descendant.getAttribute("data-id") || "";
    return "";
  }

  function rowKey(row) {
    const id = rowId(row);
    if (id) return id;
    if (!rowKeyByRow.has(row)) {
      rowKeyByRow.set(row, "sessione-" + ++fallbackKeySeq + "-" + Date.now().toString(36));
    }
    return rowKeyByRow.get(row);
  }

  function hintFor(row) {
    return (
      (row.querySelector && row.querySelector(VOICE_HINT_SELECTOR)) ||
      (row.querySelector && row.querySelector("audio")) ||
      row.firstElementChild
    );
  }

  function isIncomingRow(row, id) {
    const key = id || rowId(row);
    if (key && key.indexOf("false_") === 0) return true;
    if (key && key.indexOf("true_") === 0) return false;
    const hint = hintFor(row);
    if (!hint) return true;
    try {
      const h = hint.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      if (!r.width) return true;
      return (h.left + h.right) / 2 <= (r.left + r.right) / 2;
    } catch (_) {
      return true;
    }
  }

  function findRows(scope) {
    const rows = [];
    const push = (node) => {
      const row = messageRowFor(node);
      if (row && rows.indexOf(row) === -1) rows.push(row);
    };
    scope.querySelectorAll(VOICE_HINT_SELECTOR).forEach(push);
    scope.querySelectorAll("audio").forEach(push);
    return rows;
  }

  // ---------------------------------------------------------------- cache

  async function cacheGet(id) {
    if (!id) return null;
    try {
      const key = Core.cacheKeyFor(id);
      const got = await browser.storage.local.get(key);
      const entry = got[key];
      if (!entry || typeof entry.text !== "string" || !entry.text) return null;
      return entry;
    } catch (err) {
      if (isOrphanError(err)) shutdown();
      return null;
    }
  }

  async function cacheSet(id, data) {
    if (!id) return;
    try {
      await browser.storage.local.set({ [Core.cacheKeyFor(id)]: data });
      pruneCache();
    } catch (err) {
      if (isOrphanError(err)) shutdown();
    }
  }

  async function pruneCache() {
    try {
      const all = await browser.storage.local.get(null);
      const keys = Object.keys(all).filter(Core.isCacheKey);
      if (keys.length <= Core.CACHE_LIMIT) return;
      keys.sort((a, b) => ((all[a] && all[a].ts) || 0) - ((all[b] && all[b].ts) || 0));
      const excess = keys.slice(0, keys.length - Core.CACHE_LIMIT);
      if (excess.length) await browser.storage.local.remove(excess);
    } catch (_) {}
  }

  // ------------------------------------------------------------------- UI

  function buildUI(row, id) {
    const wrap = el("div", "wa-tt");
    wrap.setAttribute("data-wa-tt-ui", "1");
    wrap.dataset.msgId = id || "";

    const bar = el("div", "wa-tt-bar");

    const btn = el("button", "wa-tt-btn");
    btn.type = "button";
    btn.title = "Trascrivi questo audio senza ascoltarlo";
    const label = el("span", "wa-tt-btn-label", "Trascrivi");
    btn.append(icon("transcript"), label);

    const status = el("span", STATUS_IDLE);
    status.setAttribute("role", "status");

    const toggle = el("button", "wa-tt-link wa-tt-toggle", "Nascondi");
    toggle.type = "button";
    toggle.hidden = true;

    const settingsLink = el("button", "wa-tt-link wa-tt-settings", "Impostazioni");
    settingsLink.type = "button";
    settingsLink.hidden = true;

    bar.append(btn, status, toggle, settingsLink);

    const panel = el("div", "wa-tt-panel");
    panel.hidden = true;
    panel.id = "wa-tt-panel-" + ++uiSeq;
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "Trascrizione dell'audio");
    panel.setAttribute("aria-live", "polite");
    toggle.setAttribute("aria-controls", panel.id);
    toggle.setAttribute("aria-expanded", "false");
    const text = el("p", "wa-tt-text");
    text.dir = "auto";
    const actions = el("div", "wa-tt-actions");
    const copy = el("button", "wa-tt-link wa-tt-copy", "Copia");
    copy.type = "button";
    const redo = el("button", "wa-tt-link wa-tt-redo", "Rigenera");
    redo.type = "button";
    const meta = el("span", "wa-tt-meta");
    actions.append(copy, redo, meta);
    panel.append(text, actions);

    wrap.append(bar, panel);

    const ui = {
      wrap,
      row,
      msgId: id || "",
      side: "in",
      state: "idle",
      cacheChecked: false,
      btn,
      label,
      status,
      toggle,
      settingsLink,
      panel,
      text,
      copy,
      redo,
      meta
    };

    ["click", "mousedown", "mouseup", "dblclick", "pointerdown"].forEach((type) =>
      wrap.addEventListener(type, (ev) => ev.stopPropagation())
    );

    btn.addEventListener("click", () => run(row, ui, {}));
    redo.addEventListener("click", () => run(row, ui, { force: true }));
    toggle.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      toggle.textContent = panel.hidden ? "Mostra testo" : "Nascondi";
      toggle.setAttribute("aria-expanded", String(!panel.hidden));
    });
    copy.addEventListener("click", async () => {
      const ok = await copyText(text.textContent || "");
      copy.textContent = ok ? "Copiato" : "Copia non riuscita";
      setTimeout(() => {
        copy.textContent = "Copia";
      }, 1600);
    });
    settingsLink.addEventListener("click", () => {
      try {
        browser.runtime.sendMessage({ type: "wa-tt/open-options" });
      } catch (_) {}
    });

    return ui;
  }

  function setStatus(ui, message, kind) {
    ui.status.textContent = message || "";
    ui.status.className = kind === "error" ? STATUS_ERROR : kind === "busy" ? STATUS_BUSY : STATUS_IDLE;
  }

  function setBusy(ui, message) {
    ui.state = "busy";
    ui.btn.disabled = true;
    ui.btn.hidden = false;
    ui.settingsLink.hidden = true;
    ui.label.textContent = "Trascrivo…";
    setStatus(ui, message, "busy");
  }

  function setError(ui, message, showSettings) {
    ui.state = "error";
    ui.btn.disabled = false;
    ui.btn.hidden = false;
    ui.label.textContent = "Riprova";
    ui.settingsLink.hidden = !showSettings;
    setStatus(ui, message, "error");
  }

  function showNotConfigured(ui) {
    setError(ui, "Apri le impostazioni e configura il servizio di trascrizione.", true);
  }

  function renderUI(ui, data) {
    ui.state = "done";
    ui.btn.hidden = true;
    ui.btn.disabled = false;
    ui.settingsLink.hidden = true;
    setStatus(ui, "", "idle");

    ui.text.textContent = data.text || "";
    const provider = (Core.PROVIDERS[data.provider] || {}).label || "";
    const bits = [];
    if (data.auto) bits.push("automatico");
    if (provider) bits.push(provider);
    if (data.ts) {
      try {
        bits.push(
          new Date(data.ts).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })
        );
      } catch (_) {}
    }
    ui.meta.textContent = bits.join(" · ");

    ui.toggle.hidden = false;
    ui.toggle.textContent = "Nascondi";
    ui.toggle.setAttribute("aria-expanded", "true");
    ui.panel.hidden = false;
  }

  async function renderCached(ui) {
    if (ui.cacheChecked || ui.state !== "idle" || !ui.msgId || !ui.wrap.isConnected) return;
    ui.cacheChecked = true;
    const hit = await cacheGet(ui.msgId);
    if (hit && ui.state === "idle" && ui.wrap.isConnected) renderUI(ui, hit);
  }

  // --------------------------------------------------------------- pipeline

  async function run(row, ui, opts) {
    const options = opts || {};
    if (!contextAlive()) {
      shutdown();
      return;
    }
    if (ui.state === "busy" || inFlight.has(row)) return;
    if (!Core.providerConfigured(settings)) {
      showNotConfigured(ui);
      return;
    }

    inFlight.add(row);
    try {
      const id = ui.msgId || rowKey(row);
      if (!options.force) {
        const hit = await cacheGet(id);
        if (hit) {
          renderUI(ui, hit);
          return;
        }
      }

      const captured = await withCaptureLock(() =>
        captureRow(row, (message) => setBusy(ui, message))
      );

      setBusy(ui, "Trascrivo…");
      const res = await browser.runtime.sendMessage({
        type: "wa-tt/transcribe",
        base64: captured.base64,
        mimeType: captured.mimeType,
        messageId: id
      });

      if (!res || !res.ok) {
        const message = (res && res.error) || "Trascrizione non riuscita.";
        if (res && (res.code === "NO_KEY" || res.code === "NO_ENDPOINT" || res.code === "MISSING_PERMISSION")) {
          setError(ui, message, true);
          return;
        }
        throw new Error(message);
      }

      const text = String(res.text || "").trim();
      const data = {
        text,
        ts: Date.now(),
        provider: settings.provider,
        model: res.model || "",
        auto: !!options.auto
      };
      if (text) await cacheSet(id, data);
      renderUI(ui, data);
      if (!text) setStatus(ui, "Nessun parlato riconosciuto in questo audio.", "idle");
    } catch (err) {
      if (isOrphanError(err)) {
        shutdown();
      } else {
        setError(ui, String((err && err.message) || err), false);
      }
    } finally {
      inFlight.delete(row);
    }
  }

  // ---------------------------------------------------------- automatico

  function enqueueAuto(row, ui) {
    if (!settings.auto || !Core.providerConfigured(settings)) return;
    if (!isIncomingRow(row)) return;
    if (autoQueued.has(row) || ui.state !== "idle") return;
    autoQueued.add(row);
    autoQueue.push({ row, ui });
    pumpAuto();
  }

  async function pumpAuto() {
    if (autoPumping) return;
    autoPumping = true;
    try {
      while (autoQueue.length) {
        const item = autoQueue.shift();
        if (!item.row.isConnected || item.ui.state !== "idle") continue;
        try {
          await run(item.row, item.ui, { auto: true });
        } catch (_) {}
      }
    } finally {
      autoPumping = false;
    }
  }

  // ------------------------------------------------------- comandi da tastiera

  /** L'ultimo vocale della chat: l'ultimo in ordine di DOM, se trascrivibile. */
  function latestVoiceUi() {
    const scope = document.querySelector("#main") || document.body;
    if (!scope) return null;
    scan();
    const rows = findRows(scope);
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      const ui = uiByRow.get(row);
      if (ui && ui.wrap.isConnected && ui.state !== "busy") return ui;
    }
    return null;
  }

  function handleCommand(command) {
    if (command !== "transcribe-latest") return;
    if (!contextAlive()) {
      shutdown();
      return;
    }
    const ui = latestVoiceUi();
    if (!ui) return;
    try {
      ui.wrap.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } catch (_) {}
    if (ui.state === "done") {
      ui.panel.hidden = false;
      ui.toggle.textContent = "Nascondi";
      ui.toggle.setAttribute("aria-expanded", "true");
      return;
    }
    run(ui.row, ui, {});
  }

  function watchCommands() {
    try {
      browser.runtime.onMessage.addListener((msg) => {
        if (!msg || msg.type !== "wa-tt/command") return;
        handleCommand(msg.command);
      });
    } catch (_) {}
  }

  // ------------------------------------------------------- scansione e vita

  function detectDark() {
    try {
      const node = document.querySelector("#main") || document.body;
      const bg = getComputedStyle(node).backgroundColor;
      const match = bg && bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      if (!match) return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
      const r = Number(match[1]);
      const g = Number(match[2]);
      const b = Number(match[3]);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
    } catch (_) {
      return false;
    }
  }

  function findBubble(node) {
    let cur = node;
    for (let i = 0; cur && i < 8; i++, cur = cur.parentElement) {
      try {
        const bg = getComputedStyle(cur).backgroundColor;
        if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") return cur;
      } catch (_) {}
    }
    return null;
  }

  function alignWrap(ui) {
    const row = ui.row;
    const wrap = ui.wrap;
    if (!row || !wrap.isConnected) return;
    try {
      const hint = hintFor(row);
      const anchor = findBubble(hint) || hint;
      if (!anchor) return;
      const wrapRect = wrap.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      if (!wrapRect.width || !anchorRect.width) return;

      if (window.innerWidth < 900) {
        wrap.style.paddingLeft = "12px";
        wrap.style.paddingRight = "12px";
        return;
      }

      const indent =
        ui.side === "in" ? anchorRect.left - wrapRect.left : wrapRect.right - anchorRect.right;
      const clamped = Math.max(0, Math.min(Math.round(indent), Math.round(wrapRect.width * 0.45)));
      const other = Math.max(12, Math.round(wrapRect.width * 0.12));
      wrap.style.paddingLeft = (ui.side === "in" ? clamped : other) + "px";
      wrap.style.paddingRight = (ui.side === "in" ? other : clamped) + "px";
    } catch (_) {}
  }

  function applyTheme(ui) {
    try {
      ui.wrap.classList.toggle("wa-tt-dark", detectDark());
    } catch (_) {}
  }

  function realignAll() {
    for (const ui of wraps) {
      if (!ui.wrap.isConnected) {
        wraps.delete(ui);
        continue;
      }
      alignWrap(ui);
    }
  }

  function applyThemeAll() {
    for (const ui of wraps) {
      if (ui.wrap.isConnected) applyTheme(ui);
    }
  }

  function scan() {
    if (stopped || !document.body) return;
    const scope = document.querySelector("#main") || document.body;
    const rows = findRows(scope);

    for (const row of rows) {
      const id = rowKey(row);
      let ui = uiByRow.get(row);

      // React può riciclare la riga: se il contenuto non è più quello giusto
      // (o il nostro riquadro è stato rimosso) ricostruiamo tutto.
      if (ui && (!ui.wrap.isConnected || ui.msgId !== (id || ""))) {
        try {
          ui.wrap.remove();
        } catch (_) {}
        wraps.delete(ui);
        uiByRow.delete(row);
        ui = null;
      }

      if (!ui) {
        ui = buildUI(row, id);
        ui.side = isIncomingRow(row, id) ? "in" : "out";
        row.appendChild(ui.wrap);
        uiByRow.set(row, ui);
        wraps.add(ui);
        applyTheme(ui);
        requestAnimationFrame(() => alignWrap(ui));
        renderCached(ui);
      }

      if (
        settings.auto &&
        Core.providerConfigured(settings) &&
        isIncomingRow(row, id) &&
        !autoObserved.has(row) &&
        autoObserver
      ) {
        autoObserved.add(row);
        autoObserver.observe(row);
      }
    }

    for (const ui of wraps) {
      if (!ui.wrap.isConnected) wraps.delete(ui);
    }
  }

  function scheduleScan() {
    if (scanTimer || stopped) return;
    scanTimer = window.setTimeout(() => {
      scanTimer = null;
      scan();
    }, 250);
  }

  function shutdown() {
    if (stopped) return;
    stopped = true;
    try {
      if (observer) observer.disconnect();
    } catch (_) {}
    try {
      if (autoObserver) autoObserver.disconnect();
    } catch (_) {}
    try {
      if (safetyTimer) clearInterval(safetyTimer);
    } catch (_) {}
    try {
      if (scanTimer) clearTimeout(scanTimer);
    } catch (_) {}
    for (const ui of wraps) {
      try {
        ui.btn.disabled = true;
        ui.btn.hidden = true;
        ui.settingsLink.hidden = true;
        setStatus(ui, RELOAD_HINT, "error");
      } catch (_) {}
    }
    try {
      askPage("disarm", {}, 2000);
    } catch (_) {}
  }

  async function loadSettings() {
    const dev = globalThis.__WA_TT_DEV_SETTINGS__;
    if (dev) {
      settings = Core.sanitizeSettings(dev);
      return;
    }
    try {
      const got = await browser.storage.local.get(Core.SETTINGS_KEY);
      settings = Core.sanitizeSettings(got[Core.SETTINGS_KEY]);
    } catch (err) {
      if (isOrphanError(err)) shutdown();
    }
  }

  function watchSettings() {
    try {
      browser.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes[Core.SETTINGS_KEY]) return;
        settings = Core.sanitizeSettings(changes[Core.SETTINGS_KEY].newValue);
        if (!settings.auto) autoQueue = [];
        scheduleScan();
      });
    } catch (_) {}
  }

  function setupObservers() {
    if (typeof IntersectionObserver === "function") {
      autoObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const row = entry.target;
            try {
              autoObserver.unobserve(row);
            } catch (_) {}
            const ui = uiByRow.get(row);
            if (ui && row.isConnected) enqueueAuto(row, ui);
          }
        },
        { threshold: 0.6 }
      );
    }

    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const target = mutation.target;
        if (target && target.closest && target.closest("[data-wa-tt-ui]")) continue;
        const added = Array.from(mutation.addedNodes || []);
        if (
          added.length &&
          added.every((node) => node.nodeType === 1 && node.hasAttribute && node.hasAttribute("data-wa-tt-ui"))
        ) {
          continue;
        }
        scheduleScan();
        return;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Rete di sicurezza: la lista di WhatsApp è virtualizzata.
    safetyTimer = window.setInterval(() => {
      if (!contextAlive()) {
        shutdown();
        return;
      }
      scan();
    }, 2000);

    window.addEventListener("resize", () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(realignAll, 250);
    });

    try {
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      if (media && media.addEventListener) media.addEventListener("change", applyThemeAll);
    } catch (_) {}

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") scheduleScan();
    });
  }

  (async () => {
    await loadSettings();
    if (stopped) return;
    watchSettings();
    watchCommands();
    setupObservers();
    scan();
  })();
})();
