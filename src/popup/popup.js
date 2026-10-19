/**
 * Popup della barra strumenti: stato rapido, interruttore dell'automatico,
 * scorciatoia alle impostazioni e pulizia della cache.
 */
"use strict";

const Core = globalThis.WaTtCore;

const statusEl = document.getElementById("status");
const providerLine = document.getElementById("provider-line");
const autoEl = document.getElementById("auto");
const openOptions = document.getElementById("open-options");
const clearCache = document.getElementById("clear-cache");
const cacheNote = document.getElementById("cache-note");

let settings = Core.sanitizeSettings({});

function setPill(text, kind) {
  statusEl.textContent = text;
  statusEl.className = "pill" + (kind ? " " + kind : "");
}

async function refresh() {
  try {
    const got = await browser.storage.local.get(Core.SETTINGS_KEY);
    settings = Core.sanitizeSettings(got[Core.SETTINGS_KEY]);
  } catch (_) {}

  const provider = Core.providerOf(settings);
  providerLine.textContent = provider.label + " · " + Core.modelFor(settings);

  if (!Core.providerConfigured(settings)) {
    setPill("Da configurare", "warn");
  } else {
    const pattern = Core.originPatternFor(Core.normalizeEndpoint(settings.endpoint, settings.provider));
    let granted = false;
    try {
      granted = pattern ? await browser.permissions.contains({ origins: [pattern] }) : false;
    } catch (_) {}
    setPill(granted ? "Pronto" : "Serve autorizzazione", granted ? "ok" : "warn");
  }

  autoEl.checked = settings.auto;

  try {
    const all = await browser.storage.local.get(null);
    const count = Object.keys(all).filter(Core.isCacheKey).length;
    cacheNote.textContent = count
      ? count + " trascrizioni salvate nel browser."
      : "Nessuna trascrizione salvata.";
  } catch (_) {
    cacheNote.textContent = "";
  }
}

autoEl.addEventListener("change", async () => {
  settings = Core.sanitizeSettings(Object.assign({}, settings, { auto: autoEl.checked }));
  try {
    await browser.storage.local.set({ [Core.SETTINGS_KEY]: settings });
  } catch (_) {}
  // refresh() ricalcola anche lo stato (configurazione e permessi), che non
  // dipende dall'interruttore appena mosso.
  await refresh();
});

openOptions.addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});

clearCache.addEventListener("click", async () => {
  try {
    const all = await browser.storage.local.get(null);
    const keys = Object.keys(all).filter(Core.isCacheKey);
    if (keys.length) await browser.storage.local.remove(keys);
    cacheNote.textContent = keys.length
      ? "Cache svuotata (" + keys.length + " trascrizioni)."
      : "Non c'era nulla da cancellare.";
  } catch (err) {
    cacheNote.textContent = String((err && err.message) || err);
  }
});

refresh();
