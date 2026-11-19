# dsh-lceda

[中文](README-zh.md) | English

DeepSeek Harness plugin for **LCEDA Pro (嘉立创 EDA)** headless development: let the
agent run editor JavaScript, autoroute with Freerouting, verify DRC / pad nets /
connectivity, pour copper, wire schematics and export manufacturing files on a real
`.eprj3` project.

Wraps the LCEDA Pro CLI (`invoke --code-file -` over stdin, no UNC temp files).
Guards: refuses writes while a user GUI session holds the project (`.eprj3` two-way
sync), recycles stale headless sessions, waits for document readiness, decodes
UTF-16LE CSV exports, and never trusts `ok:true` as business success.

## Install

Requires DSH >= 0.2.2 (Cordis 4) and Node >= 22.19. The published package ships a
built `lib/`, so installing runs no build script.

```sh
# from a checkout
dsh plugin --profile <profile> add /path/to/dsh-lceda
# from git (build output is committed)
dsh plugin --profile <profile> add git+https://github.com/samuelwhg/dsh-lceda.git
```

Restart that profile. The bundle's `cordis.patch.yml` inserts the `dsh-lceda` row, so
the eight `lceda_*` tools and the `lceda-dev` skill appear without hand-editing config.

## Configuration

Per-project values ship with **no defaults**: set `projectPath`, `pcbUuid`,
`schUuid`, and — for autorouting — `freeroutingJar` / `sesDirWin` for your own
project. Add them to the profile that installed the plugin, under the same `id` the
bundle inserted:

```yaml
# <profile>/cordis.patch.yml
- id: dsh-lceda
  name: dsh-lceda
  config:
    exePath: /mnt/c/Program Files/lceda-pro/lceda-pro.exe  # WSL path to lceda-pro.exe
    projectPath: D:\work\board.eprj3                       # Windows path, opened headless
    pcbUuid: <pcb document id>
    schUuid: <schematic page id>
    freeroutingJar: /home/me/freerouting/freerouting.jar   # only for lceda_route
    sesDirWin: D:\work\autoroute                           # only for lceda_route
```

| key | default | meaning |
| --- | --- | --- |
| `exePath` | `/mnt/c/Program Files/lceda-pro/lceda-pro.exe` | LCEDA Pro CLI executable (WSL path to the Windows exe) |
| `spawnCwd` | `/mnt/c` | cwd for the Windows exe (drive root avoids UNC cwd issues) |
| `projectPath` | *(empty)* | Windows `.eprj3` path opened headless |
| `pcbUuid` | *(empty)* | PCB document id for the `openDocument` prelude |
| `schUuid` | *(empty)* | schematic page id for the `openDocument` prelude |
| `freeroutingJar` | *(empty)* | Freerouting jar; required by `lceda_route` |
| `javaBin` | `java` | Java binary for Freerouting |
| `sesDirWin` | *(empty)* | Windows-visible dir where `board.ses` is placed for import; required by `lceda_route` |
| `workDir` | `.dsh-lceda` | WSL dir for DSN/SES/export artifacts, relative to the session workspace |
| `invokeTimeoutMs` | `120000` | default per-invoke budget |
| `routeTimeoutMs` | `900000` | Freerouting budget |
| `allowGuiConcurrent` | `false` | allow writes while a user GUI session is open (dangerous) |

Document ids are the ids `eda.dmt_EditorControl.openDocument` expects; read them in
the editor for your project once (the headless CLI cannot invent them). Invalid
config fails at load with the field path, e.g.
`$.invokeTimeoutMs expected number but got nope`.

## Quickstart

1. Set `exePath`, `projectPath`, `pcbUuid` as above and restart the profile.
2. `lceda_session` `{ "action": "list" }` — confirms the CLI handshake, no session opened yet.
3. `lceda_session` `{ "action": "open" }` — opens the project headless, returns `sessionId`.
4. `lceda_run` `{ "code": "return Object.keys(eda).filter(k => k.startsWith('pcb_'))" }` — the PCB API surface of your installed editor build.
5. `lceda_run` `{ "doc": "pcb", "code": "<real work>", ... }` — from here the skill's workflow takes over.

If step 4 returns an empty list, the editor build is newer/older than expected — run
`lceda_session` `{ "action": "clean" }` and retry (zombie sessions make `getAll`
return `null`).

## Tools

