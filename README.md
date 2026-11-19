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

Requires DSH >= 0.2.2 (Cordis 4), Node >= 22.19, and LCEDA Pro on Windows (native DSH
desktop or WSL — both are supported: paths are auto-detected and `sesDirWin` is only
translated to `/mnt/<drive>` when running under WSL). The published package ships a
built `lib/`, so installing runs no build script.

```sh
# from a checkout
dsh plugin --profile <profile> add /path/to/dsh-lceda
# from git (build output is committed)
dsh plugin --profile <profile> add git+https://github.com/samuelwhg/dsh-lceda.git
```

Restart that profile. The bundle's `cordis.patch.yml` inserts the `dsh-lceda` row, so
the eight `lceda_*` tools and the `lceda-dev` skill appear without hand-editing config.

## Let an AI install it

Hand this block to an AI agent with shell access on the machine where DSH runs — it
installs, configures and smoke-tests the plugin without you hunting for document ids:

> Install the `dsh-lceda` plugin and get it working on my project.
>
> 1. Check prerequisites: `node -v` (>= 22.19), `dsh --version` (>= 0.2.2), and that
>    LCEDA Pro is installed on this machine. Ask me which DSH profile to use.
> 2. Install into that profile — from git:
>    `dsh plugin --profile <profile> add git+https://github.com/samuelwhg/dsh-lceda.git`
>    (from a local checkout: `add /path/to/dsh-lceda`). Then confirm the bundle inserted
>    an `id: dsh-lceda` row.
> 3. Ask me for the `.eprj3` project path. Leave `exePath` and `spawnCwd` empty — they
>    are auto-detected (`Program Files{, (x86)}\lceda-pro` on every drive). Only set
>    `exePath` if I say LCEDA Pro lives somewhere unusual.
> 4. Write `projectPath` into `<profile>/cordis.patch.yml` under the existing
>    `id: dsh-lceda` row — merge into that row, never add a second one. Leave `pcbUuid`
>    and `schUuid` empty: they are derived from the project file (first board / first
>    schematic page). Only set them when my project has several and I want a specific
>    one — the ids are the keys of `profile.pcbs` / `profile.sheets` in the `.eprj3`,
>    which is plain JSON. Add `freeroutingJar` + `sesDirWin` only if I ask for autorouting.
> 5. Restart the profile and verify, reporting each result verbatim:
>    `lceda_session {"action":"list"}` (proves the exe resolves; on failure the error
>    lists every path it probed), `lceda_session {"action":"open"}` (must return a
>    session id), `lceda_run {"code":"return Object.keys(eda).filter(k=>k.startsWith('pcb_')).length"}`
>    (must return a positive count for the PCB API surface).
> 6. Stop before touching the design. `lceda_check` and `lceda_export` are read-only;
>    `lceda_run`, `lceda_pour`, `lceda_sch_wire`, `lceda_sch_netlist` and `lceda_route`
>    can change files — tell me what you would run first and wait for my go-ahead.
>
> If anything fails, quote the exact error instead of improvising: every failure message
> names its next step and the README anchor that explains it. Stale sessions are the
> usual cause — `lceda_session {"action":"clean"}` then retry once.

## Configuration

Per-project values ship with **no defaults**: set `projectPath` for your own project
(`pcbUuid` / `schUuid` are derived from it — the first board and the first schematic
page — and only need setting when a project has several), and — for autorouting —
`freeroutingJar` / `sesDirWin`. Add them to the profile that installed the plugin,
under the same `id` the bundle inserted:

```yaml
# <profile>/cordis.patch.yml
- id: dsh-lceda
  name: dsh-lceda
  config:
    projectPath: D:\work\board.eprj3                       # Windows path, opened headless
    # pcbUuid / schUuid: optional, derived from projectPath (first board / first page)
    freeroutingJar: /home/me/freerouting/freerouting.jar   # only for lceda_route
    sesDirWin: D:\work\autoroute                           # only for lceda_route
```

