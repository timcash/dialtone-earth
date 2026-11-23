import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
