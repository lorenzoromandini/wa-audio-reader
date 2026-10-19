/**
 * Gira nel mondo della PAGINA (world: "MAIN") a document_start.
 *
 * Perché serve: WhatsApp Web non mette l'audio dei vocali nel DOM. La
 * decrittazione avviene in un worker, l'URL blob viene creato lì e la
 * riproduzione passa da un `new Audio()` che non viene mai agganciato al
 * documento. Quindi né una scansione del DOM né un hook su
 * `URL.createObjectURL` del thread principale riescono a vedere l'audio.
 *
 * L'unico punto che scatta sempre è `HTMLMediaElement.prototype.play()`.
 * Quando una cattura è "armata" leggiamo l'URL blob, scarichiamo l'audio e
 * restituiamo una promise già risolta SENZA chiamare il play() originale:
 * il brano non parte, non c'è audio in riproduzione.
 *
 * La soppressione è a tempo (non legata alla singola cattura) perché WhatsApp
 * imposta .src e chiama play() un istante dopo: se togliessimo il blocco
 * subito dopo aver preso i byte, quel play() tardivo farebbe partire l'audio.
 */
(() => {
  "use strict";

  if (window.__WA_TT_HOOK__) return;
  window.__WA_TT_HOOK__ = true;

  const VERSION = 1;
  const MAX_BYTES = 25 * 1024 * 1024;
  const MAX_RETAINED = 40;
  const MAX_SEEN = 30;

  /** Blob audio visti passare (per un secondo tentativo a freddo). */
  const retained = new Map();
  /** Elementi media già usati, così possiamo zittirli tutti. */
  const seen = new Set();

  /** @type {{id:number, done:boolean, deadline:number, timer:number}|null} */
  let capture = null;
  let suppressUntil = 0;

  const suppressing = () => Date.now() < suppressUntil;
  const reply = (id, payload) => {
    try {
      window.postMessage(Object.assign({ __waTt: "res", id }, payload), "*");
    } catch (_) {}
  };

  // ------------------------------------------------------------- utilities

  function remember(node) {
    try {
      seen.add(node);
      while (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
    } catch (_) {}
  }

  function silenceAll() {
    let stopped = 0;
    for (const node of seen) {
      try {
        if (!node.paused) stopped++;
        node.pause();
        node.currentTime = 0;
        node.muted = false;
        node.volume = 1;
      } catch (_) {}
    }
    return stopped;
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || "");
        const comma = result.indexOf(",");
        resolve(comma >= 0 ? result.slice(comma + 1) : "");
      };
      reader.onerror = () => reject(reader.error || new Error("lettura audio fallita"));
      reader.readAsDataURL(blob);
    });
  }

  function looksLikeAudio(blob) {
    const type = String((blob && blob.type) || "").toLowerCase();
    if (type.indexOf("audio/") === 0) return true;
    if (type === "" || type === "application/octet-stream") return blob.size > 0 && blob.size <= MAX_BYTES;
    return false;
  }

  // --------------------------------------------------------------- capture

  async function grab(url) {
    if (!capture || capture.done) return;
    if (typeof url !== "string" || url.indexOf("blob:") !== 0) return;

    capture.done = true;
    if (capture.timer) clearTimeout(capture.timer);
    const id = capture.id;

    // Tiene il blocco un momento oltre la cattura: WhatsApp può chiamare
    // play() ancora una volta, dopo aver assegnato .src.
    suppressUntil = Math.max(suppressUntil, Date.now() + 2000);

    try {
      const res = await fetch(url);
      if (!res.ok) return reply(id, { ok: false, error: "fetch audio " + res.status });
      const blob = await res.blob();
      if (!blob || !blob.size) return reply(id, { ok: false, error: "audio vuoto" });
      if (blob.size > MAX_BYTES) return reply(id, { ok: false, error: "too-large" });
      retained.set(url, blob);
      while (retained.size > MAX_RETAINED) retained.delete(retained.keys().next().value);
      const base64 = await blobToBase64(blob);
      if (!base64) return reply(id, { ok: false, error: "conversione audio fallita" });
      reply(id, { ok: true, base64, type: blob.type || "audio/ogg", size: blob.size });
    } catch (err) {
      reply(id, { ok: false, error: String((err && err.message) || err) });
    }
  }

  // ---------------------------------------------------------------- patch

  try {
    const origCreate = URL.createObjectURL.bind(URL);
    const origRevoke = URL.revokeObjectURL.bind(URL);

    URL.createObjectURL = function (obj) {
      const url = origCreate(obj);
      try {
        if (obj instanceof Blob && !(obj instanceof File) && looksLikeAudio(obj)) {
          retained.set(url, obj);
          while (retained.size > MAX_RETAINED) retained.delete(retained.keys().next().value);
          grab(url);
        }
      } catch (_) {}
      return url;
    };

    URL.revokeObjectURL = function (url) {
      try {
        retained.delete(url);
      } catch (_) {}
      return origRevoke(url);
    };
  } catch (_) {}

  const origPlay = HTMLMediaElement.prototype.play;
  const origPause = HTMLMediaElement.prototype.pause;

  HTMLMediaElement.prototype.play = function () {
    try {
      remember(this);
      grab(this.src || this.currentSrc);
    } catch (_) {}

    if (suppressing()) {
      try {
        this.muted = true;
        this.volume = 0;
        origPause.call(this);
      } catch (_) {}
      return Promise.resolve();
    }
    return origPlay.apply(this, arguments);
  };

  // Intercetta l'URL il prima possibile, prima ancora della play().
  try {
    const srcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
    if (srcDesc && srcDesc.set) {
      Object.defineProperty(HTMLMediaElement.prototype, "src", {
        configurable: true,
        enumerable: srcDesc.enumerable,
        get() {
          return srcDesc.get.call(this);
        },
        set(value) {
          try {
            remember(this);
            grab(value);
          } catch (_) {}
          return srcDesc.set.call(this, value);
        }
      });
    }
  } catch (_) {}

  // new Audio(url) imposta src internamente e non passa dall'accessor.
  try {
    const OrigAudio = window.Audio;
    const PatchedAudio = function (src) {
      const node = new OrigAudio(src);
      try {
        remember(node);
        if (src) grab(src);
      } catch (_) {}
      return node;
    };
    PatchedAudio.prototype = OrigAudio.prototype;
    window.Audio = PatchedAudio;
  } catch (_) {}

  // --------------------------------------------------------------- bridge

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__waTt !== "req") return;
    const id = ev.data.id;
    const action = ev.data.action;

    try {
      if (action === "ping") {
        reply(id, { ok: true, version: VERSION, suppressing: suppressing() });
        return;
      }

      if (action === "arm") {
        const ms = Math.max(3000, Math.min(90000, Number(ev.data.ms) || 40000));
        if (capture && capture.timer) clearTimeout(capture.timer);
        suppressUntil = Date.now() + ms;
        capture = {
          id,
          done: false,
          deadline: Date.now() + ms,
          timer: window.setTimeout(() => {
            if (capture && capture.id === id && !capture.done) {
              capture = null;
              reply(id, { ok: false, error: "timeout" });
            }
          }, ms)
        };
        return; // la risposta arriva quando l'audio è stato preso
      }

      if (action === "hold") {
        const ms = Math.max(0, Math.min(15000, Number(ev.data.ms) || 2500));
        suppressUntil = Math.max(suppressUntil, Date.now() + ms);
        reply(id, { ok: true });
        return;
      }

      if (action === "silence") {
        reply(id, { ok: true, stopped: silenceAll() });
        return;
      }

      if (action === "disarm") {
        if (capture && capture.timer) clearTimeout(capture.timer);
        capture = null;
        suppressUntil = 0;
        reply(id, { ok: true, stopped: silenceAll() });
        return;
      }

      if (action === "reopen") {
        const url = String(ev.data.url || "");
        const blob = retained.get(url);
        if (!blob) {
          reply(id, { ok: false, error: "not-retained" });
          return;
        }
        blobToBase64(blob)
          .then((base64) => reply(id, { ok: true, base64, type: blob.type || "audio/ogg", size: blob.size }))
          .catch((err) => reply(id, { ok: false, error: String((err && err.message) || err) }));
        return;
      }

      if (action === "state") {
        reply(id, {
          ok: true,
          version: VERSION,
          suppressing: suppressing(),
          armed: !!capture && !capture.done,
          retained: retained.size
        });
        return;
      }

      reply(id, { ok: false, error: "azione sconosciuta" });
    } catch (err) {
      reply(id, { ok: false, error: String((err && err.message) || err) });
    }
  });
})();
