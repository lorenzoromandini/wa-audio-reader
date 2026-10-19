/**
 * Crea una build di sviluppo in build/dev/ che include anche la pagina finta
 * di WhatsApp (http://localhost:8787) così si può testare tutto senza toccare
 * l'account vero.
 *
 * Uso: node tools/dev-build.mjs
 * Poi: npx web-ext run --source-dir build/dev --start-url http://localhost:8787/test/mock-whatsapp.html
 *
 * Nota: nei match pattern delle WebExtension la porta non esiste, quindi
 * `http://localhost/*` vale per qualunque porta.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "build", "dev");
const devOrigins = ["http://localhost/*", "http://127.0.0.1/*"];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

for (const entry of manifest.content_scripts) {
  entry.matches = Array.from(new Set([...entry.matches, ...devOrigins]));
}
manifest.host_permissions = Array.from(new Set([...manifest.host_permissions, ...devOrigins]));

const isolated = manifest.content_scripts.find(
  (entry) => entry.world !== "MAIN" && entry.js.includes("src/content.js")
);
isolated.js.splice(isolated.js.indexOf("src/content.js"), 0, "test/dev-autoconfig.js");

writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));

for (const dir of ["src", "icons", "test"]) {
  cpSync(join(root, dir), join(out, dir), { recursive: true });
}

console.log("Build di sviluppo pronta in " + out);
