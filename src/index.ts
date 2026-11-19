import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DefineToolOptions, ParameterSchemaSpec, ToolDefinition, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { Config } from './config'
import type { Config as ConfigShape } from './config'
import { closeSession, guardGui, invoke, listSessions, openHeadless, readyPrelude, RETRY_GETALL } from './cli'
import { b64ToBuffer, connectivity, diffNets, normalizeCsv, parseProtel2 } from './decode'
import {
  countable,
  issuesDir,
  listIssues,
  loadIssue,
  recordFailure,
  searchIssues,
  searchUrl,
  similarLocal,
  solveIssue,
  submitIssue,
} from './issues'
import type { ConnPad, ConnSeg, ConnVia } from './decode'

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

export const name = 'dsh-lceda'
export const inject = ['tools']
export { Config }

const B64 = `function toB64(buf) { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }\n`

/** Sessions one plugin instance opened; reused across tool calls, closed on dispose. */
type Owned = string[]

async function resolveSession(cfg: ConfigShape, owned: Owned, given?: string): Promise<string> {
  if (given) return given
  const alive = await listSessions(cfg)
  const ids = new Set(alive.map((s) => s.sessionId))
  while (owned.length && !ids.has(owned[owned.length - 1])) owned.pop()
  if (owned.length) return owned[owned.length - 1]
  const id = await openHeadless(cfg)
  owned.push(id)
  return id
}

async function call(cfg: ConfigShape, owned: Owned, session: string | undefined, code: string, args?: Record<string, Json>, timeoutMs?: number): Promise<Json> {
  let sid = await resolveSession(cfg, owned, session)
  try {
    return (await invoke(cfg, sid, code, args, timeoutMs)) as Json
  } catch (e) {
    const msg = String((e as Error).message)
    if (/SESSION_NOT_FOUND|订阅|canvas/i.test(msg) && !session) {
      await closeSession(cfg, sid).catch(() => false)
      const i = owned.indexOf(sid)
      if (i >= 0) owned.splice(i, 1)
      sid = await openHeadless(cfg)
      owned.push(sid)
      return (await invoke(cfg, sid, code, args, timeoutMs)) as Json
    }
    throw e
  }
}

const IS_WIN = process.platform === 'win32'

function winToWsl(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p)
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : p
}

/** Editor-side Windows path -> a path this process can touch (identity unless WSL). */
function toLocal(p: string): string {
  return IS_WIN ? p : winToWsl(p)
}

interface ProjectIds { pcb?: string; sch?: string }

interface CachedIds { mtimeMs: number; size: number; ids: ProjectIds }

/** Document ids derived from a `.eprj3` (plain JSON: profile.pcbs / profile.sheets keys). */
const idCache = new Map<string, CachedIds>()

export function projectIds(projectPath: string): ProjectIds {
  if (!projectPath) return {}
  const local = toLocal(projectPath)
  try {
    const { mtimeMs, size } = fs.statSync(local)
    const hit = idCache.get(local)
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.ids
    const doc = JSON.parse(fs.readFileSync(local, 'utf8')) as { profile?: { pcbs?: object; sheets?: object } }
    const ids: ProjectIds = {
      pcb: Object.keys(doc.profile?.pcbs ?? {})[0],
      sch: Object.keys(doc.profile?.sheets ?? {})[0],
    }
    idCache.set(local, { mtimeMs, size, ids })
    return ids
  } catch {
    return {}
  }
}

/** Configured id, else the first one of that kind inside the configured project. */
export function needUuid(cfg: ConfigShape, kind: 'pcb' | 'sch'): string {
  const what = kind === 'pcb' ? 'board' : 'schematic page'
  const u = (kind === 'pcb' ? cfg.pcbUuid : cfg.schUuid) || projectIds(cfg.projectPath)[kind]
  if (!u) {
    throw new Error(
      `config ${kind}Uuid is not set, and config projectPath ` +
        (cfg.projectPath ? `("${cfg.projectPath}") contains no ${what}` : 'is empty') +
        `: set projectPath to a project that has one, or set ${kind}Uuid directly (see README.md#configuration)`,
    )
  }
  return u
}

