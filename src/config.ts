import Schema from '@deepseek-ai/schemastery'

export interface Config {
  exePath: string
  spawnCwd: string
  projectPath: string
  pcbUuid: string
  schUuid: string
  freeroutingJar: string
  javaBin: string
  sesDirWin: string
  workDir: string
  invokeTimeoutMs: number
  routeTimeoutMs: number
  reportRepo: string
  allowGuiConcurrent: boolean
}

export const Config: Schema<Config> = Schema.object({
  exePath: Schema.string().default('').description('Path to lceda-pro.exe: WSL /mnt/d/Program Files/lceda-pro/lceda-pro.exe, or native Windows D:\\Program Files\\lceda-pro\\lceda-pro.exe. Empty: auto-detected on every mounted drive (WSL: /mnt/<letter>, Windows: existing C:..Z:).'),
  spawnCwd: Schema.string().default('').description('cwd for spawning the Windows exe. Empty: the drive root of exePath (a drive root avoids UNC cwd issues).'),
  projectPath: Schema.string().default('').description('Windows-side .eprj3 opened headless. Leave empty to use the only .eprj3 in the session workspace; set it when a workspace has several.'),
  pcbUuid: Schema.string().default('').description('PCB document uuid for openDocument prelude. Required: set per project.'),
  schUuid: Schema.string().default('').description('Schematic page uuid for openDocument prelude. Required: set per project.'),
  freeroutingJar: Schema.string().default('').description('Freerouting jar path. Required for lceda_route.'),
  javaBin: Schema.string().default('java').description('Java binary for Freerouting (resolved from PATH by default).'),
  sesDirWin: Schema.string().default('').description('Windows-visible dir where the SES file is placed for importAutoRouteSesFile. Required for lceda_route.'),
  workDir: Schema.string().default('.dsh-lceda').description('Local dir for DSN/SES/export artifacts (relative paths resolve against the session workspace).'),
  invokeTimeoutMs: Schema.number().default(120000).description('Default invoke budget in ms.'),
  routeTimeoutMs: Schema.number().default(900000).description('Freerouting run budget in ms.'),
  reportRepo: Schema.string().default('samuelwhg/dsh-lceda').description('GitHub "owner/name" that lceda_report submit files issues into; empty disables submission. Failures are always recorded locally under <workDir>/issues.'),
  allowGuiConcurrent: Schema.boolean().default(false).description('Allow write operations while a user GUI session is open (dangerous: two-way .eprj3 sync can overwrite).'),
})
