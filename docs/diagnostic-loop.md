# Automated Diagnostic Loop (`test.dialtone.earth`)

The diagnostic loop continuously verifies `dialtone.earth`, `metal.dialtone.earth`, `test.dialtone.earth`, the Dialtone `metal` mesh network, fleet plugin/agent versions, migration readiness, GB-34 agent spec controls, GB-35 channel scope checks, `try_rpc` retry gating, the Mac app on `rosie`, and the `dialtone` daemon itself.

All remote probes are strictly read-only. HTTP probes use `GET` only, and mesh checks run exclusively over the Dialtone `metal` channel (`dialtone exec` / `dialtone probe` / `dialtone status`). GB-34 dummy checks create tiny tasks tagged `diagnostic` (never `agent` unless verifying rejection on `--node diag-nowhere`) and clean them up immediately even on failure.

## 1. CLI Commands

Run a single loop (exits non-zero if any check has status `fail`; `skipped`, `pending`, and `info` never fail a loop):

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
- `--nodes <csv>`: comma-separated list of `metal` peers (default: `rosie,legion,build-1,vm-us,vm-eu,vm-asia,steamdeck-2`; `grok-bot-metal` is excluded by default)
- `--no-tasks`: disable creating, updating, or closing `dialtone-task` diagnostic tasks
- `--screenshots`: capture annotated UI screenshots and attach them to the loop
- `--run-dialtone-tests`: opt in to running local `dialtone` Rust unit tests (skipped by default because `cargo test` is expensive)

Feature flag for pre-release RPC retry check:

- `DIAG_ENABLE_TRY_RPC_RETRY_CHECK=1`: force-enable `rpc.try_rpc.db_open_retry` even when `dialtone-task` reports `< v0.4.1`

You can also enable periodic diagnostic loops alongside `live watch`:

```sh
go run . live watch --diag --diag-interval 10m
```

## 2. Check Status Model

| Status | Counts as Failure? | Creates Diag Task? | Meaning |
| :--- | :--- | :--- | :--- |
| `pass` | No | Closes open task | Check verified healthy |
| `fail` | Yes | Creates or updates task | Check failed and requires investigation |
| `skipped` | No | No | Optional tool missing, dependency failed/skipped, or awaits migration / release |
| `pending` | No | No | Migration readiness check waiting for nodes to upgrade (displayed distinctly as `PENDING MIGRATION`) |
| `info` | No | No | Informational or manual-verification check (for example when a Mac app bundle is not installed) |

## 3. Check DAG & Dependencies

Each loop executes checks in topological waves. If a hard dependency (`depends_on`) fails, is skipped, or is `pending`, downstream dependents are automatically marked `skipped` with an explicit reason (`skip: awaits migration` when gated by a `migration.*` check) and never create noise tasks.

### HTTP (`http`)

| Check ID | Depends On | What It Checks |
| :--- | :--- | :--- |
| `http.dialtone.home` | (root) | `GET https://dialtone.earth/` HTTP 200, `#app`, HSTS, CSP, `X-Frame-Options: DENY`, latency |
| `http.dialtone.session` | `http.dialtone.home` | `GET /api/session` HTTP 200, `authenticated=false`, `mode=simulated` |
| `http.dialtone.installers` | `http.dialtone.home` | `GET /install.sh` and `/install.ps1` HTTP 200 with zero `github.com` references |
| `http.dialtone.plugins` | `http.dialtone.home` | `GET /api/plugins` HTTP 200 and includes `dialtone-shell` |
| `http.dialtone.releases` | `http.dialtone.home` | `GET /api/releases/dialtone/channels` and `/api/releases/dialtone-earth` HTTP 200 |
| `http.dialtone.live` | `http.dialtone.home` | `GET /api/live` HTTP 200 valid JSON |
| `http.dialtone.security` | `http.dialtone.home` | `GET /api/code` returns HTTP 401 for anonymous requests |
| `http.metal.home` | (root) | `GET https://metal.dialtone.earth/` HTTP 200, `#app`, latency |
| `http.metal.auth_gate` | `http.metal.home` | `GET https://metal.dialtone.earth/api/mesh/state` returns HTTP 401 anonymously |
| `http.test.auth_gate` | (root) | `GET https://test.dialtone.earth/` returns `302 -> /login` and `/login` returns HTTP 200 |

