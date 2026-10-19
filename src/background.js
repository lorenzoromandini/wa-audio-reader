/**
 * Background (event page) — è l'unico punto che parla con il servizio di
 * trascrizione: la chiave API resta qui e la richiesta parte dal contesto
 * dell'estensione, aggirando CORS/CSP di web.whatsapp.com.
 */
"use strict";

const Core = globalThis.WaTtCore;

async function getSettings() {
  try {
    const got = await browser.storage.local.get(Core.SETTINGS_KEY);
    return Core.sanitizeSettings(got[Core.SETTINGS_KEY]);
  } catch (_) {
    return Core.sanitizeSettings({});
  }
}

async function readErrorBody(res) {
  try {
    return Core.cleanDetail(await res.text());
  } catch (_) {
    return "";
  }
}

async function transcribeAudio(settings, payload) {
  const clean = Core.sanitizeSettings(settings);
  const provider = Core.providerOf(clean);
  const endpoint = Core.normalizeEndpoint(clean.endpoint, clean.provider);

  if (!endpoint) {
    return { ok: false, code: "NO_ENDPOINT", error: "Configura l'URL del servizio nelle impostazioni." };
  }

  const originPattern = Core.originPatternFor(endpoint);
  if (!originPattern) {
    return { ok: false, code: "BAD_ENDPOINT", error: "L'URL del servizio non è valido." };
  }

  let granted = false;
  try {
    granted = await browser.permissions.contains({ origins: [originPattern] });
  } catch (_) {
    granted = false;
  }
  if (!granted) {
    return {
      ok: false,
      code: "MISSING_PERMISSION",
      origin: originPattern,
      error:
        "Manca l'autorizzazione per " + originPattern +
        ". Apri le impostazioni e premi \"Autorizza accesso\"."
    };
  }

  const apiKey = String(clean.apiKey || "").trim();
  if (provider.keyRequired && !apiKey) {
    return { ok: false, code: "NO_KEY", error: "Inserisci la chiave API del servizio nelle impostazioni." };
  }

  const bytes = Core.base64ToBytes(payload && payload.base64);
  if (!bytes.length) {
    return { ok: false, code: "EMPTY_AUDIO", error: "Audio vuoto o non leggibile." };
  }
  if (bytes.length > Core.MAX_AUDIO_BYTES) {
    return {
      ok: false,
      code: "TOO_BIG",
      error:
        "Audio troppo grande (" + Core.formatBytes(bytes.length) + "): il massimo è " +
        Core.formatBytes(Core.MAX_AUDIO_BYTES) + "."
    };
  }

  const mimeType = (payload && payload.mimeType) || "audio/ogg";
  const { form, model } = Core.buildTranscribeForm(clean, bytes, mimeType);

  const headers = {};
  if (apiKey) headers.Authorization = "Bearer " + apiKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);

  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: form,
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = !!(err && (err.name === "AbortError" || /abort/i.test(String(err))));
    return {
      ok: false,
      code: aborted ? "TIMEOUT" : "NETWORK",
      error: aborted
        ? "Il servizio non ha risposto in tempo (3 minuti). Riprova o prova con un audio più corto."
        : "Impossibile contattare il servizio: controlla la connessione, l'URL e che un eventuale server locale sia avviato."
    };
  }
  clearTimeout(timer);

  if (!res.ok) {
    const detail = await readErrorBody(res);
    return {
      ok: false,
      code: "HTTP_" + res.status,
      error: Core.friendlyError(res.status, detail, provider.label)
    };
  }

  const raw = await res.text();
  let text = "";
  try {
    text = Core.responseText(JSON.parse(raw));
  } catch (_) {
    text = Core.responseText(raw);
  }

  return { ok: true, text, model, provider: provider.id, bytes: bytes.length };
}

browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return undefined;

  if (msg.type === "wa-tt/transcribe") {
    getSettings()
      .then((settings) => transcribeAudio(settings, msg))
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, code: "UNEXPECTED", error: String((err && err.message) || err) }));
    return true;
  }

  if (msg.type === "wa-tt/test") {
    (async () => {
      const settings = Object.assign(Core.sanitizeSettings(msg.settings), { language: "auto" });
      const wav = Core.buildSilentWav(0.5, 16000);
      const result = await transcribeAudio(settings, {
        base64: Core.bytesToBase64(wav),
        mimeType: "audio/wav",
        language: "auto"
      });
      if (!result.ok) return result;
      return {
        ok: true,
        model: result.model,
        text: result.text,
        note: "Connessione riuscita: il servizio ha risposto correttamente."
      };
    })()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, code: "UNEXPECTED", error: String((err && err.message) || err) }));
    return true;
  }

  if (msg.type === "wa-tt/open-options") {
    browser.runtime
      .openOptionsPage()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  return undefined;
});
