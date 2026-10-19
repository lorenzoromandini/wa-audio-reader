/**
 * Finto servizio di trascrizione OpenAI-compatibile, + servizio della pagina
 * finta di WhatsApp e raccolta del risultato del test end-to-end.
 *
 * Uso: node test/mock-server.mjs   (porta 8787, oppure PORT=…)
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const MOCK_TRANSCRIPT =
  "Ciao, questo è un vocale di prova trascritto dal finto server. Se leggi questo testo, l'estensione funziona.";

function send(res, status, body, type) {
  res.writeHead(status, {
    "content-type": type || "text/plain; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

export function startMockServer(port = 8787) {
  let lastResult = "";

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost:" + port);

    if (
      req.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/test/mock-whatsapp.html" || url.pathname === "/demo")
    ) {
      try {
        const html = await readFile(join(root, "test", "mock-whatsapp.html"), "utf8");
        return send(res, 200, html, "text/html; charset=utf-8");
      } catch (err) {
        return send(res, 500, String(err), "text/plain");
      }
    }

    if (url.pathname === "/health") return send(res, 200, "ok");

    if (req.method === "POST" && url.pathname === "/v1/audio/transcriptions") {
      let bytes = 0;
      for await (const chunk of req) bytes += chunk.length;
      console.log("[mock] audio ricevuto: " + bytes + " byte");
      if (!bytes) {
        return send(res, 400, JSON.stringify({ error: { message: "file mancante" } }), "application/json");
      }
      return send(
        res,
        200,
        JSON.stringify({ text: MOCK_TRANSCRIPT, model: "mock-whisper" }),
        "application/json"
      );
    }

    if (url.pathname === "/result") {
      if (req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        lastResult = body.trim();
        console.log("[mock] risultato del test: " + lastResult);
        return send(res, 200, "ok");
      }
      if (req.method === "GET") {
        return send(res, lastResult ? 200 : 404, lastResult || "nessun risultato");
      }
    }

    return send(res, 404, "not found");
  });

  return new Promise((resolvePromise) => {
    server.listen(port, () => {
      const actual = server.address().port;
      console.log("[mock] in ascolto su http://localhost:" + actual);
      resolvePromise({ server, port: actual });
    });
  });
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  startMockServer(Number(process.env.PORT || 8787));
}