| key | default | meaning |
| --- | --- | --- |
| `exePath` | *(empty)* | Path to `lceda-pro.exe`: WSL `/mnt/d/Program Files/…` or native Windows `D:\Program Files\…`. Empty: auto-detected under `Program Files{, (x86)}` on every drive (WSL `/mnt/<letter>`, Windows existing `C:`–`Z:`), so a D:/E: install works too |
| `spawnCwd` | *(empty)* | cwd for the Windows exe; empty = the drive root of `exePath` (a drive root avoids UNC cwd issues) |
| `projectPath` | *(empty)* | Windows `.eprj3` path opened headless |
| `pcbUuid` | *(empty)* | PCB document id for the `openDocument` prelude; empty = the first board inside `projectPath` |
| `schUuid` | *(empty)* | schematic page id for the `openDocument` prelude; empty = the first schematic page inside `projectPath` |
| `freeroutingJar` | *(empty)* | Freerouting jar; required by `lceda_route` |
| `javaBin` | `java` | Java binary for Freerouting |
| `sesDirWin` | *(empty)* | Windows-visible dir where `board.ses` is placed for import; required by `lceda_route` |
| `workDir` | `.dsh-lceda` | Local dir for DSN/SES/export artifacts, relative to the session workspace |
| `invokeTimeoutMs` | `120000` | default per-invoke budget |
| `routeTimeoutMs` | `900000` | Freerouting budget |
| `reportRepo` | `samuelwhg/dsh-lceda` | GitHub `owner/name` that `lceda_report submit` files into; empty disables submission |
| `allowGuiConcurrent` | `false` | allow writes while a user GUI session is open (dangerous) |

Document ids are the ids `eda.dmt_EditorControl.openDocument` expects; the headless
CLI cannot invent them. A `.eprj3` is plain JSON, so you can read them without the
GUI — the keys of `profile.pcbs` / `profile.sheets` in that file *are* those ids
(first key wins when there are several). Invalid config fails at load with the field
path, e.g. `$.invokeTimeoutMs expected number but got nope`.

## Quickstart

1. Set `projectPath` as above and restart the profile (leave `exePath` empty unless LCEDA Pro is installed somewhere unusual — `lceda_session list` names every path it searched when it cannot find the exe).
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
| `lceda_report` | `list` recorded failures, `submit` one upstream via your own `gh`, `solve` attach the fix |

The bundled `lceda-dev` skill carries the workflow order and the red lines (do not
write while the GUI holds the project, never overwrite `PCB1.epcb2` wholesale, never
pour solid copper on inner signal layers, always re-check all pad nets after
`importChanges`, hand back to the GUI for symbols/teardrops/dialogs).

## API surface and scope

LCEDA Pro publishes no complete plugin SDK, so this plugin drives the editor's in-page
`eda` object from JavaScript and only relies on the API families below — the ones
verified against **LCEDA Pro 4.1.99.7adca3d2** (every call below was checked to exist in
that build). The editor documents its own surface, which beats any table here:
`lceda-pro doc api` lists the classes, `lceda-pro doc api --class-name PCB_Drc` the
methods of one, and `lceda-pro --search <query>` fuzzy-finds a command. See
<https://prodocs.lceda.cn/storage/texts/api/guide/cli-for-ai.md>. This table:

| family | calls used |
| --- | --- |
| editor / documents | `dmt_EditorControl.openDocument`, `waitForDocumentReady`; `pcb_Document.save` / `clearRouting` / `importAutoRouteSesFile`; `sch_Document.save` |
| primitives | `pcb_PrimitiveComponent.getAll` / `getAllPinsByPrimitiveId`, `pcb_PrimitiveLine.getAll`, `pcb_PrimitiveVia.getAll`, `pcb_PrimitivePour.getAll`, `sch_PrimitiveWire.create` |
| checks | `pcb_Drc.check` / `getDrcResult` / `getCurrentRuleConfiguration` / `overwriteCurrentRuleConfiguration` |
| netlist, manufacture, fs | `sch_Netlist.getNetlist`, `pcb_ManufactureData.getDsnFile` and the export entry points, `sys_FileSystem.readFileFromFileSystem` |