const pkg = createRequire(import.meta.url)('../package.json') as { name: string; version: string }
const PLUGIN = `${pkg.name}@${pkg.version}`

/**
 * Record an unexpected failure locally and tell the caller where it went.
 * Errors that already name their fix (README anchor) are configuration problems, not bugs.
 */
function reportFailure(cfg: ConfigShape, tool: string, input: unknown, e: unknown): void {
  if (!countable(e)) return
  const rec = recordFailure({ dir: issuesDir(cfg.workDir), plugin: PLUGIN, tool, input, error: e })
  if (rec && e instanceof Error) {
    e.message +=
      `\n[recorded as ${rec.id} in ${issuesDir(cfg.workDir)}; ` +
      `lceda_report { "action": "submit", "id": "${rec.id}" } files it upstream, "solve" attaches the fix]`
  }
}

/** defineTool plus failure capture: every tool's unexpected error lands in <workDir>/issues. */
function guarded<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(
  cfg: ConfigShape,
  spec: DefineToolOptions<S, O>,
): ToolDefinition {
  // the generic round-trip blows up TS inference; the runtime shape is unchanged
  const t = defineTool(spec as never) as ToolDefinition
  const execute = t.execute.bind(t)
  return {
    ...t,
    execute: async (args: unknown, exec: never) => {
      try {
        return await execute(args, exec)
      } catch (e) {
        reportFailure(cfg, t.name, args, e)
        throw e
      }
    },
  } as ToolDefinition
}

/** Subset of the host skill service this plugin registers into. */
interface SkillsLike {
  register(skill: { name: string, description?: string, source?: string, content: string, resourceBase?: { kind: 'directory', path: string } }): () => void
}

function jsonRender(_args: unknown, value: unknown) {
  const text = JSON.stringify(value, null, 1)
  return [{ type: 'text' as const, text: text.length > 6000 ? text.slice(0, 6000) + '\n…(truncated)' : text }]
}

