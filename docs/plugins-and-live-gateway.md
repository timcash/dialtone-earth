# Plugins & Live Gateway (`metal.dialtone.earth`)

## Standalone Per-Repo Dialtone Plugins

`dialtone-earth` no longer carries the legacy Go `src/plugins/*` or `dialtone_mod` monorepo.

Modern Dialtone (`timcash/dialtone` v0.5.5+) packages plugins as standalone per-repo, content-addressed `iroh-blobs` binaries verified by SHA-256 digest and executed via **stdio RPC** (for example, [`timcash/dialtone-shell`](https://github.com/timcash/dialtone-shell) over `dialtone/shell/1`):

```sh
# Install a standalone plugin on a Dialtone node or across the mesh via timcash/net
dialtone install shell --repo timcash/dialtone-shell
net dialtone install shell --repo timcash/dialtone-shell

# Inspect, share by iroh-blobs ticket, or remove plugins
dialtone plugin list --json
dialtone plugin share shell
dialtone plugin remove shell
```

`dialtone.earth` displays live plugin deployments, SHA-256 digests, `iroh-blobs` store stats, and redacted `dialtone-shell` audit sessions via the read-only Cloudflare Worker gateway (`registry/worker/gateway.ts`) and `registry/src/live-adapter.ts`.

## Live Gateway Architecture (`registry/`)

- **Public Apex (`https://dialtone.earth/`):** Ships zero private network snapshots and runs a deterministic simulated tour with 3D H3 geospatial clusters, Holten + FDEB atmospheric ping arcs, whole-app tiling window manager, and a CSP-safe fullscreen TypeScript Camera Studio.
- **Private Network Gateway (`https://metal.dialtone.earth/`):** Authenticated via grayscale email magic links (`/login`, `/auth/verify`) or Cloudflare Access JWTs, proxying allowlisted `GET /api/mesh/*` routes to enrolled Dialtone origin nodes and persisting per-user window layouts, saved queries, and camera policies in Cloudflare KV (`/api/user/ui-config`).

### Connecting Enrolled `metal` Origin Nodes

Enrolled `metal` nodes expose a read-only Bearer-authenticated origin listener natively inside `timcash/dialtone` (no Node.js sidecar required):

```sh
DIALTONE_GATEWAY_TOKEN="<matching Cloudflare Worker MESH_ORIGIN_TOKEN>" \
dialtone up --gateway-listen 127.0.0.1:8790
```

For older `dialtone <= v0.5.5` nodes not yet upgraded to `--gateway-listen`, `registry/scripts/mesh-origin-bridge.mjs` remains available as a temporary fallback sidecar in front of `127.0.0.1:8788`:

```sh
MESH_ORIGIN_TOKEN="<matching Cloudflare Worker secret>" \
ORIGIN_BRIDGE_PORT=8790 \
DIALTONE_ORIGIN="http://127.0.0.1:8788" \
TEST_DASHBOARD_ORIGIN="http://127.0.0.1:5174" \
node registry/scripts/mesh-origin-bridge.mjs
```

### Automated Live Login & Gateway E2E Test

```sh
pnpm --dir registry test:live
```
