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
  allowGuiConcurrent: boolean
}

export const Config: Schema<Config> = Schema.object({
  exePath: Schema.string().default('').description('LCEDA Pro CLI executable as a WSL path to the Windows exe. Empty: auto-detected under /mnt/<drive>/Program Files/lceda-pro/ on every mounted drive.'),
  spawnCwd: Schema.string().default('').description('cwd for spawning the Windows exe. Empty: the drive root of exePath (a drive root avoids UNC cwd issues).'),
  projectPath: Schema.string().default('').description('Windows-side .eprj3 project path opened headless. Required: set per project.'),
  pcbUuid: Schema.string().default('').description('PCB document uuid for openDocument prelude. Required: set per project.'),
  schUuid: Schema.string().default('').description('Schematic page uuid for openDocument prelude. Required: set per project.'),
  freeroutingJar: Schema.string().default('').description('Freerouting jar path. Required for lceda_route.'),
  javaBin: Schema.string().default('java').description('Java binary for Freerouting (resolved from PATH by default).'),
  sesDirWin: Schema.string().default('').description('Windows-visible dir where the SES file is placed for importAutoRouteSesFile. Required for lceda_route.'),
  workDir: Schema.string().default('.dsh-lceda').description('WSL dir for DSN/SES/export artifacts (relative paths resolve against the session workspace).'),
  invokeTimeoutMs: Schema.number().default(120000).description('Default invoke budget in ms.'),
  routeTimeoutMs: Schema.number().default(900000).description('Freerouting run budget in ms.'),
  allowGuiConcurrent: Schema.boolean().default(false).description('Allow write operations while a user GUI session is open (dangerous: two-way .eprj3 sync can overwrite).'),
})
