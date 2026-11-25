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
> 2. Install the `gh` CLI — `lceda_report` uses it to search and file issues. Optional
>    (without it the plugin still records locally and hands you a prefilled issue link),
>    but this is the one dependency a user rarely has: check `gh --version`; if missing,
>    Windows: `winget install --id GitHub.cli`, WSL/Linux: `sudo apt install gh` or the
>    release tarball into `~/.local/bin`, macOS: `brew install gh`. Then have me run
>    `gh auth login` once (or paste a token into `gh auth login --with-token`) and confirm
>    the account can open issues in `reportRepo`.
> 3. Install into that profile — from git:
>    `dsh plugin --profile <profile> add git+https://github.com/samuelwhg/dsh-lceda.git`
>    (from a local checkout: `add /path/to/dsh-lceda`). Then confirm the bundle inserted
>    an `id: dsh-lceda` row.
> 4. Ask me for the `.eprj3` project path and whether this DSH runs several projects in
>    one workspace. Leave `exePath` and `spawnCwd` empty — they are auto-detected
>    (`Program Files{, (x86)}\lceda-pro` on every drive). Only set `exePath` if I say
>    LCEDA Pro lives somewhere unusual.
> 5. Usually write nothing: a session started in the project folder picks up the only
>    `.eprj3` there. Only when the workspace holds several (or I open a project from
>    elsewhere) write `projectPath` into `<profile>/cordis.patch.yml` under the existing
>    `id: dsh-lceda` row — merge into that row, never add a second one. Leave `pcbUuid`
>    and `schUuid` empty: they are derived from the project file (first board / first
>    schematic page). Only set them when my project has several and I want a specific
>    one — the ids are the keys of `profile.pcbs` / `profile.sheets` in the `.eprj3`,
>    which is plain JSON. Add `freeroutingJar` + `sesDirWin` only if I ask for autorouting.
> 6. Restart the profile and verify, reporting each result verbatim:
>    `lceda_session {"action":"list"}` (proves the exe resolves; on failure the error
>    lists every path it probed), `lceda_session {"action":"open"}` (must return a
>    session id), `lceda_run {"code":"return Object.keys(eda).filter(k=>k.startsWith('pcb_')).length"}`
>    (must return a positive count for the PCB API surface).
> 7. Stop before touching the design. `lceda_check` and `lceda_export` are read-only;
>    `lceda_run`, `lceda_pour`, `lceda_sch_wire`, `lceda_sch_netlist` and `lceda_route`
>    can change files — tell me what you would run first and wait for my go-ahead.
>
> If anything fails, quote the exact error instead of improvising: every failure message
> names its next step and the README anchor that explains it. Stale sessions are the
> usual cause — `lceda_session {"action":"clean"}` then retry once.

## Configuration

Most projects need **no configuration at all**: run the session inside the project
folder and the plugin uses the only `.eprj3` it finds there (at most two levels down),
deriving its document ids. Set `projectPath` only when a workspace holds several
projects, and — for autorouting — `freeroutingJar` / `sesDirWin`. Values go on the
profile row that installed the plugin, under the same `id` the bundle inserted:

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
| `projectPath` | *(empty)* | Windows `.eprj3` opened headless. Empty = the only `.eprj3` in the session workspace; set it when there are several |
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

### Where settings live

| what | project level | profile (global) |
| --- | --- | --- |
| which project | where the session runs: the only `.eprj3` under it is used | `projectPath` on the bundle row |
| the `lceda-dev` skill | `<project>/.dsh/skills/lceda-dev/SKILL.md` (or `.agents/skills/…`) outranks the bundled copy | shipped in the package, registered in memory on install |
| the nine tools | — | profile |
| MCP server | not used: the plugin drives `lceda-pro`'s own CLI, so nothing is written to `.dsh/mcp.json` | — |

DSH has no per-project plugin config file: the project is chosen by where the session
runs, everything else is the profile row above. No agent preset is shipped either —
installing the bundle registers the tools and the skill for the whole profile, so any
agent already has them.

## Quickstart

1. Start the session in your project folder — nothing to configure unless the workspace holds several `.eprj3` files (set `projectPath` as above then). Leave `exePath` empty unless LCEDA Pro is installed somewhere unusual: `lceda_session list` names every path it searched when it cannot find the exe.
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
| `lceda_route` | `clearRouting` (skipped with `keepExisting`) → DSN → Freerouting → SES import → save; a zero-track import throws instead of reporting success |
| `lceda_check` | `drc`, pad-net diff against an expected JSON, pad/track/via connectivity (`full: true` for the whole list) |
| `lceda_pour` | rebuild or set connect mode of copper pours |
| `lceda_sch_wire` | draw schematic wires onto exact pin hotspots |
| `lceda_sch_netlist` | compile the schematic netlist |
| `lceda_report` | `list` recorded failures, `submit` one upstream via your own `gh`, `solve` attach the fix |

Long lists come back as a count plus the first rows, with the full list written to
`<workDir>/reports/`; ask for `full: true` when the first rows are not enough. Every
write is followed by a read-back: an import that landed no track is an error, not a
partial success.

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

The loop is borrow-first, then report problem *and* fix together. Nothing leaves the
machine on its own.

1. **Recorded automatically.** Every `lceda_*` tool wraps its work in a failure
   recorder. When one fails for a reason other than your configuration (errors that
   name a fix, e.g. a missing `projectPath`, are not filed as noise), a record lands in
   `<workDir>/issues/<id>.json` and the tool error names the id. Before the record is
   written the text is redacted: home dir → `~`, absolute paths → `<path>`,
   `ghp_*` / `github_pat_*` → `<token>`; arguments are truncated and redacted the same way.
2. **Search before debugging.** `lceda_report { "action": "search", "id": ... }` looks
   for the same failure twice-ish: in the local ledger (with the fix someone already
   recorded) and in the upstream tracker (`gh issue list --search <tool + error words>`).
   A hit with a fix is cheaper than debugging — apply it, then `solve`.
3. **Then solve.** `{ "action": "solve", "id": ..., "note": "cause + what fixed it" }`
   stores the fix in the record.
4. **Then feed it back once.** `{ "action": "submit", "id": ... }` searches upstream for a
   matching issue: a hit gets your fix posted as a comment (no duplicate issue), a miss
   creates one issue whose body carries the error, the call, the environment *and* the
   fix that worked. Either way the record keeps the issue URL.

No `gh` installed? Nothing breaks, and step 2 of the install prompt exists for that:
`winget install --id GitHub.cli` (Windows), `sudo apt install gh` or the release tarball
into `~/.local/bin` (WSL/Linux), `brew install gh` (macOS), then `gh auth login` once —
any missing-`gh` hint repeats the command for the current platform. Beyond that: `search` returns the browser search URL and
`submit` returns the same title/body as a prefilled `github.com/.../issues/new?title=…`
link — no token, no network from the plugin. With `gh`, `submit` uses the login you
already have; the plugin never holds a credential.

`reportRepo` (default `samuelwhg/dsh-lceda`, empty disables the upstream half) decides
where step 2 and 4 look.

A good agent habit: on a failure, `search` first; propose `submit` once the fix is known
or the same failure has shown up twice.

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
| `no project path` / `found N .eprj3 files` | pass a `.eprj3` path, or set `projectPath` when the workspace holds several |
| `config pcbUuid is not set` / `schUuid` | the project has no board/page of that kind — set the document id explicitly (see Configuration) |
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
