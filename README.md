![Dialtone logo](docs/dialtone-logo.svg)

# Dialtone Earth

## 1. Install

Install the `dialtone-earth` CLI binary directly from Cloudflare (**zero GitHub dependency**) into `~/.local/bin` (macOS/Linux) or `%USERPROFILE%\.local\bin` (Windows) without modifying shell profiles or system `PATH`:

Linux / macOS:

```sh
curl -fsSL https://dialtone.earth/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://dialtone.earth/install.ps1 | iex
```

## 2. Architecture: Iroh + Cloudflare + Rust + Go CLI (Zero GitHub, Zero Tailscale)

`dialtone.earth` is self-hosted end-to-end on **Cloudflare Workers + R2 + KV** and **Iroh P2P**, removing runtime and release dependencies on GitHub and Tailscale:

| Layer | Technology | Role |
| :--- | :--- | :--- |
| **Mesh & Plugins** | **Rust + Iroh 1.5** (`dialtone`, `dialtone-shell`) | Direct QUIC + `mdns-local` LAN + N0 relay mesh (`exclude_tailnet: true`). Plugins are standalone SHA-256 / BLAKE3 content-addressed `iroh-blobs` binaries executed over stdio RPC. |
| **Code, Releases & Plugin Registry** | **Cloudflare Workers + R2 (`dialtone-earth-registry`) + KV** | Stores git bundles (`X-Dialtone-Shallow` aware), `main.tar.gz`/`main.zip` source archives, SHA-256-verified cross-compiled release binaries (`/releases/<repo>/download/<tag>/<asset>`), and the public plugin catalog (`/api/plugins`). |
| **Operator CLI & Live Test Loop** | **Pure-stdlib Go CLI** (`dialtone-earth`) + **Vite Dashboard** (`ui/`) | Drives code pushes, tagged releases, plugin publishing, persistent Chrome CDP visual tests projected into `http://127.0.0.1:5174/`, and test-gated live auto-deploys to `https://dialtone.earth/`. |

### Live Edit → Highlighted Synced Tests → Auto-Deploy Loop

1. **Edit code** locally while `dialtone-earth live watch` is running (with the Test Page open at `http://127.0.0.1:5174/`).
2. **Synced Tests + Projected Browser**: The Test Page highlights the live pipeline stage (`1. Edit → 2. Synced Tests → 3. Deploy → 4. Live dialtone.earth`) and pulses each active test card on the left while **projecting the real persistent Chrome CDP (`:9222`) session live on the right** (`/api/cdp/stream`), complete with glowing UI spotlight boxes, callout labels, and click ripples showing exactly what each test demonstrates on `https://metal.dialtone.earth/`.
3. **Auto-Deploy on Pass**: If every test passes (`0 failed`), `dialtone-earth` automatically builds and deploys `registry/` live to **https://dialtone.earth/** and displays the Cloudflare Version ID in the pipeline bar. Any failure blocks deployment.
4. **Persistent Browser Reconnect**: Chrome stays open and signed into `LIVE · metal` (`--keep-signed-in`) so clicking **Run** on any single card or re-running `test --browser` reconnects immediately in <1s without relaunching or re-logging in.

## 3. CLI (`dialtone-earth help`)

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
go run . test --browser --keep-signed-in                # run synced CDP Chrome tests & keep Chrome open
go run . test --browser --keep-signed-in --deploy-on-pass
go run . test --close-browser                           # close the persistent CDP Chrome browser
go run . dev --port 5174                                # start loopback test dashboard (http://127.0.0.1:5174/)
go run . deploy                                         # build local bundle in deploy/local
go run . deploy --live                                  # build registry/ and publish live to https://dialtone.earth/
go run . live status                                    # inspect live overrides on https://dialtone.earth/
go run . live set --banner "Hello!"                     # update https://dialtone.earth/ live (~1.5s, no redeploy)
go run . live reset                                     # clear live overrides back to stock defaults
go run . live watch                                     # watch edits -> run synced CDP tests -> deploy on pass
go run . code list                                      # list repos stored on Cloudflare R2
go run . code push --live                               # push git bundle + archives to R2 and deploy live
go run . code pull                                      # fetch and fast-forward local git from Cloudflare R2
go run . code clone dialtone-earth                      # clone a repository directly from Cloudflare R2
go run . release list                                   # list tagged releases on Cloudflare R2
go run . release tag v0.6.0 --build --live              # tag HEAD, build 6 binaries + .sha256 to R2, deploy live
go run . plugins list                                   # list public Dialtone plugins (e.g. dialtone-shell)
go run . plugins info dialtone-shell                    # show plugin manifest, hashes, and iroh-blobs:// ticket
go run . plugins publish dialtone-shell --from-local    # publish local Dialtone plugin to https://dialtone.earth/api/plugins
go run . clean                                          # remove generated artifacts; retain run logs
```

### Cloudflare Registry API Endpoints (`https://dialtone.earth`)

