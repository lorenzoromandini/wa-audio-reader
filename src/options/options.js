/**
 * Pagina impostazioni: sceglie il servizio, salva la configurazione e verifica
 * che la connessione funzioni davvero (con una richiesta di prova).
 */
"use strict";

const Core = globalThis.WaTtCore;

const $ = (selector) => document.querySelector(selector);

const els = {
  providers: $("#providers"),
  apiKey: $("#apiKey"),
  apiKeyLabel: document.querySelector('label[for="apiKey"]'),
  toggleKey: $("#toggle-key"),
  keyHint: $("#key-hint"),
  fieldEndpoint: $("#field-endpoint"),
  endpoint: $("#endpoint"),
  model: $("#model"),
  modelList: $("#model-list"),
  defaultModel: $("#default-model"),
  language: $("#language"),
  prompt: $("#prompt"),
  save: $("#save"),
  test: $("#test"),
  feedback: $("#feedback"),
  auto: $("#auto"),
  cacheInfo: $("#cache-info"),
  clearCache: $("#clear-cache"),
  version: $("#version")
};

let settings = Core.sanitizeSettings({});
let grantedOrigins = new Set();

// ------------------------------------------------------------- interfaccia

function feedback(message, kind) {
  if (!message) {
    els.feedback.hidden = true;
    els.feedback.textContent = "";
    return;
  }
  els.feedback.hidden = false;
  els.feedback.textContent = message;
  els.feedback.className = "feedback" + (kind === "error" ? " error" : kind === "ok" ? " ok" : "");
}

function setBusy(button, busy, busyText) {
  if (busy) {
    if (!button.dataset.idleLabel) button.dataset.idleLabel = button.textContent;
    button.disabled = true;
    button.textContent = busyText;
  } else {
    button.disabled = false;
    if (button.dataset.idleLabel) button.textContent = button.dataset.idleLabel;
  }
}

function buildProviders() {
  els.providers.replaceChildren();
  ["groq", "openai", "custom"].forEach((id) => {
    const provider = Core.PROVIDERS[id];
    const label = document.createElement("label");
    label.className = "provider";

    const input = document.createElement("input");
    input.type = "radio";
    input.name = "provider";
    input.value = id;

    const title = document.createElement("span");
    title.className = "provider-title";
    title.append(document.createTextNode(provider.label));
    if (provider.badge) {
      const badge = document.createElement("span");
      badge.className = "provider-badge";
      badge.textContent = provider.badge;
      title.append(badge);
    }

    const note = document.createElement("span");
    note.className = "provider-note";
    note.textContent = provider.note;

    label.append(input, title, note);
    input.addEventListener("change", () => {
      updateProviderUI();
      feedback("");
      informPermission();
    });
    els.providers.append(label);
  });
}

function buildLanguages() {
  els.language.replaceChildren();
  Core.LANGUAGES.forEach((language) => {
    const option = document.createElement("option");
    option.value = language.code;
    option.textContent = language.label;
    els.language.append(option);
  });
}

function currentProvider() {
  const checked = document.querySelector('input[name="provider"]:checked');
  return checked ? checked.value : settings.provider;
}