export function apply(ctx: Context, config: ConfigShape): void {
  const cfg = config

  /** Sessions this plugin instance opened; closed on dispose so a reload leaves no headless CLI behind. */
  const owned: Owned = []
  ctx.effect(() => async () => {
    await Promise.all(owned.splice(0).map((id) => closeSession(cfg, id).catch(() => false)))
  }, 'dsh-lceda owned sessions')


  ctx.tools.register(guarded(cfg, {
    name: 'lceda_report',
    description: 'Failure ledger: unexpected lceda_* errors are recorded under <workDir>/issues with paths and tokens redacted. `list` shows the records; `search` looks for the same failure locally and in the GitHub tracker (borrow the fix if it is known); `solve` stores the fix; `submit` folds the problem+fix into a matching issue or files a new one, through your own authenticated gh CLI (nothing is sent without it).',
    parameters: {
      action: { type: 'string', required: true, description: 'list | search | solve | submit' },
      id: { type: 'string', description: 'Record id from list; default is the newest record.' },
      note: { type: 'string', description: 'solve: one or two sentences on what fixed it.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: jsonRender },
    async execute(args): Promise<Record<string, Json>> {
      const dir = issuesDir(cfg.workDir)
      if (args.action === 'list') {
        const issues = listIssues(dir)
        return {
          dir,
          count: issues.length,
          issues: issues.map((i) => ({
            id: i.id,
            at: i.at,
            tool: i.tool,
            error: i.error.split('\n')[0],
            issueUrl: i.issueUrl ?? '',
            resolution: i.resolution?.note ?? '',
          })),
        }
      }
      if (args.action !== 'search' && args.action !== 'submit' && args.action !== 'solve') {
        throw new Error(`lceda_report action must be list, search, solve or submit, got "${args.action}" (see README.md#tools)`)
      }
      const id = args.id ?? listIssues(dir)[0]?.id
      if (!id) throw new Error(`nothing recorded yet under ${dir}: no failure to ${args.action} (see README.md#reporting-problems)`)
      if (args.action === 'search') {
        const rec = loadIssue(dir, id)
        const local = similarLocal(dir, rec).map((i) => ({
          id: i.id,
          tool: i.tool,
          error: i.error.split('\n')[0],
          resolution: i.resolution?.note ?? '',
          issueUrl: i.issueUrl ?? '',
        }))
        const fixed = local.find((i) => i.resolution)
        if (!cfg.reportRepo) {
          return { id, local, remote: [], hint: 'config reportRepo is empty: no upstream tracker to search (see README.md#configuration)' }
        }
        let remote: Array<{ number: number; title: string; url: string; state: string }> = []
        let hint = 'nothing similar upstream: debug it, then lceda_report solve + submit so the next person inherits the fix'
        try {
          remote = (await searchIssues(cfg.reportRepo, rec)).map((r) => ({
            number: r.number,
            title: r.title,
            url: r.url,
            state: r.state,
          }))
        } catch (e) {
          hint = `could not reach the tracker (${(e as Error).message}); browse ${searchUrl(cfg.reportRepo, rec)} instead`
        }
        if (remote.length) hint = 'read the matching issues before debugging; if one explains it, apply that fix and run solve'
        if (fixed) hint = `local record ${fixed.id} already has a fix: ${fixed.resolution}`
        const own = rec.resolution?.note
        if (own) hint = `this failure is already solved here: ${own} — lceda_report submit feeds it back`
        return { id, local, resolution: own ?? '', remote, hint }
      }
      if (args.action === 'submit') {
        if (!cfg.reportRepo) {
          throw new Error('config reportRepo is empty: set it to "owner/name" to file issues upstream (see README.md#configuration)')
        }
        const rec = loadIssue(dir, id)
        if (rec.issueUrl) {
          return { id, filed: true, issueUrl: rec.issueUrl, duplicateOf: '', commentedOnDuplicate: false, prefilled: '', hint: '', alreadyFiled: true }
        }
        const sub = await submitIssue(dir, cfg.reportRepo, rec, PLUGIN)
        return {
          id,
          filed: sub.filed,
          issueUrl: sub.issueUrl,
          duplicateOf: sub.duplicateOf,
          commentedOnDuplicate: sub.commented,
          prefilled: sub.prefilled,
          hint: sub.hint,
          alreadyFiled: false,
        }
      }
      if (!args.note) throw new Error('lceda_report solve needs note: what fixed it (see README.md#reporting-problems)')
      const { record, commented } = await solveIssue(dir, id, args.note)
      return { id: record.id, resolution: record.resolution?.note ?? '', issueUrl: record.issueUrl ?? '', commentedOnIssue: commented }
    },
  }))

  // The host never scans package skill directories, so the bundled skill must be registered explicitly.
  ctx.inject(['skills'], (sctx) => {
    try {
      const dir = fileURLToPath(new URL('../skills/lceda-dev/', import.meta.url))
      const text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
      const fm = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
      const description = fm ? /^description:[ \t]*(.+?)[ \t]*$/m.exec(fm[1])?.[1]?.trim() : undefined
      const content = (fm ? text.slice(fm[0].length) : text).replace(/^(?:[ \t]*\r?\n)+/, '')
      const skills = (sctx as unknown as { skills: SkillsLike }).skills
      sctx.effect(() => skills.register({ name: 'lceda-dev', source: 'bundled', description, content, resourceBase: { kind: 'directory', path: dir } }), 'dsh-lceda skill lceda-dev')
    } catch (e) {
      console.warn(`dsh-lceda: skill lceda-dev not registered: ${String((e as Error).message)}`)
    }
  })

  ctx.tools.register(guarded(cfg, {
    name: 'lceda_session',
    description: 'Manage LCEDA Pro headless sessions: open (headless, returns sessionId), list, close (destroy), clean (close stale CLI-origin sessions not owned by this plugin). User GUI sessions are never closed.',
    parameters: {
      action: { type: 'string', required: true, description: 'open | list | close | clean' },
      path: { type: 'string', description: 'Windows .eprj3 path for open (default config projectPath).' },
      session: { type: 'string', description: 'Session id for close.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: jsonRender },
    async execute(args) {
      if (args.action === 'list') return { sessions: await listSessions(cfg) } as unknown as Record<string, Json>
      if (args.action === 'open') {
        const id = await openHeadless(cfg, args.path)
        owned.push(id)
        return { sessionId: id } as unknown as Record<string, Json>
      }
      if (args.action === 'close') {
        const id = args.session ?? owned.pop()
        if (!id) throw new Error('no session to close')
        return { closed: id, ok: await closeSession(cfg, id) } as unknown as Record<string, Json>
      }
      if (args.action === 'clean') {
        const sessions = await listSessions(cfg)
        const closed: string[] = []
        for (const s of sessions) {
          if (s.origin === 'cli' && !owned.includes(s.sessionId)) {
            if (await closeSession(cfg, s.sessionId)) closed.push(s.sessionId)
          }
        }
        return { closed } as unknown as Record<string, Json>
      }
      throw new Error(`unknown action ${args.action}`)
    },
  }))

  ctx.tools.register(guarded(cfg, {
    name: 'lceda_run',
    description: 'Run editor JavaScript in a headless LCEDA session (eda namespace, async body, return value reported). doc=pcb|sch opens+waits for that document first. ok:true only means the code ran: validate business results inside the code and throw on failure. Write ops refuse while a user GUI session is open.',
    parameters: {
      code: { type: 'string', required: true, description: 'Async function body using eda.*; return a JSON-serializable result.' },
      args: { type: 'object', additionalProperties: true, description: 'Passed to the code as __CLI__.args.' },
      session: { type: 'string', description: 'Session id (default: plugin-owned headless session, opened on demand).' },
      doc: { type: 'string', description: 'pcb | sch | <uuid>: openDocument + waitForDocumentReady prelude.' },
      timeoutMs: { type: 'number', description: 'Invoke budget ms (default config invokeTimeoutMs).' },
      write: { type: 'boolean', description: 'Set true for mutating code to enable the GUI-concurrency guard (default true).' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: jsonRender },
    async execute(args) {
      if (args.write !== false) await guardGui(cfg)
      const uuid = args.doc === 'pcb' ? needUuid(cfg, 'pcb') : args.doc === 'sch' ? needUuid(cfg, 'sch') : args.doc
      const code = (uuid ? readyPrelude(uuid) : '') + RETRY_GETALL + args.code
      const value = await call(cfg, owned, args.session, code, args.args as Record<string, Json> | undefined, args.timeoutMs)
      return { value }
    },
  }))

  ctx.tools.register(guarded(cfg, {
    name: 'lceda_export',
    description: 'Export manufacturing/design artifacts and decode them to a local directory: gerber (zip), bom (csv), pnp (csv), pdf (assembly), netlist (Protel2), svg/png (schematic). CSV UTF-16LE is normalized to UTF-8.',
    parameters: {
      kinds: { type: 'array', items: { type: 'string' }, description: 'Subset of gerber,bom,pnp,pdf,netlist,svg,png (default all).' },
      outDir: { type: 'string', description: 'Output dir (default config workDir/exports); WSL: /mnt/..., Windows: D:\\...' },
      name: { type: 'string', description: 'Base file name (default board).' },
      session: { type: 'string' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: jsonRender },
    async execute(args) {
      await guardGui(cfg)
      const kinds = args.kinds?.length ? args.kinds : ['gerber', 'bom', 'pnp', 'pdf', 'netlist', 'svg', 'png']
      const base = args.name ?? 'board'
      const code = `${B64}${RETRY_GETALL}
const out = {};
const want = ${JSON.stringify(kinds)};
const base = ${JSON.stringify(base)};
if (want.some((k) => ['gerber','pnp','pdf'].includes(k))) {
  await eda.dmt_EditorControl.openDocument(${JSON.stringify(needUuid(cfg, 'pcb'))});
  await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(needUuid(cfg, 'pcb'))}, 30000);
  const M = eda.pcb_ManufactureData;
  if (want.includes('gerber')) { const f = await M.getGerberFile(base + '-gerber', false, 'mm'); out.gerber = toB64(await f.arrayBuffer()); }
  if (want.includes('pnp')) { const f = await M.getPickAndPlaceFile(base + '-pnp', 'csv', 'mm'); out.pnp = toB64(await f.arrayBuffer()); }
  if (want.includes('pdf')) { const f = await M.getPdfFile(base + '-assembly', {}); out.pdf = toB64(await f.arrayBuffer()); }
}
if (want.some((k) => ['bom','netlist','svg','png'].includes(k))) {
  await eda.dmt_EditorControl.openDocument(${JSON.stringify(needUuid(cfg, 'sch'))});
  await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(needUuid(cfg, 'sch'))}, 30000);
  const S = eda.sch_ManufactureData;
  if (want.includes('bom')) { const f = await S.getBomFile(base + '-bom', 'csv'); out.bom = toB64(await f.arrayBuffer()); }
  if (want.includes('netlist')) { const f = await S.getNetlistFile(base + '-net', 'Protel2'); out.netlist = toB64(await f.arrayBuffer()); }
  if (want.includes('svg')) { const f = await S.getSvgFile(base + '-sch'); out.svg = toB64(await f.arrayBuffer()); }
  if (want.includes('png')) { const f = await S.getPngFile(base + '-sch', { width: 2400, height: 1700 }); out.png = toB64(await f.arrayBuffer()); }
}
return out;`
      const map = (await call(cfg, owned, args.session, code, undefined, 240000)) as unknown as Record<string, string>
      const dir = args.outDir ?? path.join(cfg.workDir, 'exports')
      fs.mkdirSync(dir, { recursive: true })
      const files: { kind: string; file: string; bytes: number }[] = []
      const ext: Record<string, string> = { gerber: 'zip', bom: 'csv', pnp: 'csv', pdf: 'pdf', netlist: 'net', svg: 'svg', png: 'png' }
      for (const [kind, b64] of Object.entries(map)) {
        let buf = b64ToBuffer(b64)
        if (kind === 'bom' || kind === 'pnp') buf = normalizeCsv(buf)
        const file = path.join(dir, `${base}-${kind === 'gerber' ? 'gerber' : kind}.${ext[kind]}`)
        fs.writeFileSync(file, buf)
        files.push({ kind, file, bytes: buf.length })
      }
      return { files }
    },
  }))

  ctx.tools.register(guarded(cfg, {
    name: 'lceda_route',
    description: 'Full autoroute cycle: clearRouting -> export Specctra DSN -> run Freerouting headless -> import SES back. Returns unrouted/violation counts from the Freerouting log and imported track count. Pre-drawn buses are NOT preserved by Freerouting; draw them after import.',
    parameters: {
      passes: { type: 'number', description: 'Freerouting -mp passes (default 100).' },
      session: { type: 'string' },
      workDir: { type: 'string', description: 'Dir for dsn/ses/log (default config workDir); WSL: /mnt/..., Windows: D:\\...' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: jsonRender },
    async execute(args) {
      if (!cfg.freeroutingJar || !cfg.sesDirWin) throw new Error('lceda_route requires config freeroutingJar and sesDirWin (see README.md#configuration)')
      await guardGui(cfg)
      const dir = args.workDir ?? cfg.workDir
      fs.mkdirSync(dir, { recursive: true })
      const dsnPath = path.join(dir, 'board.dsn')
      const sesPath = path.join(dir, 'board.ses')
      const logPath = path.join(dir, 'freerouting.log')
      const code1 = `${B64}${RETRY_GETALL}
await eda.dmt_EditorControl.openDocument(${JSON.stringify(needUuid(cfg, 'pcb'))});
await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(needUuid(cfg, 'pcb'))}, 30000);
await eda.pcb_Document.clearRouting();
const f = await eda.pcb_ManufactureData.getDsnFile('board');
return toB64(await f.arrayBuffer());`
      const b64 = (await call(cfg, owned, args.session, code1, undefined, 180000)) as unknown as string
      fs.writeFileSync(dsnPath, b64ToBuffer(b64))
      const log = fs.openSync(logPath, 'w')
      await new Promise<void>((resolve, reject) => {
        const child = spawn(cfg.javaBin, ['-jar', cfg.freeroutingJar, '-de', dsnPath, '-do', sesPath, '-mp', String(args.passes ?? 100), '--gui.enabled=false'], { cwd: dir, stdio: ['ignore', log, log] })
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Freerouting timeout')) }, cfg.routeTimeoutMs)
        child.on('error', (e) => { clearTimeout(timer); reject(new Error(`cannot start "${cfg.javaBin}" (${e.message}): set config javaBin to a working Java runtime (see README.md#troubleshooting)`)) })
        child.on('close', () => { clearTimeout(timer); resolve() })
      })
      fs.closeSync(log)
      const logText = fs.readFileSync(logPath, 'utf8')
      const unrouted = /(\d+)\s+unrouted/i.exec(logText)?.[1] ?? null
      const violations = /(\d+)\s+clearance violation/i.exec(logText)?.[1] ?? null
      const sesDir = cfg.sesDirWin.replace(/[\\/]+$/, '')
      const sesWin = `${sesDir}${sesDir.includes('\\') ? '\\' : '/'}board.ses`
      fs.mkdirSync(toLocal(cfg.sesDirWin), { recursive: true })
      fs.copyFileSync(sesPath, path.join(toLocal(cfg.sesDirWin), 'board.ses'))
      const code2 = `${RETRY_GETALL}
await eda.dmt_EditorControl.openDocument(${JSON.stringify(needUuid(cfg, 'pcb'))});
await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(needUuid(cfg, 'pcb'))}, 30000);
const f = await eda.sys_FileSystem.readFileFromFileSystem(${JSON.stringify(sesWin)});
const imported = await eda.pcb_Document.importAutoRouteSesFile(f);
await eda.pcb_Document.save();
const lines = await getAllRetry(() => eda.pcb_PrimitiveLine.getAll());
return { imported, tracks: lines.length };`
      const res = (await call(cfg, owned, args.session, code2, undefined, 180000)) as unknown as { imported: boolean; tracks: number }
      return { ...res, unrouted, violations, dsn: dsnPath, ses: sesPath, log: logPath }
    },
  }))

  ctx.tools.register(guarded(cfg, {
    name: 'lceda_check',
    description: 'Verify the board: drc (pcb_Drc.check with getDrcResult fallback; headless check can crash the session), nets (pad nets vs an expected ref|pin->net JSON file), conn (union-find over pads/tracks/vias; pour copper is NOT counted, GND-only-by-pour reads as isolated), all.',
    parameters: {
      mode: { type: 'string', description: 'drc | nets | conn | all (default all).' },
      expectedFile: { type: 'string', description: 'Path of expected ref|pin->net JSON for nets mode.' },
      session: { type: 'string' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: jsonRender },
    async execute(args) {
      const mode = args.mode ?? 'all'
      const out: Record<string, Json> = {}
      if (mode === 'nets' || mode === 'all') {
        const code = `${RETRY_GETALL}
await eda.dmt_EditorControl.openDocument(${JSON.stringify(needUuid(cfg, 'pcb'))});
await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(needUuid(cfg, 'pcb'))}, 30000);
const comps = await getAllRetry(() => eda.pcb_PrimitiveComponent.getAll());
const actual = {};
for (const c of comps) {
  const ref = await c.getState_Designator();
  const pins = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(c.primitiveId);
  for (const p of pins || []) actual[ref + '|' + p.padNumber] = p.net || '';
}
return actual;`
        const actual = (await call(cfg, owned, args.session, code, undefined, 180000)) as unknown as Record<string, string>
        if (args.expectedFile) {
          const expected = JSON.parse(fs.readFileSync(args.expectedFile, 'utf8')) as Record<string, string>
          out.nets = diffNets(actual, expected) as unknown as Json
        } else out.nets = { actual } as unknown as Json
      }
      if (mode === 'conn' || mode === 'all') {
        const code = `${RETRY_GETALL}
await eda.dmt_EditorControl.openDocument(${JSON.stringify(needUuid(cfg, 'pcb'))});
await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(needUuid(cfg, 'pcb'))}, 30000);
const comps = await getAllRetry(() => eda.pcb_PrimitiveComponent.getAll());
const pads = [];
for (const c of comps) {
  const ref = await c.getState_Designator();
  const pins = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(c.primitiveId);
  for (const p of pins || []) pads.push({ id: ref + '.' + p.padNumber, net: p.net || '', x: p.x, y: p.y, layer: p.layer ?? 1, through: (Array.isArray(p.hole) ? (p.hole[1] ?? 0) > 0 : (p.hole ?? 0) > 0) || p.layer === 12 });
}
const lines = await getAllRetry(() => eda.pcb_PrimitiveLine.getAll());
const segs = lines.map((l) => ({ net: l.net || '', ax: l.startX, ay: l.startY, bx: l.endX, by: l.endY, layer: l.layer }));
const vias = await getAllRetry(() => eda.pcb_PrimitiveVia.getAll());
const vs = vias.map((v) => ({ id: v.primitiveId, net: v.net || '', x: v.x, y: v.y }));
return { pads, segs, vias: vs };`
        const g = (await call(cfg, owned, args.session, code, undefined, 180000)) as unknown as { pads: ConnPad[]; segs: ConnSeg[]; vias: ConnVia[] }
        out.conn = { isolated: connectivity(g.pads, g.segs, g.vias), pads: g.pads.length, segs: g.segs.length, vias: g.vias.length } as unknown as Json
      }
      if (mode === 'drc' || mode === 'all') {
        const code = `${RETRY_GETALL}
await eda.dmt_EditorControl.openDocument(${JSON.stringify(needUuid(cfg, 'pcb'))});
await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(needUuid(cfg, 'pcb'))}, 30000);
let ran = false; let result = null; let note = '';
try { result = await eda.pcb_Drc.getDrcResult(); } catch (e) { result = null; }
if (!result) {
  try { await Promise.race([eda.pcb_Drc.check(true, false, false), new Promise((_, rej) => setTimeout(() => rej(new Error('drc-check-timeout')), 20000))]); ran = true; } catch (e) { ran = false; }
  try { result = await eda.pcb_Drc.getDrcResult(); } catch (e) { note = 'headless DRC unavailable (canvas subscription): ' + String(e && e.message || e); }
}
return { ran, result, note };`
        out.drc = (await call(cfg, owned, args.session, code, undefined, 180000)) as Json
      }
      return out
    },
  }))

  ctx.tools.register(guarded(cfg, {
    name: 'lceda_pour',
    description: 'Copper pour maintenance: rebuild (rebuildCopperRegion on every pour + save; create does NOT fill), connectMode (set pad/track connect mode 0=none 1=thermal 2=solid in the DRC rule config via single-arg overwriteCurrentRuleConfiguration, then rebuild). Inner layers must not carry solid pour when inner signal tracks exist.',
    parameters: {
      action: { type: 'string', required: true, description: 'rebuild | connectMode' },
      mode: { type: 'number', description: 'connectMode value 0|1|2 for connectMode action (default 2).' },
      session: { type: 'string' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: jsonRender },
    async execute(args) {
      await guardGui(cfg)
      const code = args.action === 'connectMode'
        ? `${RETRY_GETALL}
await eda.dmt_EditorControl.openDocument(${JSON.stringify(needUuid(cfg, 'pcb'))});
await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(needUuid(cfg, 'pcb'))}, 30000);
const r = await eda.pcb_Drc.getCurrentRuleConfiguration();
const c = r.config; const mode = ${args.mode ?? 2};
const cz = c.Plane['Copper Zone'].copperRegion.form;
for (const key of ['singleLayerPadModel','multiLayerPadModel']) for (const k of Object.keys(cz[key].data)) cz[key].data[k].connectMode = mode;
for (const k of Object.keys(cz.trackConnectModel.data)) cz.trackConnectModel.data[k].trackConnectMode = mode;
const pz = c.Plane['Plane Zone']; if (pz && pz.innerPlane) for (const k of Object.keys(pz.innerPlane.data)) pz.innerPlane.data[k].connectMode = mode;
await eda.pcb_Drc.overwriteCurrentRuleConfiguration(c);
const pours = await getAllRetry(() => eda.pcb_PrimitivePour.getAll());
for (const p of pours) await p.rebuildCopperRegion();
await eda.pcb_Document.save();
const after = await eda.pcb_Drc.getCurrentRuleConfiguration();
return { rule: after.name, pours: pours.length };`
        : `${RETRY_GETALL}
await eda.dmt_EditorControl.openDocument(${JSON.stringify(needUuid(cfg, 'pcb'))});
await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(needUuid(cfg, 'pcb'))}, 30000);
const pours = await getAllRetry(() => eda.pcb_PrimitivePour.getAll());
for (const p of pours) await p.rebuildCopperRegion();
await eda.pcb_Document.save();
return { pours: pours.length };`
      return { value: (await call(cfg, owned, args.session, code, undefined, 180000)) as Json }
    },
  }))

  ctx.tools.register(guarded(cfg, {
    name: 'lceda_sch_wire',
    description: 'Connect schematic pins with wires (the engineering-conventional method): each wire is a net name plus a polyline through pin hotspots (getAllPinsByPrimitiveId x,y). Wire endpoints must land exactly on pin coordinates. Net labels are decorative; connectivity comes from wire nets.',
    parameters: {
      wires: {
        type: 'array', required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            net: { type: 'string', required: true },
            points: { type: 'array', required: true, items: { type: 'array', items: { type: 'number' } }, description: '[[x,y],[x,y],...] polyline; consecutive points form segments.' },
          },
        },
        description: 'Wires to create.',
      },
      session: { type: 'string' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: jsonRender },
    async execute(args) {
      await guardGui(cfg)
      const code = `${RETRY_GETALL}
await eda.dmt_EditorControl.openDocument(${JSON.stringify(needUuid(cfg, 'sch'))});
await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(needUuid(cfg, 'sch'))}, 30000);
const wires = __CLI__.args.wires;
const ids = [];
for (const w of wires) {
  const line = [];
  for (let i = 0; i + 1 < w.points.length; i++) line.push(w.points[i][0], w.points[i][1], w.points[i + 1][0], w.points[i + 1][1]);
  const prim = await eda.sch_PrimitiveWire.create(line, w.net);
  if (!prim) throw new Error('wire create returned null for net ' + w.net);
  ids.push(prim.primitiveId);
}
await eda.sch_Document.save();
return { created: ids.length, ids };`
      return { value: (await call(cfg, owned, args.session, code, { wires: args.wires as unknown as Json }, 180000)) as Json }
    },
  }))

  ctx.tools.register(guarded(cfg, {
    name: 'lceda_sch_netlist',
    description: 'Compile the schematic netlist (Protel2) and optionally diff every ref|pin->net against an expected JSON file. pin.net fields only reflect net labels; this compiled netlist is the source of truth for connectivity.',
    parameters: {
      compareFile: { type: 'string', description: 'Path of expected ref|pin->net JSON.' },
      session: { type: 'string' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: jsonRender },
    async execute(args) {
      const code = `${RETRY_GETALL}
await eda.dmt_EditorControl.openDocument(${JSON.stringify(needUuid(cfg, 'sch'))});
await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(needUuid(cfg, 'sch'))}, 30000);
return await eda.sch_Netlist.getNetlist('Protel2');`
      const text = (await call(cfg, owned, args.session, code, undefined, 120000)) as unknown as string
      const nl = parseProtel2(text)
      const actual: Record<string, string> = {}
      for (const [ref, pins] of Object.entries(nl.comps)) for (const [pin, net] of Object.entries(pins)) actual[`${ref}|${pin}`] = net
      if (args.compareFile) {
        const expected = JSON.parse(fs.readFileSync(args.compareFile, 'utf8')) as Record<string, string>
        return { nets: Object.keys(nl.nets).length, ...diffNets(actual, expected) } as unknown as Record<string, Json>
      }
      return { nets: Object.keys(nl.nets).length, comps: Object.keys(nl.comps).length, netlist: nl.nets } as unknown as Record<string, Json>
    },
  }))
}