### Metal Mesh (`metal`)

| Check ID | Depends On | What It Checks |
| :--- | :--- | :--- |
| `mesh.local.status` | (root) | Local `dialtone status` JSON, `node_id`, `iroh-quic` data plane |
| `mesh.local.probe` | `mesh.local.status` | Local `dialtone probe` (`MSH`, `NBR`, `BEAT`) and `/api/mesh` peer metadata |
| `mesh.node.<n>` | `mesh.local.probe` | Peer `<n>` heartbeat, direct vs relay path, and `dialtone exec --node <n> -- echo ok` RTT (7 active nodes; `grok-bot-metal` excluded) |

### Versions & Migration Readiness (`versions`, `migration`)

| Check ID | Depends On | What It Checks |
| :--- | :--- | :--- |
| `version.task.node.<n>` | `mesh.node.<n>` | `dialtone-task --version` reports `>= v0.4.0` on all 7 nodes |
| `version.agent.node.<n>` | `mesh.node.<n>` | `dialtone-agent --version` reports `>= v0.4.0` on `rosie`, `legion`, `build-1` |
| `migration.dialtone.v060` | `mesh.local.probe` (after `dialtone.daemon.node.*`) | Reports per-node `dialtone >= v0.6.0` readiness; returns `pending` ("pending migration") while nodes are on older versions |
| `migration.task.v050` | `mesh.local.probe` (after `version.task.node.*`) | Reports per-node `dialtone-task >= v0.5.0` readiness; returns `pending` while nodes are on `v0.4.0` |
| `migration.agent.v050` | `mesh.local.probe` (after `version.agent.node.*`) | Reports per-node `dialtone-agent >= v0.5.0` readiness; returns `pending` while nodes are on `v0.4.0` |

### Plugins & Task Health (`plugins`)

| Check ID | Depends On | What It Checks |
| :--- | :--- | :--- |
| `plugin.task.node.<n>` | `mesh.node.<n>` | `dialtone-task status --json`: `serve_running`, `peer_count`, `state_hash` (skipped if not installed) |
| `plugin.dispatch.node.<n>` | `mesh.node.<n>` | `dialtone task status --json` via plugin dispatch (skipped if not installed) |
| `plugin.agent.node.<n>` | `mesh.node.<n>` | `dialtone-agent status` (skipped if not installed) |
| `plugin.task.consistency` | `mesh.local.probe` (after all `plugin.task.node.*`) | Verifies `state_hash` matches across all online nodes with `dialtone-task` |
| `plugin.task.stale` | (root) | Verifies `stale_count == 0` for active tasks via `dialtone-task status --json` |

### GB-34 Agent Spec (`gb34`)

| Check ID | Depends On | What It Checks |
| :--- | :--- | :--- |
| `gb34.spec.reject_missing_fields` | `mesh.local.status` | `dialtone-task add` with `--tag agent --node diag-nowhere` missing required fields (prompt/provider/model/effort) is rejected; cleans up immediately if unexpectedly accepted |
| `gb34.logs.chunk` | `gb34.spec.reject_missing_fields` | Creates a tiny dummy `diagnostic` task (never tagged `agent`), appends a chunk via `dialtone-task log`, reads it back via `dialtone-task logs`, and cleans up even on failure |
| `gb34.approve_deny` | `gb34.spec.reject_missing_fields` | Creates two dummy `diagnostic` tasks with `--perm deploy:diag-dummy` (never tagged `agent`): verifies `deny` pauses and records denial, verifies `approve` records approval, and cleans up both even on failure |

### GB-35 Channel Scope (`gb35`)

