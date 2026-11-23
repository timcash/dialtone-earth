import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';

// Real built-site HTTP contract. Browser installability and an actual iOS
// Add to Home Screen gesture are separate acceptance checks.
test('built PWA serves manifest, app entry, and valid installation icons', { timeout: 30000 }, async () => {
  const server = await preview({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, preview: {host: '127.0.0.1', port: 0, strictPort: true} });
  try {
    const port = server.httpServer.address().port;
    const origin = `http://127.0.0.1:${port}`;
    const get = async (path) => {
      const u = new URL(path, origin);
      assert.equal(u.origin, origin, 'assets must be same-origin');
      const response = await fetch(u, {redirect: 'error', signal: AbortSignal.timeout(5000)});
      assert.equal(response.status, 200, `GET ${path}`);
      return response;
    };
    const html = await (await get('/')).text();
    assert.match(html, /<link[^>]+rel="manifest"[^>]+href="\/manifest.webmanifest"/);
    assert.match(html, /<link[^>]+rel="apple-touch-icon"[^>]+href="\/icons\/apple-touch-icon.png"/);
    const response = await get('/manifest.webmanifest');
    assert.match(response.headers.get('content-type'), /json|manifest/);
    const manifest = await response.json();
    assert.ok(manifest.name && manifest.short_name);
    assert.equal(manifest.id, '/');
    assert.equal(manifest.start_url, '/');
    assert.equal(manifest.scope, '/');
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.prefer_related_applications, false);
    assert.match(await (await get(manifest.start_url)).text(), /id="app"/);
    for (const size of [192,512]) {
      const icon = manifest.icons.find(icon => icon.sizes === `${size}x${size}`);
      assert.ok(icon, `missing ${size} icon`);
      assert.equal(icon.type, 'image/png');
      const image = await get(icon.src);
      assert.match(image.headers.get('content-type'), /image\/png/);
      const bytes = Buffer.from(await image.arrayBuffer());
      assert.equal(bytes.subarray(0,8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(bytes.readUInt32BE(16), size);
      assert.equal(bytes.readUInt32BE(20), size);
    }
    const appleResponse = await get('/icons/apple-touch-icon.png');
    assert.match(appleResponse.headers.get('content-type'), /image\/png/);
    const apple = Buffer.from(await appleResponse.arrayBuffer());
    assert.equal(apple.subarray(0,8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(apple.readUInt32BE(16), 180);
    assert.equal(apple.readUInt32BE(20), 180);
  } finally { await server.close(); }
});
