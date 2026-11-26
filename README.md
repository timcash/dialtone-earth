![Dialtone logo](docs/dialtone-logo.svg)

# Dialtone Earth

Self-hosted **Cloudflare Workers + R2 + KV** and **Iroh 1.5 P2P** control plane for code hosting, signed releases, fleet auto-updates, public plugins, and live 3D mesh telemetry — with **zero GitHub** and **zero Tailscale** dependencies.

---

## 1. Install (Directly from Cloudflare R2 — Zero GitHub)

Install the `dialtone-earth` CLI binary into `~/.local/bin` (macOS/Linux) or `%USERPROFILE%\.local\bin` (Windows) without touching shell profiles or system `PATH`:

Linux / macOS:

```sh
curl -fsSL https://dialtone.earth/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://dialtone.earth/install.ps1 | iex
```

Both installers pull binaries and `.sha256` checksums directly from **`https://dialtone.earth/releases/dialtone-earth/download/<tag>/<asset>`** (hosted on Cloudflare R2) and verify SHA-256 digests before installing.

---

## 2. How the Cloudflare Code, Release & Auto-Update System Works (No GitHub)

Every function that used to depend on GitHub — private git storage, source archives, tagged binary releases, fleet auto-update feeds, and public plugin discovery — runs directly inside the **`dialtone-earth` Cloudflare Worker** backed by **Cloudflare R2** (`dialtone-earth-registry`) and **Cloudflare KV** (`DIALTONE_AUTH_TOKENS`).

| Layer | Technology | Role |
| :--- | :--- | :--- |
| **Mesh & Plugins** | **Rust + Iroh 1.5** (`dialtone`, `dialtone-shell`) | Direct QUIC + `mdns-local` LAN + N0 relay mesh (`exclude_tailnet: true`). Plugins are SHA-256/BLAKE3 content-addressed `iroh-blobs` binaries over stdio RPC. |
| **Private Git & Archives** | **Cloudflare R2 + KV** (`/api/code/*`) | Owner-only (`timcash@gmail.com`) git bundle storage (`git bundle`, `X-Dialtone-Shallow` aware) plus `main.tar.gz` and `main.zip` archives. |
| **Releases & Auto-Update Feeds** | **Cloudflare R2 + KV** (`/releases/*`, `/api/releases/*`) | SHA-256-verified cross-compiled binaries and signed `dialtone-release.json` + `.sig` manifests with isolated `channel/test` and production `latest` channels. |
| **Public Plugin Catalog** | **Cloudflare R2 + KV** (`/api/plugins/*`) | Public manifest, SHA-256/BLAKE3 hashes, R2 download URLs, and live `iroh-blobs://` tickets (e.g., `dialtone-shell`). |
| **Operator CLI & Staging UI** | **Pure-stdlib Go CLI** (`dialtone-earth`) + **Vite UI** (`ui/`) | Pushes code/releases to R2, runs isolated `test`-channel staging tests with wide + mobile projected Chrome browsers, gates deploys cryptographically, and verifies production live after deploy. |

### 2.1 Private Owner-Only Git Hosting on Cloudflare R2 (`/api/code/*`)

All code endpoints — **both reads and writes** — require owner authentication (`timcash@gmail.com` magic-link session cookie or `Authorization: Bearer <LIVE_CONTROL_TOKEN>`). Anonymous users and non-owner accounts receive `401` / `403`.

- **Push (`dialtone-earth code push`)**: Packs `HEAD`, the active branch ref, and tags into a compact `git bundle` (propagating `.git/shallow` via `X-Dialtone-Shallow` when shallow), uploads it to R2 at `code/<repo>/bundles/<branch>.bundle`, records commit metadata in KV, and optionally uploads `main.tar.gz` and `main.zip`.
- **Clone (`dialtone-earth code clone <repo> [dir]`)**: Downloads the owner-authenticated git bundle from R2, reconstructs `.git/shallow` if present, and checks out full commit history and tags with zero GitHub remotes.
- **Pull (`dialtone-earth code pull`)**: Fetches the latest R2 bundle into `refs/remotes/cloudflare/<branch>` and fast-forwards your local branch.

