/**
 * Test delle parti pure (funzionano in Node, senza browser) + una prova
 * end-to-end della richiesta di trascrizione contro il server finto.
 *
 * Uso: node --test tools/test-core.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startMockServer, MOCK_TRANSCRIPT } from "../test/mock-server.mjs";
import "../src/shared/core.js";

const Core = globalThis.WaTtCore;

test("normalizeEndpoint accetta base, /v1 ed endpoint completo", () => {
  assert.equal(
    Core.normalizeEndpoint("https://api.groq.com/openai/v1", "groq"),
    "https://api.groq.com/openai/v1/audio/transcriptions"
  );
  assert.equal(
    Core.normalizeEndpoint("http://localhost:8080", "custom"),
    "http://localhost:8080/v1/audio/transcriptions"
  );
  assert.equal(
    Core.normalizeEndpoint("http://localhost:8080/v1/", "custom"),
    "http://localhost:8080/v1/audio/transcriptions"
  );
  assert.equal(
    Core.normalizeEndpoint("https://example.com/v1/audio/transcriptions", "custom"),
    "https://example.com/v1/audio/transcriptions"
  );
  assert.equal(Core.normalizeEndpoint("", "openai"), Core.PROVIDERS.openai.endpoint);
  assert.equal(Core.normalizeEndpoint("", "custom"), "");
});

test("originPatternFor ignora percorso e porta", () => {
  assert.equal(Core.originPatternFor("http://localhost:8787/v1/audio/transcriptions"), "http://localhost/*");
  assert.equal(Core.originPatternFor("https://api.openai.com/v1/audio/transcriptions"), "https://api.openai.com/*");
  assert.equal(Core.originPatternFor("ftp://example.com"), "");
  assert.equal(Core.originPatternFor("non un url"), "");
});

test("extensionFor mappa i mime type dei vocali", () => {
  assert.equal(Core.extensionFor("audio/ogg; codecs=opus"), "ogg");
  assert.equal(Core.extensionFor("audio/mpeg"), "mp3");
  assert.equal(Core.extensionFor("audio/mp4"), "m4a");
  assert.equal(Core.extensionFor("audio/wav"), "wav");
  assert.equal(Core.extensionFor("audio/webm"), "webm");
  assert.equal(Core.extensionFor(""), "ogg");
});

test("responseText legge le varie forme di risposta", () => {
  assert.equal(Core.responseText({ text: "ciao" }), "ciao");
  assert.equal(Core.responseText({ transcription: "ehi" }), "ehi");
  assert.equal(Core.responseText({ transcripts: [{ text: "a" }, { text: "b" }] }), "a b");
  assert.equal(Core.responseText("  solo testo "), "solo testo");
  assert.equal(Core.responseText({}), "");
});

test("sanitizeSettings difende dai valori strani", () => {
  const clean = Core.sanitizeSettings({ provider: "pippo", apiKey: "  abc  ", auto: 1, language: "italiano" });
  assert.equal(clean.provider, Core.DEFAULTS.provider);
  assert.equal(clean.apiKey, "abc");
  assert.equal(clean.auto, true);
  assert.equal(clean.language, Core.DEFAULTS.language);
  assert.equal(Core.sanitizeSettings({ language: "auto" }).language, "auto");
});

test("providerConfigured capisce se manca la chiave o l'endpoint", () => {
  assert.equal(Core.providerConfigured({ provider: "groq", apiKey: "" }), false);
  assert.equal(Core.providerConfigured({ provider: "groq", apiKey: "gsk_x" }), true);
  assert.equal(Core.providerConfigured({ provider: "custom", endpoint: "" }), false);
  assert.equal(Core.providerConfigured({ provider: "custom", endpoint: "http://localhost:8080" }), true);
});

test("friendlyError produce messaggi comprensibili", () => {
  assert.match(Core.friendlyError(401, "", "Groq"), /Chiave API rifiutata/);
  assert.match(Core.friendlyError(404, "", "OpenAI"), /Endpoint non trovato/);
  assert.match(Core.friendlyError(429, "", "Groq"), /Troppe richieste/);
  assert.match(Core.friendlyError(500, "", "Groq"), /Errore del servizio/);
});

test("buildSilentWav genera un WAV PCM valido", () => {
  const wav = Core.buildSilentWav(0.5, 16000);
  assert.equal(wav.length, 44 + 16000 * 0.5 * 2);
  assert.equal(String.fromCharCode(wav[0], wav[1], wav[2], wav[3]), "RIFF");
  assert.equal(String.fromCharCode(wav[8], wav[9], wav[10], wav[11]), "WAVE");
});

test("base64 fa andata e ritorno senza perdere byte", () => {
  const original = new Uint8Array([0, 1, 2, 250, 255, 128, 64]);
  const back = Core.base64ToBytes(Core.bytesToBase64(original));
  assert.deepEqual(Array.from(back), Array.from(original));
});

test("richiesta end-to-end verso il server finto", async (t) => {
  const { server, port } = await startMockServer(0);
  t.after(() => server.close());

  const settings = Core.sanitizeSettings({
    provider: "custom",
    endpoint: "http://localhost:" + port + "/v1",
    model: "whisper-1",
    language: "it"
  });

  const endpoint = Core.normalizeEndpoint(settings.endpoint, settings.provider);
  assert.equal(endpoint, "http://localhost:" + port + "/v1/audio/transcriptions");

  const { form, model } = Core.buildTranscribeForm(settings, Core.buildSilentWav(0.4), "audio/wav");
  assert.equal(model, "whisper-1");

  const res = await fetch(endpoint, { method: "POST", body: form });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(Core.responseText(data), MOCK_TRANSCRIPT);
});
