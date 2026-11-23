import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const registryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("public _headers defines required static-site security headers", async () => {
  const headersText = await readFile(
    path.join(registryRoot, "public", "_headers"),
    "utf8",
  );
  assert.match(headersText, /^\/\*\r?\n/m, "headers must apply to /*");
  for (const directive of [
    "Strict-Transport-Security:",
    "X-Content-Type-Options: nosniff",
    "X-Frame-Options: DENY",
    "Referrer-Policy: strict-origin-when-cross-origin",
    "Content-Security-Policy:",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ]) {
    assert.ok(
      headersText.includes(directive),
      `public/_headers is missing ${directive}`,
    );
  }
});

test("wrangler serves real 404 pages for unknown paths instead of SPA fallback", async () => {
  const wranglerRaw = await readFile(
    path.join(registryRoot, "wrangler.jsonc"),
    "utf8",
  );
  const config = JSON.parse(wranglerRaw);
  assert.equal(config.assets?.not_found_handling, "404-page");

  const notFoundHtml = await readFile(
    path.join(registryRoot, "public", "404.html"),
    "utf8",
  );
  assert.match(notFoundHtml, /404/i);
});

test("public apex ships zero static network snapshots and never fetches /networks/ anonymously", async () => {
  await assert.rejects(
    access(path.join(registryRoot, "public", "networks")),
    { code: "ENOENT" },
    "registry/public/networks must not exist on the public apex (#374)",
  );

  const mainTs = await readFile(
    path.join(registryRoot, "src", "main.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    mainTs,
    /\/networks\//,
    "public main.ts must not fetch /networks/ anonymously",
  );
  assert.doesNotMatch(
    mainTs,
    /\/n\//,
    "public main.ts must not serve anonymous /n/<network> routes",
  );

  const publicFiles = await listFiles(path.join(registryRoot, "public"));
  for (const file of publicFiles) {
    if (file.endsWith(".json") && !file.endsWith("land.h3.json")) {
      assert.fail(`unexpected public JSON data file shipped on apex: ${file}`);
    }
    if (file.endsWith(".html") || file.endsWith("_headers") || file.endsWith(".svg")) {
      const content = await readFile(file, "utf8");
      for (const forbidden of [
        "metal.json",
        "grok-bot-metal",
        "legion-metal",
        "vm-us",
        "vm-eu",
        "vm-asia",
      ]) {
        assert.ok(
          !content.includes(forbidden),
          `public asset ${file} leaks private identifier ${forbidden}`,
        );
      }
    }
  }
});

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}