### 2.2 Tagged Releases & Fleet Auto-Update Channels (`/releases/*`)

1. **Tagging & cross-compiling (`dialtone-earth release tag vX.Y.Z --build`)**:
   - Tags `HEAD`, pushes the repo bundle to R2, cross-compiles all 6 platform binaries (Windows/Linux/macOS × amd64/arm64), uploads each binary to R2, and serves SHA-256 checksums at `/releases/<repo>/download/<tag>/<asset>.sha256`.
2. **Channel-scoped auto-updates for `dialtone` nodes**:
   - `dialtone` nodes default to **`https://dialtone.earth/releases/dialtone`** (with `DIALTONE_UPDATE_CHANNEL=test` resolving to **`https://dialtone.earth/releases/dialtone/channel/test`**).
   - Staging nodes on the `test` channel pull signed manifests from `/releases/dialtone/channel/test/latest/download/dialtone-release.json` (+ `.sig`) and test the new binary safely without touching production users.
   - When you click **`deploy`** from `test.dialtone.earth` (or run `dialtone-earth release channel promote`), the Worker atomically promotes `channel/test` → `latest` (`POST /api/releases/dialtone/channel/latest`).
   - Production `dialtone` nodes with auto-update enabled automatically detect the new signed manifest, verify the Ed25519 signature + SHA-256, A/B install and trial it (rolling back to `dialtone.prev` if unhealthy), and share the verified binary peer-to-peer over `iroh-blobs`.

### 2.3 Cloudflare API Endpoints & Access Matrix (`https://dialtone.earth`)

| Endpoint | Access | Purpose |
| :--- | :--- | :--- |
| `GET/PUT /api/code`, `/api/code/<repo>`, `/push`, `/bundle`, `/archive/<file>` | **Owner-only** (`timcash@gmail.com` / Bearer) | Private git bundle & source archive storage on R2 |
| `GET /api/releases/<repo>`, `/api/releases/<repo>/channels`, `/releases/<repo>/...` | Public read | Release listings, `latest` & `channel/<ch>` auto-update manifests, binaries & `.sha256` |
| `POST/PUT /api/releases/<repo>/<tag>`, `/assets/<asset>`, `/channel/<ch>` | **Owner-only** | Publish release assets and promote `test` → `latest` |
| `GET /api/plugins`, `/api/plugins/<name>`, `/download/<asset>` | Public read | Public Dialtone plugin catalog (`dialtone-shell`, `iroh-blobs://` tickets) |
| `PUT/POST /api/plugins/<name>`, `/assets/<asset>` | **Owner-only** | Publish plugin manifests and binaries to R2 |
| `PATCH/DELETE /api/live` | **Owner-only** | Live site overrides (`GET /api/live` is public) |
| `https://test.dialtone.earth/*` | **Owner-only** (Cloudflare Access + Worker check) | Staging control plane proxied to local test dashboard |
| `https://metal.dialtone.earth/api/mesh/*` | **Mesh-authenticated** (magic link allowlist) | Read-only live Dialtone mesh gateway + Cloudflare KV user config |

---

## 3. Isolated Staging & End-to-End CI/CD Loop (`test.dialtone.earth` → `dialtone.earth`)

Production **`https://dialtone.earth/`** never auto-deploys on file saves. All development flows through a 5-stage pipeline tracked in the greyscale Test UI (`http://127.0.0.1:5174/` and owner-only **`https://test.dialtone.earth/`**):

```text
1.EDIT  →  2.STAGING TESTS (isolated test channel)  →  3.READY  →  4.DEPLOY  →  5.PROD VERIFY
```

1. **Edit locally on your developer machine** (`live watch` watches `registry/src` and `registry/worker` in staging-only mode with `--deploy-on-pass=false`).
2. **Isolated Staging Environment (zero overlap with production `metal`)**:
   - **Isolated 2-node Iroh `test` channel**: `test-alpha` (`127.0.0.1:8798`, `~/.dialtone-test-alpha`, with verified `dialtone-shell`) and `test-beta` (`127.0.0.1:8799`, `~/.dialtone-test-beta`) running `--channel test` over live Iroh QUIC gossip. Your production `metal` channel (`127.0.0.1:8788`, `~/.dialtone`) is untouched.
   - **Isolated Staging Preview (`http://127.0.0.1:5175/`)**: [staging-preview-server.mjs](registry/scripts/staging-preview-server.mjs) serves freshly built `registry/dist/` through the unpromoted local [gateway.ts](registry/worker/gateway.ts) wired strictly to `[127.0.0.1:8798, 127.0.0.1:8799]`.