Every live GB-35 check depends on `migration.dialtone.v060` (and `gb35.task.channel_separation` also depends on `migration.task.v050`), so on nodes still on pre-migration versions each check automatically returns `skipped` with `skip: awaits migration`. All 8 behaviors are also verified in unit tests (`TestDiagGB35FixtureChecks`) using throwaway Ed25519 manifests, `httptest` fixtures, isolated membership fixtures, 3+ MB streaming fixtures, and throwaway temp directories without touching any live `metal` daemon, channel key, `~/.dialtone` config, or membership.

| Check ID | Depends On | What It Checks |
| :--- | :--- | :--- |
| `gb35.api.channels` | `migration.dialtone.v060` | `GET /api/channels` responds HTTP 200 valid JSON |
| `gb35.api.manifest` | `gb35.api.channels` | `GET /api/channel/manifest` responds HTTP 200 with valid channel manifest |
| `gb35.manifest.signature` | `gb35.api.manifest` | Verifies Ed25519 signature over canonical manifest payload |
| `gb35.plugin.deny_unlisted` | `gb35.api.manifest` | Confirms an unlisted plugin is denied (fails closed) |
| `gb35.blob.membership` | `migration.dialtone.v060` | Verifies removed peer loses blob access (isolated fixture; never mutates live metal membership) |
| `gb35.blob.stream_3mb` | `migration.dialtone.v060` | Verifies streaming blob share >= 3 MB with SHA-256 verification |
| `gb35.logs.dialtone_log` | `migration.dialtone.v060` | Reads encrypted channel logs via `dialtone log --lines 20` |
| `gb35.task.channel_separation` | `migration.dialtone.v060`, `migration.task.v050` | Verifies task store separation across channels in isolated temp directories |

### RPC, Mac App & Dialtone Daemon (`rpc`, `macapp`, `dialtone`)

| Check ID | Depends On | What It Checks |
| :--- | :--- | :--- |
| `rpc.try_rpc.db_open_retry` | `mesh.local.status` | Concurrent `dialtone-task status --json` calls without `Database already open` errors; skipped with `not in a release yet` until `dialtone-task >= v0.4.1` or `DIAG_ENABLE_TRY_RPC_RETRY_CHECK=1` |
| `macapp.version.rosie` | `mesh.node.rosie` | Read-only `plutil -convert json` check of installed Dialtone Mac app `Info.plist` on `rosie` over `metal` (returns `info` manual check if bundle not found) |
| `dialtone.cli.version` | `mesh.local.probe` | Local `dialtone` CLI and daemon version/build hash |
| `dialtone.daemon.node.<n>` | `mesh.node.<n>` | Remote `dialtone daemon status`, version, and uptime |
| `dialtone.repo.tests` | `dialtone.cli.version` | Skipped unless `--run-dialtone-tests` is passed |

## 4. Storage Keys & Pages

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

- `/diagnostics`: latest loop summary (including `pending` and `info` counts), layered Dependency DAG, category-grouped check tables with distinct `PENDING MIGRATION` styling, `/screenshots/` gallery link, and history of the last 50 loops
- `/diagnostics/runs/<loop-id>`: dedicated per-loop report view
- `/logs/?test-id=<test-id>`: immutable structured log view for any check
- `GET /api/diagnostics/latest`, `GET /api/diagnostics/history`, `GET /api/diagnostics/runs/<loop-id>`
- `POST /api/diagnostics/runs`: publishes loop report and per-check logs

## 5. Diagnostic Tasks Integration (`dialtone-task`)

- When a check fails, the runner searches open tasks tagged `diagnostic` with title `diag: <check-id> failing`.
- If none exists, it creates one task with the latest `loop_id`, `test-id`, and redacted error.
- If one already exists, it updates that same task (never creates duplicates).
- When the check passes again, the open task is marked `done`.
- Skipped, `pending`, and `info` checks never create or close diagnostic tasks.

## 6. Deploying & Running Always-On on `legion` (Requires Approval)

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