Everything else is out of scope: symbol creation, footprint reassignment, teardrops and
some dialogs are GUI-only, and the tools report a handoff instead of faking success.
`lceda_run` can execute arbitrary editor JS, so a call outside this table may still work
on your build — nothing is promised. Probe before relying on one
(`lceda_run {"doc":"pcb","code":"Object.keys(eda)"}`) and treat a missing method as
unavailable. LCEDA Pro updates can rename or drop these calls; when a tool starts
failing with `... is not a function`, that is the signal.

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
  is intentionally empty. `lceda_report submit` shells out to *your* authenticated
  `gh`; the plugin never holds a GitHub token.
- To revoke: remove the plugin (below) or disable its row in the profile.

## Reporting problems

Unexpected failures are recorded automatically, nothing is sent on its own:

- Every `lceda_*` tool wraps its work in a failure recorder. When one fails for a
  reason other than your configuration (errors that name a fix, e.g. a missing
  `projectPath`, are not noise-filed), a record lands in `<workDir>/issues/<id>.json`
  and the tool error names the id.
- Before a record is written, the text is redacted: your home dir becomes `~`,
  absolute paths become `<path>`, `ghp_*` / `github_pat_*` tokens become `<token>`.
  Arguments are kept but truncated and redacted the same way.
- `lceda_report { "action": "list" }` shows the ledger; `{ "action": "submit", "id": ... }`
  files the newest (or that) record as a GitHub issue against `reportRepo` using the
  `gh` you are already logged in with; `{ "action": "solve", "id": ..., "note": "..." }`
  stores what fixed it and comments that on the issue when one exists.

A good agent habit: after the same failure shows up twice, propose `submit`; after
the fix works, call `solve` so the next person inherits the answer.

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
| `LCEDA Pro not found: install it, or set config exePath ...` | install LCEDA Pro, or set `exePath` to `lceda-pro.exe` (WSL `/mnt/d/…`, Windows `D:\…`); the message lists every drive root it probed |
| `cannot start "<exePath>" ... ENOENT` | the configured path does not exist — fix `exePath`, or clear it to fall back to auto-detection |
| `no project path` | pass a `.eprj3` path to `lceda_session open` or set `projectPath` |
| `config pcbUuid is not set` / `schUuid` | set the document id for that board/page (see Configuration) |
| `user GUI session open (...)` | close the GUI, or set `allowGuiConcurrent: true` knowing `.eprj3` sync can overwrite |
| a tool fails with `... is not a function` | your LCEDA Pro build renamed or dropped that call: probe `lceda_run {"code":"Object.keys(eda)"}`, see [API surface and scope](#api-surface-and-scope) |
| `getAll` returns `null`, or the session dies | `lceda_session` `{ "action": "clean" }`, retry; headless canvas subscriptions are fragile |
| DRC crashes the session | `lceda_check` falls back to `getDrcResult`; run `drc` in the GUI for an authoritative report |
| `lceda_route` fails: jar/java missing | set `freeroutingJar`, `javaBin`; `java -version` must work in the same shell |
| Freerouting ends with unrouted nets | raise `routeTimeoutMs` / `passes`, or pre-route those nets; Freerouting does not preserve hand-drawn buses |
| `board.ses` not imported | `sesDirWin` must be a path the Windows editor can read (`D:\...` or `/mnt/d/...`; not a WSL-only path) |
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
them, but through `node:fs` / `node:child_process` directly (export decode to a local
directory, spawning the Windows LCEDA CLI and the Freerouting JVM) rather than the
`ctx.fs` / `ctx.subprocess` seams the static trigger scans for. `tools:register` and
the skill registration are the seam-visible triggers. The declarations stay: they
are accurate, and DSH relies on them for permission preflight.