3. **Dual-Format Visual Test Dashboard (`1|2` layout)**:
   - **Left half (full height, `#1 db:tests`)**: Database-style test list tracking every test (`PENDING` → `RUNNING` → `PASSED`/`FAILED`) with structured timestamp/level/`file:line` logs.
   - **Right top (`#2 browser:wide`)**: Stable native wide desktop Chrome view (`1440×900`) streamed via CDP MJPEG.
   - **Right bottom (`#3 browser:mobile`)**: Dedicated Chrome DevTools mobile-emulated view (`390×844`, strictly 1 column).
   - Running browser tests mirror crisp white in-page `TEST // ...` banners, spotlight callout boxes, and click pulses across **both** wide and mobile formats simultaneously.
4. **Cryptographic Deploy Gate (`deploy` button)**:
   - The Test UI is monochrome greyscale with white highlights; yellow and red are reserved for warnings and errors.
   - **Only the `deploy` button turns green**, and **only** when:
     1. There are new deployable changes (`current_hash != deployed_hash` over `registry/src/**`, `registry/worker/**`, `registry/index.html`, `registry/wrangler.jsonc`, `install.{sh,ps1}`, or a newer `dialtone` release staged on `channel/test`), **AND**
     2. All tests — including all 9 `TestBrowser01`–`TestBrowser09` tests on the isolated `test` network — passed on the exact `current_hash` (`current_hash === tested_hash`, `0` failed).
5. **Automatic Live Production Verification (`5.PROD VERIFY`)**:
   - Clicking **`deploy`** runs `dialtone-earth deploy --live --require-pass`, which builds and deploys to Cloudflare Workers (`https://dialtone.earth/`), promotes any staged `dialtone` `channel/test` release to `latest`, and immediately runs the **full tracked 11-test live production suite** (`TestBrowser01`–`TestBrowser09` on live `https://metal.dialtone.earth/` + `TestProductionLiveSmoke` on live `https://dialtone.earth/` + `TestDialtoneEarthLiveOwnerAccessOnCloudflare`) visibly in `#1 db:tests`, `#2 browser:wide`, and `#3 browser:mobile`.
   - Only after live production verification passes is `logs/deployed.json` recorded (`verified_prod: true`), returning **`deploy`** to grey (`UP TO DATE`).

---

## 4. CLI Reference (`dialtone-earth help`)

Run from the repository root with `./dialtone-earth.sh <action>`, `.\dialtone-earth.ps1 <action>`, `go run . <action>`, or `bin/dialtone-earth <action>`:

```sh
go run . help                                           # commands, flags, and workflow overview
go run . install                                        # download Go modules and test dashboard UI packages
go run . lint                                           # Go vet and test dashboard TypeScript checks
go run . format                                         # format Go sources
go run . build                                          # build Go CLI binary and test dashboard web UI
go run . auth status --json                             # provider-neutral auth state without network calls
go run . test                                           # run and record all offline Go & registry tests
go run . test --list                                    # list discovered tests without running them
go run . test --filter TestDialtoneEarth                # run only tests matching a regexp
go run . test --browser --keep-signed-in                # rebuild staging preview & run dual-format CDP tests on test channel
go run . test --prod                                    # run the full tracked 11-test live production verification suite
go run . test --close-browser                           # close the persistent CDP Chrome browser
go run . dev --port 5174                                # start loopback test dashboard (http://127.0.0.1:5174/)
go run . deploy                                         # build local bundle in deploy/local
go run . deploy --live --require-pass                   # enforce staging gate -> deploy to dialtone.earth -> run 5.PROD VERIFY
go run . live status                                    # inspect live overrides on https://dialtone.earth/
go run . live set --banner "Hello!"                     # update https://dialtone.earth/ live (~1.5s, no redeploy)
go run . live reset                                     # clear live overrides back to stock defaults
go run . live watch                                     # watch local edits -> rebuild & run staging tests (no auto-deploy)
go run . code list                                      # list private repos stored on Cloudflare R2 (owner auth)
go run . code status --repo dialtone-earth              # inspect branches, HEAD SHA, tags, and archives on R2
go run . code push                                      # push git bundle + source archives to private Cloudflare R2
go run . code pull                                      # fetch and fast-forward local git from Cloudflare R2
go run . code clone dialtone-earth                      # clone a repository directly from Cloudflare R2 (zero GitHub)
go run . release list                                   # list tagged releases on Cloudflare R2
go run . release tag v0.6.0 --build                     # tag HEAD, cross-compile 6 binaries + .sha256 to R2
go run . release channel list --repo dialtone           # show active auto-update channels (test, latest)
go run . release channel set test v0.5.6 --repo dialtone
go run . release channel promote --repo dialtone        # atomically promote channel 'test' -> 'latest' for fleet auto-update
go run . plugins list                                   # list public Dialtone plugins (e.g. dialtone-shell)
go run . plugins info dialtone-shell                    # show plugin manifest, hashes, and iroh-blobs:// ticket
go run . plugins publish dialtone-shell --from-local    # publish local Dialtone plugin to https://dialtone.earth/api/plugins
go run . screenshots                                    # capture annotated test UI screenshots and build local gallery (dry-run)
go run . clean                                          # remove generated artifacts; retain archived run logs
```

---

## 5. Web App & Cloudflare Gateway (`registry/`)

`registry/` powers **`https://dialtone.earth/`** (public simulated system tour + Cloudflare R2/KV code, release, and plugin registry), **`https://metal.dialtone.earth/`** (authenticated live Dialtone mesh gateway), and **`https://test.dialtone.earth/`** (owner-only staging control plane):

- **Edge-to-Edge 3D H3 Globe + Right Telemetry Overlay**: Resolution-3 H3 telemetry clusters and Holten + FDEB edge-bundled atmospheric ping arcs with zero header bars above the globe—brand, `LIVE`/`SIM` badge, H3+RTT legend, cadence, and `CAM:` readout float cleanly in a translucent right-hand overlay inside the 3D globe canvas.
- **Minimal Bottom Closed-Caption Bar**: Closed captions run along the bottom line with **only the `menu` button** on the right.
- **Unified `menu` Overlay**: Selecting window layouts (`auto`, `1`, `1|1`, `1/1`, `1|2`, `2x2`), assigning panels/queries, toggling `full`/`split`, opening the CSP-safe TypeScript `camera` studio, controlling tour playback, and `sign in` / `sign out` all live inside `menu`.
- **Single-Column Mobile Guarantee**: Viewports `< 900px` always render strictly 1 column (`1` or stacked `1/1`), never multi-column splits, even when `2x2` is persisted in Cloudflare KV for desktop.

---

## 6. Root Contract & Security Invariants

- **Pure-stdlib Go CLI at the root** (`go.mod`, `cli.go`, `live.go`, `registry.go`, `test_runs.go`, `cli_test.go`).
- **Single-writer dashboard state**: Only the Go CLI writes `logs/state.json`, `logs/pipeline.json`, `logs/deployed.json`, and immutable `logs/<test-id>.{json,log}`; the Vite dashboard in `ui/` is strictly read-only.
- **Owner-only control plane**: Enforced via Cloudflare Worker secrets (`OWNER_EMAIL=timcash@gmail.com`, `MAGIC_LINK_ALLOWLIST`, `ACCESS_AUD_MAP`, `ACCESS_TEAM_DOMAIN`, `LIVE_CONTROL_TOKEN`) and verified by `TestDialtoneEarthOwnerOnlyAccess` and `TestDialtoneEarthLiveOwnerAccessOnCloudflare`.
- **Standalone Dialtone Plugins & Docs**: See [`docs/plugins-and-live-gateway.md`](docs/plugins-and-live-gateway.md) for the `dialtone-shell` plugin workflow and read-only origin bridge (`registry/scripts/mesh-origin-bridge.mjs`).
