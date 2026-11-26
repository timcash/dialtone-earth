# Automated Diagnostic Loop (`test.dialtone.earth`)

The diagnostic loop continuously verifies `dialtone.earth`, `metal.dialtone.earth`, `test.dialtone.earth`, the Dialtone `metal` mesh network, installed Dialtone plugins (`dialtone-task`, plugin dispatch, `dialtone-agent`), and the `dialtone` daemon itself.

All remote probes are strictly read-only. HTTP probes use `GET` only, and mesh checks run exclusively over the Dialtone `metal` channel (`dialtone exec` / `dialtone probe` / `dialtone status`).

## 1. CLI Commands

Run a single loop (exits non-zero if any check fails):

```sh
go run . diag run
```

Run continuously on a configurable interval (default: `10m`):

```sh
go run . diag watch --interval 10m
```

Useful flags:

- `--interval <dur>`: loop interval (default `10m`)
- `--iterations <n>`: max iterations for `diag watch` (`0` means repeat forever)
- `--publish-url <url>`: target UI base URL (default `http://127.0.0.1:5174`)
- `--publish-live`: explicit guard required before posting to any non-localhost URL (for example `https://test.dialtone.earth`)
- `--token-file <path>`: owner `LIVE_CONTROL_TOKEN` file used with `--publish-live`
- `--nodes <csv>`: comma-separated list of `metal` peers (default: `rosie,legion,build-1,vm-us,vm-eu,vm-asia,steamdeck-2,grok-bot-metal`)
- `--no-tasks`: disable creating, updating, or closing `dialtone-task` diagnostic tasks
- `--screenshots`: capture annotated UI screenshots and attach them to the loop
- `--run-dialtone-tests`: opt in to running local `dialtone` Rust unit tests (skipped by default because `cargo test` is expensive)

You can also enable periodic diagnostic loops alongside `live watch`:

```sh
go run . live watch --diag --diag-interval 10m
```

## 2. Check DAG & Dependencies

Each loop executes checks in topological waves. If a hard dependency fails or is skipped, all downstream dependents are automatically marked `skipped` with an explicit reason and do not create noise tasks.

| Check ID | Category | Depends On | What It Checks |
| :--- | :--- | :--- | :--- |
| `http.dialtone.home` | `http` | (root) | `GET https://dialtone.earth/` HTTP 200, `#app`, HSTS, CSP, `X-Frame-Options: DENY`, latency |
| `http.dialtone.session` | `http` | `http.dialtone.home` | `GET /api/session` HTTP 200, `authenticated=false`, `mode=simulated` |
| `http.dialtone.installers` | `http` | `http.dialtone.home` | `GET /install.sh` and `/install.ps1` HTTP 200 with zero `github.com` references |
| `http.dialtone.plugins` | `http` | `http.dialtone.home` | `GET /api/plugins` HTTP 200 and includes `dialtone-shell` |
| `http.dialtone.releases` | `http` | `http.dialtone.home` | `GET /api/releases/dialtone/channels` and `/api/releases/dialtone-earth` HTTP 200 |
| `http.dialtone.live` | `http` | `http.dialtone.home` | `GET /api/live` HTTP 200 valid JSON |
| `http.dialtone.security` | `http` | `http.dialtone.home` | `GET /api/code` returns HTTP 401 for anonymous requests |
| `http.metal.home` | `http` | (root) | `GET https://metal.dialtone.earth/` HTTP 200, `#app`, latency |
| `http.metal.auth_gate` | `http` | `http.metal.home` | `GET https://metal.dialtone.earth/api/mesh/state` returns HTTP 401 anonymously |
| `http.test.auth_gate` | `http` | (root) | `GET https://test.dialtone.earth/` returns `302 -> /login` and `/login` returns HTTP 200 |
| `mesh.local.status` | `metal` | (root) | Local `dialtone status` JSON, `node_id`, `iroh-quic` data plane |
| `mesh.local.probe` | `metal` | `mesh.local.status` | Local `dialtone probe` (`MSH`, `NBR`, `BEAT`) and `/api/mesh` peer metadata |
| `mesh.node.<n>` | `metal` | `mesh.local.probe` | Peer `<n>` heartbeat, direct vs relay path, and `dialtone exec --node <n> -- echo ok` RTT |
| `plugin.task.node.<n>` | `plugins` | `mesh.node.<n>` | `dialtone-task status --json`: `serve_running`, `peer_count`, `state_hash` (skipped if not installed) |
| `plugin.dispatch.node.<n>` | `plugins` | `mesh.node.<n>` | `dialtone task status --json` via plugin dispatch (skipped if not installed) |
| `plugin.agent.node.<n>` | `plugins` | `mesh.node.<n>` | `dialtone-agent status` (skipped if not installed) |
| `plugin.task.consistency` | `plugins` | `mesh.local.probe` (after all `plugin.task.node.*`) | Verifies `state_hash` matches across all online nodes with `dialtone-task` |
| `dialtone.cli.version` | `dialtone` | `mesh.local.probe` | Local `dialtone` CLI and daemon version/build hash |
| `dialtone.daemon.node.<n>` | `dialtone` | `mesh.node.<n>` | Remote `dialtone daemon status`, version, and uptime |
| `dialtone.repo.tests` | `dialtone` | `dialtone.cli.version` | Skipped unless `--run-dialtone-tests` is passed |

