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
  exePath: Schema.string().default('/mnt/d/Program Files/lceda-pro/lceda-pro.exe').description('LCEDA Pro CLI executable (WSL path to the Windows exe).'),
  spawnCwd: Schema.string().default('/mnt/c').description('cwd for spawning the Windows exe (drive root avoids UNC cwd issues).'),
  projectPath: Schema.string().default('E:/Workspace/PCB/LCEDA-Pro/projects/JND 模块载板/JND 模块载板.eprj3').description('Windows-side .eprj3 project path opened headless.'),
  pcbUuid: Schema.string().default('339ef6049788a024').description('PCB document uuid for openDocument prelude.'),
  schUuid: Schema.string().default('828a68d880a23ec1').description('Schematic page uuid for openDocument prelude.'),
  freeroutingJar: Schema.string().default('/home/hg/.local/share/dsh-kicad/freerouting/freerouting-2.5.0.jar').description('Freerouting jar path.'),
  javaBin: Schema.string().default('/home/hg/.local/bin/java').description('Java binary for Freerouting.'),
  sesDirWin: Schema.string().default('E:/Workspace/PCB/LCEDA-Pro/projects/_kicad_carrier_src').description('Windows-visible dir where the SES file is placed for importAutoRouteSesFile.'),
  workDir: Schema.string().default('/home/hg/esp/JND/.dsh-lceda').description('WSL dir for DSN/SES/export artifacts.'),
  invokeTimeoutMs: Schema.number().default(120000).description('Default invoke budget in ms.'),
  routeTimeoutMs: Schema.number().default(900000).description('Freerouting run budget in ms.'),
  allowGuiConcurrent: Schema.boolean().default(false).description('Allow write operations while a user GUI session is open (dangerous: two-way .eprj3 sync can overwrite).'),
})
