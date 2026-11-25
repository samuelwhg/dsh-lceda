import { spawn } from 'node:child_process'
import { access, readdir } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { join, parse } from 'node:path'
import type { Config } from './config'

export interface Envelope {
  ok: boolean
  value?: unknown
  error?: { message?: string; code?: string; cause?: unknown }
  raw: string
}

const IS_WIN = process.platform === 'win32'

/** Relative install locations of the CLI inside a Windows drive root. */
const EXE_TAIL = [
  join('Program Files', 'lceda-pro', 'lceda-pro.exe'),
  join('Program Files (x86)', 'lceda-pro', 'lceda-pro.exe'),
]

/** Candidate exe paths under a list of drive roots (WSL `/mnt/d`, Windows `D:\`). */
export function exeCandidates(roots: string[]): string[] {
  return roots.flatMap((r) => EXE_TAIL.map((t) => join(r, t)))
}

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

/** Drives worth probing: mounted `/mnt/<letter>` on WSL, existing `X:\` roots on Windows. */
export async function driveRoots(
  opts: { platform?: NodeJS.Platform; exists?: (p: string) => Promise<boolean> } = {},
): Promise<string[]> {
  const exists = opts.exists ?? (async (p: string) => (await firstExisting([p])).found !== undefined)
  if ((opts.platform ?? process.platform) === 'win32') {
    const roots: string[] = []
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const root = `${letter}:\\`
      if (await exists(root)) roots.push(root)
    }
    return roots
  }
  const mounts = await readdir('/mnt').catch(() => [] as string[])
  return mounts.filter((d) => /^[a-z]$/i.test(d)).sort().map((d) => `/mnt/${d}`)
}

/** WSL path → the Windows form the LCEDA CLI expects (`/mnt/d/x` → `D:\x`); other paths pass through. */
export function wslToWin(p: string): string {
  const m = /^\/mnt\/([a-z])(\/.*)?$/i.exec(p)
  return m ? `${m[1].toUpperCase()}:${(m[2] ?? '').replace(/\//g, '\\')}` : p
}

const PROJECT_EXT = /\.eprj3$/i

/** `.eprj3` files at or two levels below `dir`: the project-level config, so a project needs no settings. */
export function workspaceProjects(dir = process.cwd(), depth = 2): string[] {
  const found: string[] = []
  const walk = (d: string, left: number): void => {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isFile() && PROJECT_EXT.test(e.name)) found.push(p)
      else if (e.isDirectory() && left > 1 && e.name !== 'node_modules' && e.name !== '.git') walk(p, left - 1)
    }
  }
  walk(dir, depth)
  return found.sort()
}

/** The project to work on: explicit argument, else the only `.eprj3` in the workspace. */
export function soleProject(explicit?: string, dir = process.cwd()): string {
  if (explicit) return explicit
  const hits = workspaceProjects(dir)
  if (hits.length === 1) return wslToWin(hits[0])
  throw new Error(
    (hits.length === 0
      ? 'no project path: pass a .eprj3 path, or set config projectPath, or run in a workspace that has one'
      : `found ${hits.length} .eprj3 files in the workspace, so pick one: pass its path to the tool, or set config projectPath`) +
      (hits.length > 1 ? ` (${hits.map((h) => `"${wslToWin(h)}"`).join(', ')})` : '') +
      ' (see README.md#configuration)',
  )
}

let autoExe: string | undefined

async function detectExe(): Promise<{ found?: string; tried: string[] }> {
  if (autoExe && (await firstExisting([autoExe])).found) return { found: autoExe, tried: [autoExe] }
  const hit = await firstExisting(exeCandidates(await driveRoots()))
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
      `LCEDA Pro not found: install it, or set config exePath to lceda-pro.exe (WSL: /mnt/d/..., Windows: D:\\...)` +
        ` (looked in ${auto.tried.join(', ')}; see README.md#troubleshooting)`,
    )
  }
  return auto.found
}

/** Drive root of a path to the Windows exe (`D:\\` or `/mnt/d`): a drive root is a valid cwd for it. */
export function driveRoot(p: string): string {
  const win = /^([A-Za-z]):[\\/]/.exec(p)
  if (win) return `${win[1].toUpperCase()}:\\`
  const wsl = /^\/mnt\/([a-z])\//i.exec(p)
  return wsl ? `/mnt/${wsl[1].toLowerCase()}` : parse(p).root || '/'
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
  const p = path || cfg.projectPath || soleProject()
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

/**
 * Open the document only when it is not loaded yet, then poll its ready state.
 * `waitForDocumentReady` on an already-open document still costs a full wait, and
 * `openDocument` re-activates the tab, so the ready-state probe keeps repeat calls cheap.
 */
export function readyPrelude(uuid: string, timeoutMs = 30000): string {
  const id = JSON.stringify(uuid)
  return `async function ready(uuid) {
  const probe = eda.dmt_EditorControl.getDocumentReadyState;
  if (!probe) {
    // Older builds: no ready-state probe, fall back to the blocking wait.
    await eda.dmt_EditorControl.openDocument(uuid);
    await eda.dmt_EditorControl.waitForDocumentReady(uuid, ${timeoutMs});
    return;
  }
  let tab;
  let waited = 0;
  for (;;) {
    const st = String(await probe(tab || uuid));
    if (st === 'ready') return;
    if (st === 'failed') throw new Error('document failed to load: ' + uuid);
    // openDocument returns no tab while the project is still loading; retry instead of polling a tab that never came.
    if (!tab) tab = await eda.dmt_EditorControl.openDocument(uuid);
    if (waited > ${timeoutMs}) {
      throw new Error('document not ready after ${timeoutMs}ms: ' + uuid + (tab
        ? ' (the editor handed out a tab but never loaded the document: a stale headless session may still hold this project — run lceda_session { "action": "clean" } and retry)'
        : ' (openDocument returned no tab: the project is still loading, or the document uuid is wrong)'));
    }
    const step = tab ? 100 : 500;
    await new Promise((r) => setTimeout(r, step));
    waited += step;
  }
}
await ready(${id});
`
}

/** getAll can return null right after open; retry with settle. */
export const RETRY_GETALL = `async function getAllRetry(fn, n = 6) { for (let i = 0; i < n; i++) { const r = await fn(); if (r) return r; await new Promise((r2) => setTimeout(r2, 1500)); } throw new Error('getAll stayed null'); }\n`