function updateProviderUI() {
  const id = currentProvider();
  const provider = Core.PROVIDERS[id];

  els.fieldEndpoint.hidden = id !== "custom";
  els.apiKeyLabel.textContent = id === "custom" ? "Chiave API (facoltativa)" : "Chiave API";

  els.defaultModel.textContent = provider.defaultModel;
  els.model.placeholder = provider.defaultModel;
  els.modelList.replaceChildren();
  provider.models.forEach((model) => {
    const option = document.createElement("option");
    option.value = model;
    els.modelList.append(option);
  });

  els.keyHint.replaceChildren();
  if (provider.keyRequired && provider.keyUrl) {
    els.keyHint.append(document.createTextNode("Serve una chiave API: "));
    const link = document.createElement("a");
    link.href = provider.keyUrl;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = provider.keyUrl.replace(/^https?:\/\//, "");
    els.keyHint.append(link, document.createTextNode("."));
  } else if (id === "custom") {
    els.keyHint.append(
      document.createTextNode(
        "Se il server locale non richiede autenticazione, lascia vuoto. Esempi: whisper.cpp, faster-whisper, Speaches."
      )
    );
  }
}

function readForm() {
  const provider = currentProvider();
  return Core.sanitizeSettings({
    provider,
    apiKey: els.apiKey.value,
    endpoint: provider === "custom" ? els.endpoint.value : "",
    model: els.model.value,
    language: els.language.value,
    prompt: els.prompt.value,
    auto: els.auto.checked
  });
}

function validate(data) {
  const provider = Core.providerOf(data);
  if (provider.keyRequired && !data.apiKey) return "Inserisci la chiave API.";
  const endpoint = Core.normalizeEndpoint(data.endpoint, data.provider);
  if (!endpoint) return "Inserisci l'URL del server.";
  if (!Core.originPatternFor(endpoint)) return "L'URL del server non è valido: deve iniziare con http:// o https://.";
  return "";
}

function patternFor(data) {
  return Core.originPatternFor(Core.normalizeEndpoint(data.endpoint, data.provider));
}

async function informPermission() {
  const data = readForm();
  if (!Core.providerConfigured(data)) {
    feedback("");
    return;
  }
  const pattern = patternFor(data);
  if (!pattern) return;
  if (grantedOrigins.has(pattern)) {
    feedback("");
    return;
  }
  feedback(
    "Serve l'autorizzazione per " + pattern + ": premi «Salva impostazioni» e conferma la richiesta di Firefox.",
    "info"
  );
}

async function persist(data) {
  await browser.storage.local.set({ [Core.SETTINGS_KEY]: data });
  settings = data;
  feedback("Impostazioni salvate.", "ok");
}

async function refreshCacheInfo() {
  try {
    const all = await browser.storage.local.get(null);
    const keys = Object.keys(all).filter(Core.isCacheKey);
    if (!keys.length) {
      els.cacheInfo.textContent = "Nessuna trascrizione salvata al momento.";
      return;
    }
    let last = 0;
    keys.forEach((key) => {
      const ts = all[key] && all[key].ts ? all[key].ts : 0;
      if (ts > last) last = ts;
    });
    const when = last
      ? " · ultima: " + new Date(last).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" })
      : "";
    els.cacheInfo.textContent = keys.length + " trascrizioni salvate" + when + ".";
  } catch (_) {
    els.cacheInfo.textContent = "";
  }
}

// ------------------------------------------------------------------ eventi

els.toggleKey.addEventListener("click", () => {
  const showing = els.apiKey.type === "text";
  els.apiKey.type = showing ? "password" : "text";
  els.toggleKey.textContent = showing ? "Mostra" : "Nascondi";
});

els.save.addEventListener("click", () => {
  const data = readForm();
  const error = validate(data);
  if (error) {
    feedback(error, "error");
    return;
  }
  const pattern = patternFor(data);

  // La richiesta di permesso deve avvenire dentro il gesto utente: la
  // lanciamo subito, senza await prima.
  const request = browser.permissions.request({ origins: [pattern] }).catch(() => false);
  setBusy(els.save, true, "Salvo…");

  request
    .then(async (granted) => {
      if (!granted) {
        setBusy(els.save, false);
        feedback(
          "Permesso negato per " + pattern + ". Senza autorizzazione la trascrizione non può funzionare.",
          "error"
        );
        return;
      }
      grantedOrigins.add(pattern);
      await persist(data);
      setBusy(els.save, false);
      feedback("Impostazioni salvate. Il servizio è autorizzato e pronto.", "ok");
    })
    .catch((err) => {
      setBusy(els.save, false);
      feedback(String((err && err.message) || err), "error");
    });
});

els.test.addEventListener("click", () => {
  const data = readForm();
  const error = validate(data);
  if (error) {
    feedback(error, "error");
    return;
  }
  const pattern = patternFor(data);

  const request = browser.permissions.request({ origins: [pattern] }).catch(() => false);
  setBusy(els.test, true, "Verifico…");

  request
    .then((granted) => {
      if (!granted) {
        setBusy(els.test, false);
        feedback("Permesso negato per " + pattern + ".", "error");
        return null;
      }
      grantedOrigins.add(pattern);
      return browser.runtime.sendMessage({ type: "wa-tt/test", settings: data });
    })
    .then((res) => {
      setBusy(els.test, false);
      if (!res) return;
      if (res.ok) feedback(res.note || "Connessione riuscita.", "ok");
      else feedback(res.error || "Verifica non riuscita.", "error");
    })
    .catch((err) => {
      setBusy(els.test, false);
      feedback(String((err && err.message) || err), "error");
    });
});

els.auto.addEventListener("change", async () => {
  const data = Core.sanitizeSettings(Object.assign(readForm(), { auto: els.auto.checked }));
  await browser.storage.local.set({ [Core.SETTINGS_KEY]: data });
  settings = data;
  feedback(els.auto.checked ? "Trascrizione automatica attivata." : "Trascrizione automatica disattivata.", "ok");
});

els.clearCache.addEventListener("click", async () => {
  try {
    const all = await browser.storage.local.get(null);
    const keys = Object.keys(all).filter(Core.isCacheKey);
    if (keys.length) await browser.storage.local.remove(keys);
    await refreshCacheInfo();
    feedback(keys.length ? "Trascrizioni cancellate (" + keys.length + ")." : "Non c'era nulla da cancellare.", "ok");
  } catch (err) {
    feedback(String((err && err.message) || err), "error");
  }
});

// -------------------------------------------------------------------- avvio

(async () => {
  buildProviders();
  buildLanguages();

  try {
    const got = await browser.storage.local.get(Core.SETTINGS_KEY);
    settings = Core.sanitizeSettings(got[Core.SETTINGS_KEY]);
  } catch (_) {}

  const radio = document.querySelector('input[name="provider"][value="' + settings.provider + '"]');
  if (radio) radio.checked = true;
  els.apiKey.value = settings.apiKey;
  els.endpoint.value = settings.endpoint;
  els.model.value = settings.model;
  els.language.value = settings.language;
  els.prompt.value = settings.prompt;
  els.auto.checked = settings.auto;

  updateProviderUI();

  try {
    const permissions = await browser.permissions.getAll();
    grantedOrigins = new Set(permissions.origins || []);
  } catch (_) {}

  els.version.textContent = "versione " + browser.runtime.getManifest().version;

  await refreshCacheInfo();
  await informPermission();
})();
