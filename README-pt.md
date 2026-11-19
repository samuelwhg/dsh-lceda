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
