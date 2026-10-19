/**
 * Funzioni e costanti condivise fra background, content script, popup e pagina
 * impostazioni. Nessuna dipendenza esterna: questo file viene caricato come
 * script semplice dentro l'estensione, ma può essere importato anche da Node
 * (serve per i test in tools/test-core.mjs).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.WaTtCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SETTINGS_KEY = "settings";
  const CACHE_PREFIX = "waTt:tx:";
  const CACHE_LIMIT = 600;
  const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

  const DEFAULTS = {
    provider: "groq",
    apiKey: "",
    endpoint: "",
    model: "",
    language: "it",
    prompt: "",
    auto: false
  };

  const PROVIDERS = {
    groq: {
      id: "groq",
      label: "Groq",
      endpoint: "https://api.groq.com/openai/v1/audio/transcriptions",
      defaultModel: "whisper-large-v3-turbo",
      models: ["whisper-large-v3-turbo", "whisper-large-v3"],
      keyRequired: true,
      keyUrl: "https://console.groq.com/keys",
      badge: "consigliato",
      note: "Piano gratuito con limiti generosi e trascrizione molto veloce."
    },
    openai: {
      id: "openai",
      label: "OpenAI",
      endpoint: "https://api.openai.com/v1/audio/transcriptions",
      defaultModel: "gpt-4o-mini-transcribe",
      models: ["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"],
      keyRequired: true,
      keyUrl: "https://platform.openai.com/api-keys",
      badge: "",
      note: "Qualità alta e ottimo italiano, a consumo (pochi centesimi per vocale)."
    },
    custom: {
      id: "custom",
      label: "Server locale / personalizzato",
      endpoint: "",
      defaultModel: "whisper-1",
      models: ["whisper-1", "Systran/faster-whisper-small", "Systran/faster-whisper-medium", "large-v3-turbo"],
      keyRequired: false,
      keyUrl: "",
      badge: "privacy",
      note: "L'audio non lascia il computer. Serve un server OpenAI-compatibile (whisper.cpp, faster-whisper, Speaches…)."
    }
  };

  const LANGUAGES = [
    { code: "auto", label: "Rileva automaticamente" },
    { code: "it", label: "Italiano" },
    { code: "en", label: "Inglese" },
    { code: "es", label: "Spagnolo" },
    { code: "fr", label: "Francese" },
    { code: "de", label: "Tedesco" },
    { code: "pt", label: "Portoghese" },
    { code: "nl", label: "Olandese" },
    { code: "pl", label: "Polacco" },
    { code: "ro", label: "Rumeno" },
    { code: "ar", label: "Arabo" },
    { code: "zh", label: "Cinese" },
    { code: "ja", label: "Giapponese" },
    { code: "ko", label: "Coreano" },
    { code: "ru", label: "Russo" },
    { code: "tr", label: "Turco" }
  ];

  // -------------------------------------------------------------- settings

  function sanitizeSettings(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    const provider = Object.prototype.hasOwnProperty.call(PROVIDERS, src.provider)
      ? src.provider
      : DEFAULTS.provider;
    const clean = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
    return {
      provider,
      apiKey: clean(src.apiKey, 400),
      endpoint: clean(src.endpoint, 500),
      model: clean(src.model, 200),
      language: /^[a-z]{2}(-[A-Za-z]{2})?$/.test(String(src.language || "")) || src.language === "auto"
        ? String(src.language)
        : DEFAULTS.language,
      prompt: clean(src.prompt, 800),
      auto: !!src.auto
    };
  }

  function providerOf(settings) {
    return PROVIDERS[(settings && settings.provider) || DEFAULTS.provider] || PROVIDERS.groq;
  }

  function providerLabel(settings) {
    return providerOf(settings).label;
  }

  function providerConfigured(settings) {
    const s = sanitizeSettings(settings);
    if (s.provider === "custom") return !!normalizeEndpoint(s.endpoint, s.provider);
    return !!s.apiKey;
  }

  function modelFor(settings) {
    const s = sanitizeSettings(settings);
    return s.model || providerOf(s).defaultModel;
  }

  // ------------------------------------------------------------- endpoints

  /**
   * Accetta sia l'endpoint completo sia la sola base e restituisce sempre
   * l'URL della rotta OpenAI `/audio/transcriptions`.
   */
  function normalizeEndpoint(input, providerId) {
    let raw = String(input == null ? "" : input).trim();
    if (!raw) {
      const preset = PROVIDERS[providerId];
      raw = preset ? preset.endpoint : "";
    }
    if (!raw) return "";
    raw = raw.replace(/\/+$/, "");
    if (/\/audio\/transcriptions$/i.test(raw)) return raw;
    if (/\/(openai\/v\d+|v\d+)$/i.test(raw)) return raw + "/audio/transcriptions";
    return raw + "/v1/audio/transcriptions";
  }

  function originPatternFor(urlStr) {
    try {
      const u = new URL(String(urlStr));
      if (u.protocol !== "http:" && u.protocol !== "https:") return "";
      return u.protocol + "//" + u.hostname + "/*";
    } catch (_) {
      return "";
    }
  }

  function extensionFor(mimeType) {
    const t = String(mimeType || "").toLowerCase();
    if (t.includes("ogg") || t.includes("opus")) return "ogg";
    if (t.includes("mpeg") || t.includes("mp3")) return "mp3";
    if (t.includes("mp4") || t.includes("m4a") || t.includes("aac")) return "m4a";
    if (t.includes("wav") || t.includes("wave")) return "wav";
    if (t.includes("webm")) return "webm";
    if (t.includes("flac")) return "flac";
    return "ogg";
  }

  // ------------------------------------------------------------- risposte

  function responseText(data) {
    if (typeof data === "string") return data.trim();
    if (!data || typeof data !== "object") return "";
    if (typeof data.text === "string" && data.text.trim()) return data.text.trim();
    if (typeof data.transcription === "string" && data.transcription.trim()) return data.transcription.trim();
    if (Array.isArray(data.transcripts)) {
      return data.transcripts
        .map((t) => (t && typeof t.text === "string" ? t.text : ""))
        .join(" ")
        .trim();
    }
    if (Array.isArray(data.segments)) {
      return data.segments
        .map((s) => (s && typeof s.text === "string" ? s.text : ""))
        .join(" ")
        .trim();
    }
    return "";
  }

  function cleanDetail(text) {
    if (!text) return "";
    let t = String(text).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (t.length > 180) t = t.slice(0, 177) + "…";
    return t;
  }

  function friendlyError(status, detail, serviceLabel) {
    const label = serviceLabel || "il servizio";
    const snippet = cleanDetail(detail);
    const withDetail = (msg) => (snippet ? msg + " (" + snippet + ")" : msg);
    if (status === 401 || status === 403) {
      return withDetail("Chiave API rifiutata da " + label + ". Controlla la chiave nelle impostazioni.");
    }
    if (status === 404) return withDetail("Endpoint non trovato (404). Controlla l'URL del servizio.");
    if (status === 413) return withDetail("L'audio è troppo grande per il servizio.");
    if (status === 429) return withDetail("Troppe richieste (429): riprova fra qualche secondo.");
    if (status === 400 || status === 422) {
      return withDetail("Richiesta rifiutata (" + status + "). Verifica modello, lingua e formato audio.");
    }
    if (status >= 500) return withDetail("Errore del servizio (" + status + "). Riprova fra poco.");
    return withDetail("Errore " + status + " da " + label + ".");
  }

  // ---------------------------------------------------------------- audio

  /**
   * WAV PCM 16 bit mono con silenzio: serve solo a verificare che la
   * configurazione funzioni davvero, senza consumare credito reale.
   */
  function buildSilentWav(durationSec, sampleRate) {
    const seconds = typeof durationSec === "number" && durationSec > 0 ? durationSec : 0.4;
    const rate = sampleRate || 16000;
    const samples = Math.max(1, Math.round(rate * seconds));
    const dataSize = samples * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const writeAscii = (offset, text) => {
      for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };
    writeAscii(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeAscii(8, "WAVE");
    writeAscii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(36, "data");
    view.setUint32(40, dataSize, true);
    return new Uint8Array(buffer);
  }

  function base64ToBytes(base64) {
    const clean = String(base64 || "");
    if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(clean, "base64"));
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToBase64(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (typeof Buffer !== "undefined") return Buffer.from(data).toString("base64");
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < data.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, data.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  /**
   * Costruisce il corpo multipart per un endpoint OpenAI-compatibile.
   * Sta qui (e non nel background) così è testabile anche da Node.
   */
  function buildTranscribeForm(settings, bytes, mimeType) {
    const clean = sanitizeSettings(settings);
    const type = mimeType || "audio/ogg";
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: type }), "vocale." + extensionFor(type));
    form.append("model", modelFor(clean));
    if (clean.language && clean.language !== "auto") form.append("language", clean.language);
    if (clean.prompt) form.append("prompt", clean.prompt.slice(0, 800));
    form.append("response_format", "json");
    return { form, model: modelFor(clean) };
  }

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1).replace(".0", "") + " KB";
    return (n / (1024 * 1024)).toFixed(1).replace(".0", "") + " MB";
  }

  function isCacheKey(key) {
    return typeof key === "string" && key.indexOf(CACHE_PREFIX) === 0;
  }

  function cacheKeyFor(messageId) {
    return CACHE_PREFIX + String(messageId || "");
  }

  return {
    SETTINGS_KEY,
    CACHE_PREFIX,
    CACHE_LIMIT,
    MAX_AUDIO_BYTES,
    DEFAULTS,
    PROVIDERS,
    LANGUAGES,
    sanitizeSettings,
    providerOf,
    providerLabel,
    providerConfigured,
    modelFor,
    normalizeEndpoint,
    originPatternFor,
    extensionFor,
    responseText,
    cleanDetail,
    friendlyError,
    buildSilentWav,
    base64ToBytes,
    bytesToBase64,
    buildTranscribeForm,
    formatBytes,
    isCacheKey,
    cacheKeyFor
  };
});