- **Code**: `GET /api/code`, `GET /api/code/<repo>`, `PUT /api/code/<repo>/push`, `GET /api/code/<repo>/bundle`, `GET/PUT /api/code/<repo>/archive/<file>`
- **Releases**: `GET /api/releases/<repo>`, `POST /api/releases/<repo>/<tag>`, `PUT /api/releases/<repo>/<tag>/assets/<asset>`, `GET /releases/<repo>/download/<tag>/<asset>` (+ `.sha256`)
- **Public Plugins**: `GET /api/plugins`, `GET/PUT /api/plugins/<name>`, `PUT /api/plugins/<name>/assets/<asset>`, `GET /api/plugins/<name>/download/<asset>` (+ `.sha256`)

All `GET` routes are public; mutating routes require `Authorization: Bearer <LIVE_CONTROL_TOKEN>` (initialized via `dialtone-earth live init-token`).

## 4. Template Alignment

This repository keeps the clean single-writer contract at the root:

- **Pure-stdlib Go CLI at the root** (`go.mod`, `cli.go`, `live.go`, `registry.go`, `test_runs.go`, `cli_test.go`).
- **Single-writer test & pipeline state**: `dialtone-earth test`, `dev`, and `live watch` are the only writers of `logs/state.json`, `logs/pipeline.json`, and immutable `logs/<test-id>.{json,log}`; the Vite dashboard in `ui/` is read-only.
- **No silent side effects**: opening `http://127.0.0.1:5174/` starts zero tests until triggered; `auth status` defaults to `not_configured` (exit `1`) without reading credentials or contacting the network.

## 5. Test & Live Development Loop

1. Install dependencies once:
   ```sh
   ./dialtone-earth.sh install          # Windows PowerShell: .\dialtone-earth.ps1 install
   ```
2. Start the live Test Page (`http://127.0.0.1:5174/`) with the embedded projected Chrome viewport:
   ```sh
   ./dialtone-earth.sh dev --port 5174
   ```
3. Start the live Edit → Test → Auto-Deploy watcher:
   ```sh
   ./dialtone-earth.sh live watch
   ```
4. Or run the synced live browser suite on demand from the terminal (or click **Run browser suite** / **Run** on any card):
   ```sh
   ./dialtone-earth.sh test --browser --keep-signed-in --filter "^TestBrowser"
   ```

## 6. Web App & Cloudflare Gateway (`registry/`)

`registry/` powers **https://dialtone.earth/** (public simulated system tour + Cloudflare R2/KV code, release, and plugin registry) and **https://metal.dialtone.earth/** (authenticated live Dialtone mesh gateway):

- **3D H3 Geospatial Globe & Bundled Ping Arcs:** Resolution-3 H3 telemetry clusters and Holten + FDEB edge-bundled atmospheric ping arcs.
- **Whole-App Tiling Window Manager & Query Set:** Globe and query tables share one tiling workspace (`auto`, `1`, `1|1`, `1/1`, `1|2`, `2x2`) with best-effort rate tiers (`base 30s`, `slow 10s`, `med 4s`, `fast 1.5s`) and per-user Cloudflare KV persistence (`/api/user/ui-config`).
- **Fullscreen TypeScript Camera Studio:** CSP-safe (`script-src 'self'`, zero `eval`) TypeScript geolocation selector with syntax highlighting, live `ctx.nodes` telemetry table, and 8 prefilled examples.

## 7. Standalone Dialtone Plugins & Docs

Dialtone v0.5.5+ packages plugins as standalone content-addressed `iroh-blobs` binaries verified by SHA-256 and BLAKE3 digests (for example, `dialtone-shell` over `dialtone/shell/1`, published publicly at `https://dialtone.earth/api/plugins/dialtone-shell`).

See [`docs/plugins-and-live-gateway.md`](docs/plugins-and-live-gateway.md) for the plugin workflow, read-only origin bridge (`registry/scripts/mesh-origin-bridge.mjs`), and live `metal.dialtone.earth` E2E test details.
