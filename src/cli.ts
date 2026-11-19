import { spawn } from 'node:child_process'
import { access, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config } from './config'

export interface Envelope {
  ok: boolean
  value?: unknown
  error?: { message?: string; code?: string; cause?: unknown }
  raw: string
}

/** Relative install locations of the CLI inside a Windows drive root. */
const EXE_TAIL = ['Program Files/lceda-pro/lceda-pro.exe', 'Program Files (x86)/lceda-pro/lceda-pro.exe']

/** First path that exists; `tried` keeps the full miss list for the error text. */
export async function firstExisting(paths: string[]): Promise<{ found?: string; tried: string[] }> {
  for (const p of paths) {
    try {
      await access(p)
      return { found: p, tried: paths }
    } catch { /* keep looking */ }
  }
  return { tried: paths }
}

let autoExe: string | undefined

async function detectExe(): Promise<{ found?: string; tried: string[] }> {
  if (autoExe && (await firstExisting([autoExe])).found) return { found: autoExe, tried: [autoExe] }
  const mounts = await readdir('/mnt').catch(() => [] as string[])
  const drives = mounts.filter((d) => /^[a-z]$/i.test(d)).sort().map((d) => `/mnt/${d}`)
  const hit = await firstExisting(drives.flatMap((r) => EXE_TAIL.map((t) => join(r, t))))
  if (hit.found) autoExe = hit.found
  return hit
}

/** exePath if it exists, else autodetect on any mounted Windows drive (D:, E:, …). */
export async function resolveExe(cfg: Config): Promise<string> {
  if (cfg.exePath) {
    if ((await firstExisting([cfg.exePath])).found) return cfg.exePath
    const auto = await detectExe()
    throw new Error(
      `cannot find "${cfg.exePath}" (config exePath)` +
        (auto.found ? `; lceda-pro.exe was auto-detected at ${auto.found}` : `; not found in ${auto.tried.join(', ')}`) +
        ' (see README.md#troubleshooting)',
    )
  }
  const auto = await detectExe()
  if (!auto.found) {
    throw new Error(
      `LCEDA Pro not found: install it, or set config exePath to lceda-pro.exe as a WSL path` +
        ` (looked in ${auto.tried.join(', ')}; see README.md#troubleshooting)`,
    )
  }
  return auto.found
}

/** Drive root of a WSL path to a Windows exe: a drive root is a valid cwd for it. */
function driveRoot(p: string): string {
  const m = /^\/mnt\/([a-z])\//i.exec(p)
  return m ? `/mnt/${m[1]}` : '/'
}

/** Spawn the Windows CLI and parse its single JSON envelope from stdout. */
export async function runCli(cfg: Config, args: string[], stdin?: string, timeoutMs = 120000): Promise<Envelope> {
  const exe = await resolveExe(cfg)
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: cfg.spawnCwd || driveRoot(exe) })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`lceda CLI timeout after ${timeoutMs}ms: ${args.join(' ')}`))
    }, timeoutMs)
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`cannot start "${exe}" (${e.message}): check permissions on the install dir, or set config exePath (see README.md#troubleshooting)`))
    })
    child.on('close', () => {
      clearTimeout(timer)
      const text = out.trim()
      try {
        const o = JSON.parse(text) as Envelope
        resolve({ ok: !!o.ok, value: o.value, error: o.error, raw: text })
      } catch {
        resolve({ ok: false, error: { message: `non-JSON CLI output: ${text.slice(0, 400)} ${err.slice(0, 200)}` }, raw: text })
      }
    })
    if (stdin !== undefined) child.stdin.write(stdin)
    child.stdin.end()
  })
}

export interface SessionInfo { sessionId: string; origin?: string; projectPath?: string; title?: string }

export async function listSessions(cfg: Config): Promise<SessionInfo[]> {
  const env = await runCli(cfg, ['session', 'list'], undefined, 30000)
  const v = env.value as { sessions?: SessionInfo[] } | SessionInfo[] | undefined
  if (Array.isArray(v)) return v
  if (v && Array.isArray(v.sessions)) return v.sessions
  return []
}

export async function openHeadless(cfg: Config, path?: string): Promise<string> {
  const p = path ?? cfg.projectPath
  if (!p) throw new Error('no project path: pass a .eprj3 path or set config projectPath (see README.md#configuration)')
  const env = await runCli(cfg, ['open', '--headless', 'true', '--path', p], undefined, 90000)
  if (!env.ok) throw new Error(`open failed: ${env.error?.message ?? env.raw.slice(0, 300)}`)
  const v = env.value as { sessionId?: string }
  if (!v?.sessionId) throw new Error(`open returned no sessionId: ${env.raw.slice(0, 300)}`)
  return v.sessionId
}

export async function closeSession(cfg: Config, sessionId: string, destroy = true): Promise<boolean> {
  const args = ['session', 'close', '--session', sessionId]
  if (destroy) args.push('--destroy')
  const env = await runCli(cfg, args, undefined, 30000)
  return env.ok
}

/** Invoke editor JS through stdin (--code-file -): no UNC paths, no temp files. */
export async function invoke(cfg: Config, sessionId: string, code: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
  const argv = ['invoke', '--session', sessionId, '--ext-uuid', 'eda', '--code-file', '-', '--timeout', String(timeoutMs ?? cfg.invokeTimeoutMs)]
  if (args !== undefined) argv.push('--args', JSON.stringify(args))
  const env = await runCli(cfg, argv, code, (timeoutMs ?? cfg.invokeTimeoutMs) + 30000)
  if (!env.ok) throw new Error(`invoke failed: ${env.error?.message ?? env.raw.slice(0, 400)}`)
  return env.value
}

/** Refuse writes while the user's GUI holds the project (.eprj3 two-way sync). */
export async function guardGui(cfg: Config): Promise<void> {
  if (cfg.allowGuiConcurrent) return
  const sessions = await listSessions(cfg)
  const gui = sessions.filter((s) => s.origin === 'user')
  if (gui.length) throw new Error(`user GUI session open (${gui.map((s) => s.sessionId).join(', ')}); close it first or set allowGuiConcurrent. Two-way .eprj3 sync would race headless writes.`)
}

export function readyPrelude(uuid: string): string {
  return `await eda.dmt_EditorControl.openDocument(${JSON.stringify(uuid)});\nawait eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(uuid)}, 30000);\n`
}

/** getAll can return null right after open; retry with settle. */
export const RETRY_GETALL = `async function getAllRetry(fn, n = 6) { for (let i = 0; i < n; i++) { const r = await fn(); if (r) return r; await new Promise((r2) => setTimeout(r2, 1500)); } throw new Error('getAll stayed null'); }\n`
