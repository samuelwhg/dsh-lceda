# dsh-lceda

DeepSeek Harness plugin for **LCEDA Pro (嘉立创 EDA)** headless development.

Tools: `lceda_session`, `lceda_run`, `lceda_export`, `lceda_route` (Freerouting),
`lceda_check` (DRC / pad-net diff / connectivity), `lceda_pour`,
`lceda_sch_wire`, `lceda_sch_netlist`. Skill: `lceda-dev` (workflow + red lines).

Wraps the LCEDA Pro CLI (`invoke --code-file -` over stdin, no UNC temp files).
Guards: refuses writes while a user GUI session holds the project (.eprj3 two-way
sync), cleans stale headless sessions, waits for document readiness, decodes
UTF-16LE CSV exports, and never trusts `ok:true` as business success.

Config (cordis.yml): exePath, projectPath, pcbUuid, schUuid, freeroutingJar,
javaBin, sesDirWin, workDir, timeouts, allowGuiConcurrent.

Build: `pnpm install && pnpm build`. Check: `npx dsh-standards . --scope entry`.

## Capability declaration note (DSC-11.5)

`fs:read`, `fs:write` and `subprocess` are declared because the plugin really
uses them, but through `node:fs` / `node:child_process` directly (export decode
to a WSL directory, spawning the Windows LCEDA CLI and the Freerouting JVM)
rather than the `ctx.fs` / `ctx.subprocess` seams the static trigger scans for.
`tools:register` is the only seam-visible trigger. No network egress/ingress,
no credentials, no prompt modification: `dsh.labels` is intentionally empty.
