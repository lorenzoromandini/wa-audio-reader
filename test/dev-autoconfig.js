/**
 * Solo per le build di sviluppo (vedi tools/dev-build.mjs).
 * Preconfigura l'estensione per il finto server locale, così il test
 * end-to-end non richiede passaggi manuali.
 */
(() => {
  if (!/^https?:\/\/(localhost|127\.0\.0\.1):8787$/.test(location.origin)) return;

  const devSettings = {
    provider: "custom",
    endpoint: "http://localhost:8787/v1/audio/transcriptions",
    apiKey: "",
    model: "whisper-1",
    language: "auto",
    prompt: "",
    auto: false
  };

  globalThis.__WA_TT_DEV_SETTINGS__ = devSettings;

  try {
    browser.storage.local.set({ settings: devSettings });
  } catch (_) {}
})();