## 3. Storage Keys & Pages

All diagnostic pages and APIs on `test.dialtone.earth` sit behind the existing owner-only gate (`timcash@gmail.com` magic-link session, Cloudflare Access JWT, or `LIVE_CONTROL_TOKEN` Bearer). Anonymous requests to `/diagnostics` redirect `302 -> /login`; anonymous `/api/diagnostics/*` requests return `401`.

### Edge Storage (`DIALTONE_REGISTRY` R2 + `DIALTONE_AUTH_TOKENS` KV)

- R2 `diag/runs/<loop-id>.json`: immutable full JSON report for each loop
- R2 `diag/logs/<test-id>.json` and `diag/logs/<test-id>.log`: redacted structured check log served by `/api/test-runs/<test-id>`
- KV `diag:latest`: latest `DiagLoopReport` JSON
- KV `diag:history`: JSON array of the last 50 `DiagHistoryEntry` summaries

### Local Storage (Single-Writer Go CLI)

- `logs/diag/latest.json`: latest loop report
- `logs/diag/runs/<loop-id>.json`: per-loop report
- `logs/diag/history.json`: last 50 loop summaries
- `logs/<test-id>.json` and `logs/<test-id>.log`: compatible with `/logs/?test-id=<test-id>`

### UI Pages & APIs

- `/diagnostics`: latest loop summary, layered Dependency DAG, per-check table, `/screenshots/` gallery link, and history of the last 50 loops
- `/diagnostics/runs/<loop-id>`: dedicated per-loop report view
- `/logs/?test-id=<test-id>`: immutable structured log view for any check
- `GET /api/diagnostics/latest`, `GET /api/diagnostics/history`, `GET /api/diagnostics/runs/<loop-id>`
- `POST /api/diagnostics/runs`: publishes loop report and per-check logs

## 4. Diagnostic Tasks Integration (`dialtone-task`)

- When a check fails, the runner searches open tasks tagged `diagnostic` with title `diag: <check-id> failing`.
- If none exists, it creates one task with the latest `loop_id`, `test-id`, and redacted error.
- If one already exists, it updates that same task (never creates duplicates).
- When the check passes again, the open task is marked `done`.
- Skipped checks never create or close diagnostic tasks.

## 5. Deploying & Running Always-On on `legion` (Requires Approval)

1. Deploy the updated Cloudflare Worker (includes owner-only `/diagnostics` routes and optional `*/10 * * * *` HTTP-only cron trigger in `registry/wrangler.jsonc`):

```sh
cd registry && pnpm run build && pnpm exec wrangler deploy
```

Or via the repo CLI after passing staging gates:

```sh
go run . deploy --live --require-pass
```

2. Start the always-on diagnostic loop runner on `legion` (Windows PowerShell) with explicit `--publish-live` and the owner token file:

```powershell
# Verify one loop first:
go run . diag run --publish-url https://test.dialtone.earth --publish-live --token-file "$env:USERPROFILE\.config-dialtone-earth\live-control-token.txt"

# Persistent scheduled runner on legion (every 10 minutes):
go run . diag watch --interval 10m --publish-url https://test.dialtone.earth --publish-live --token-file "$env:USERPROFILE\.config-dialtone-earth\live-control-token.txt"
```

To run persistently across reboots on `legion`, register a Windows Scheduled Task (similar to `DialtoneDaemon`) executing the built `dialtone-earth.exe diag watch --interval 10m --publish-url https://test.dialtone.earth --publish-live` binary under the interactive user session.
