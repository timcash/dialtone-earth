![Dialtone logo](docs/dialtone-logo.svg)

# Dialtone Earth

## 1. Install

Install the `dialtone-earth` CLI binary into `~/.local/bin` (macOS/Linux) or `%USERPROFILE%\.local\bin` (Windows) without modifying shell profiles or system `PATH`:

Linux / macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/timcash/dialtone-earth/main/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/timcash/dialtone-earth/main/install.ps1 | iex
```

## 2. CLI (`dialtone-earth help`)

Run from the repository root with `./dialtone-earth.sh <action>`, `.\dialtone-earth.ps1 <action>`, `go run . <action>`, or `bin/dialtone-earth <action>`:

```sh
go run . help                         # commands and flags
go run . install                      # download Go modules and test dashboard UI packages
go run . lint                         # Go vet and test dashboard TypeScript checks
go run . format                       # format Go sources
go run . build                        # build Go CLI binary and test dashboard web UI
go run . auth status --json           # provider-neutral auth state without network calls
go run . test                         # run and record all Go & registry tests
go run . test --list                  # list discovered tests without running them
go run . test --filter TestDialtoneEarth
go run . dev --port 5174              # start loopback test dashboard (http://127.0.0.1:5174/)
go run . deploy                       # build local bundle in deploy/local
go run . deploy --live                # build registry/ and publish live to https://dialtone.earth/
go run . live status                  # inspect live overrides on https://dialtone.earth/
go run . live set --banner "Hello!"   # update https://dialtone.earth/ live without redeploying
go run . live reset                   # clear live overrides back to stock defaults
go run . clean                        # remove generated artifacts; retain run logs
```

## 3. Template Alignment

This repository follows [`timcash/template`](https://github.com/timcash/template):

- **Pure-stdlib Go CLI at the root** (`go.mod`, `cli.go`, `live.go`, `test_runs.go`, `cli_test.go`, `internal/guardauth/`).
- **Single-writer test state**: `dialtone-earth test` and `dialtone-earth dev` write `logs/state.json` and immutable `logs/<test-id>.{json,log}`; the Vite dashboard in `ui/` is read-only.
- **No silent side effects**: opening `http://127.0.0.1:5174/` starts zero tests until **Start tests** is clicked; `auth status` defaults to `not_configured` (exit `1`) without reading credentials or contacting the network.

## 4. Test & Live Test Loop

1. Install dependencies once:
   ```sh
   ./dialtone-earth.sh install          # Windows PowerShell: .\dialtone-earth.ps1 install
   ```
2. Run the full suite from the terminal (`internal/guardauth`, `registry/` gateway/simulation/origin-bridge tests, `ui/` tests, and CLI contract checks):
   ```sh
   ./dialtone-earth.sh test
   ```
3. Or start the loopback test dashboard (`http://127.0.0.1:5174/`) and click **Start tests**:
   ```sh
   ./dialtone-earth.sh dev --port 5174
   ```
4. Run the registry frontend + Cloudflare Worker suite directly:
   ```sh
   pnpm --dir registry test
   pnpm --dir registry build
   ```

## 5. Web App & Cloudflare Gateway (`registry/`)

`registry/` powers **https://dialtone.earth/** (public simulated system tour) and **https://metal.dialtone.earth/** (authenticated live Dialtone mesh gateway):

- **3D H3 Geospatial Globe & Bundled Ping Arcs:** Resolution-3 H3 telemetry clusters and Holten + FDEB edge-bundled atmospheric ping arcs.
- **Whole-App Tiling Window Manager & Query Set:** Globe and query tables share one tiling workspace (`auto`, `1`, `1|1`, `1/1`, `1|2`, `2x2`) with best-effort rate tiers (`base 30s`, `slow 10s`, `med 4s`, `fast 1.5s`) and per-user Cloudflare KV persistence (`/api/user/ui-config`).
- **Fullscreen TypeScript Camera Studio:** CSP-safe (`script-src 'self'`, zero `eval`) TypeScript geolocation selector with syntax highlighting, live `ctx.nodes` telemetry table, and 8 prefilled examples.

## 6. Standalone Dialtone Plugins & Docs

Old monorepo `src/plugins/*` and `dialtone_mod` launchers have been removed in favor of Dialtone v0.5.5+ standalone per-repo blob-binary plugins (`dialtone install shell --repo timcash/dialtone-shell`, stdio RPC, SHA-256 `iroh-blobs` digests).

See [`docs/plugins-and-live-gateway.md`](docs/plugins-and-live-gateway.md) for the plugin workflow, read-only origin bridge (`registry/scripts/mesh-origin-bridge.mjs`), and live `metal.dialtone.earth` E2E test (`pnpm --dir registry test:live`).