| tool | what it does |
| --- | --- |
| `lceda_session` | `open` / `list` / `close` / `clean` headless sessions; GUI sessions are never touched |
| `lceda_run` | run editor JavaScript (`doc=pcb\|sch` opens and waits first) |
| `lceda_export` | export Gerber / BOM / pick-and-place / assembly (UTF-16LE CSV decoded) |
| `lceda_route` | `clearRouting` → DSN → Freerouting → SES import → save |
| `lceda_check` | `drc`, pad-net diff against an expected JSON, pad/track/via connectivity |
| `lceda_pour` | rebuild or set connect mode of copper pours |
| `lceda_sch_wire` | draw schematic wires onto exact pin hotspots |
| `lceda_sch_netlist` | compile the schematic netlist |

The bundled `lceda-dev` skill carries the workflow order and the red lines (do not
write while the GUI holds the project, never overwrite `PCB1.epcb2` wholesale, never
pour solid copper on inner signal layers, always re-check all pad nets after
`importChanges`, hand back to the GUI for symbols/teardrops/dialogs).

## Permissions

Declared capabilities: `tools:register`, `fs:read`, `fs:write`, `subprocess`.

- Reads your project files and writes artifacts under `workDir` (DSN, SES, exported
  CSVs and manufacturing files) plus the `.ses` copy under `sesDirWin`.
- Spawns the LCEDA Pro exe and, for `lceda_route`, a `java -jar freerouting.jar`
  process. Both run with argv arrays (no shell), under a timeout, and are killed on
  expiry.
- Modifies your design: `lceda_run`, `lceda_route`, `lceda_pour`, `lceda_sch_wire`
  save documents. Keep the project in version control.
- No network egress/ingress, no credentials, no prompt modification: `dsh.labels`
  is intentionally empty.
- To revoke: remove the plugin (below) or disable its row in the profile.

## Upgrade, rollback, uninstall

```sh
dsh plugin --profile <profile> add git+https://github.com/samuelwhg/dsh-lceda.git   # upgrade
dsh plugin --profile <profile> add git+https://github.com/samuelwhg/dsh-lceda.git#<tag-or-commit>  # pin / roll back
dsh plugin --profile <profile> remove dsh-lceda                                  # uninstall
```

Uninstall does not delete your artifacts: `workDir` (default `.dsh-lceda`) and the
`sesDirWin` copy stay on disk — delete them yourself. Close sessions first
(`lceda_session` `{ "action": "clean" }`); reloading the plugin also closes the
sessions it owns.

## Troubleshooting

| symptom | next step |
| --- | --- |
| `cannot start "<exePath>" ... ENOENT` | install LCEDA Pro and point `exePath` at `lceda-pro.exe` as a WSL path |
| `no project path` | pass a `.eprj3` path to `lceda_session open` or set `projectPath` |
| `config pcbUuid is not set` / `schUuid` | set the document id for that board/page (see Configuration) |
| `user GUI session open (...)` | close the GUI, or set `allowGuiConcurrent: true` knowing `.eprj3` sync can overwrite |
| `getAll` returns `null`, or the session dies | `lceda_session` `{ "action": "clean" }`, retry; headless canvas subscriptions are fragile |
| DRC crashes the session | `lceda_check` falls back to `getDrcResult`; run `drc` in the GUI for an authoritative report |
| `lceda_route` fails: jar/java missing | set `freeroutingJar`, `javaBin`; `java -version` must work in the same shell |
| Freerouting ends with unrouted nets | raise `routeTimeoutMs` / `passes`, or pre-route those nets; Freerouting does not preserve hand-drawn buses |
| `board.ses` not imported | `sesDirWin` must be a path the Windows editor can read (not a WSL-only path) |
| writes are refused | a GUI session holds the project — that guard is the feature, not a bug |

## Development

```sh
pnpm install
pnpm build        # tsdown → lib/ (committed, so installs need no build)
pnpm test         # vitest
npx tsc --noEmit
npm_config_cache="$PWD/.npm-cache" npx -y dsh-standards@1.6.12 check . --scope entry --entry-claim static --no-exec --host-version 0.2.2-rc.3
```

## Capability declaration note (DSC-11.5)

`fs:read`, `fs:write` and `subprocess` are declared because the plugin really uses
them, but through `node:fs` / `node:child_process` directly (export decode to a WSL
directory, spawning the Windows LCEDA CLI and the Freerouting JVM) rather than the
`ctx.fs` / `ctx.subprocess` seams the static trigger scans for. `tools:register` and
the skill registration are the seam-visible triggers. The declarations stay: they
are accurate, and DSH relies on them for permission preflight.
