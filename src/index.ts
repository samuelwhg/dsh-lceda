import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { Config } from './config'
import type { Config as ConfigShape } from './config'
import { closeSession, guardGui, invoke, listSessions, openHeadless, readyPrelude, RETRY_GETALL } from './cli'
import { b64ToBuffer, connectivity, diffNets, normalizeCsv, parseProtel2 } from './decode'
import type { ConnPad, ConnSeg, ConnVia } from './decode'

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

export const name = 'dsh-lceda'
export const inject = ['tools']
export { Config }

const B64 = `function toB64(buf) { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }\n`

/** Sessions this plugin opened; reused across tool calls. */
const owned: string[] = []

async function resolveSession(cfg: ConfigShape, given?: string): Promise<string> {
  if (given) return given
  const alive = await listSessions(cfg)
  const ids = new Set(alive.map((s) => s.sessionId))
  while (owned.length && !ids.has(owned[owned.length - 1])) owned.pop()
  if (owned.length) return owned[owned.length - 1]
  const id = await openHeadless(cfg)
  owned.push(id)
  return id
}

async function call(cfg: ConfigShape, session: string | undefined, code: string, args?: Record<string, Json>, timeoutMs?: number): Promise<Json> {
  let sid = await resolveSession(cfg, session)
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

function winToWsl(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p)
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : p
}

function jsonRender(_args: unknown, value: unknown) {
  const text = JSON.stringify(value, null, 1)
  return [{ type: 'text' as const, text: text.length > 6000 ? text.slice(0, 6000) + '\n…(truncated)' : text }]
}

export function apply(ctx: Context, config: ConfigShape): void {
  const cfg = config

  ctx.tools.register(defineTool({
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

  ctx.tools.register(defineTool({
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
      const uuid = args.doc === 'pcb' ? cfg.pcbUuid : args.doc === 'sch' ? cfg.schUuid : args.doc
      const code = (uuid ? readyPrelude(uuid) : '') + RETRY_GETALL + args.code
      const value = await call(cfg, args.session, code, args.args as Record<string, Json> | undefined, args.timeoutMs)
      return { value }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'lceda_export',
    description: 'Export manufacturing/design artifacts and decode them to a WSL directory: gerber (zip), bom (csv), pnp (csv), pdf (assembly), netlist (Protel2), svg/png (schematic). CSV UTF-16LE is normalized to UTF-8.',
    parameters: {
      kinds: { type: 'array', items: { type: 'string' }, description: 'Subset of gerber,bom,pnp,pdf,netlist,svg,png (default all).' },
      outDir: { type: 'string', description: 'WSL output dir (default config workDir/exports).' },
      name: { type: 'string', description: 'Base file name (default carrier).' },
      session: { type: 'string' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: jsonRender },
    async execute(args) {
      await guardGui(cfg)
      const kinds = args.kinds?.length ? args.kinds : ['gerber', 'bom', 'pnp', 'pdf', 'netlist', 'svg', 'png']
      const base = args.name ?? 'carrier'
      const code = `${B64}${RETRY_GETALL}
const out = {};
const want = ${JSON.stringify(kinds)};
const base = ${JSON.stringify(base)};
if (want.some((k) => ['gerber','pnp','pdf'].includes(k))) {
  await eda.dmt_EditorControl.openDocument(${JSON.stringify(cfg.pcbUuid)});
  await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(cfg.pcbUuid)}, 30000);
  const M = eda.pcb_ManufactureData;
  if (want.includes('gerber')) { const f = await M.getGerberFile(base + '-gerber', false, 'mm'); out.gerber = toB64(await f.arrayBuffer()); }
  if (want.includes('pnp')) { const f = await M.getPickAndPlaceFile(base + '-pnp', 'csv', 'mm'); out.pnp = toB64(await f.arrayBuffer()); }
  if (want.includes('pdf')) { const f = await M.getPdfFile(base + '-assembly', {}); out.pdf = toB64(await f.arrayBuffer()); }
}
if (want.some((k) => ['bom','netlist','svg','png'].includes(k))) {
  await eda.dmt_EditorControl.openDocument(${JSON.stringify(cfg.schUuid)});
  await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(cfg.schUuid)}, 30000);
  const S = eda.sch_ManufactureData;
  if (want.includes('bom')) { const f = await S.getBomFile(base + '-bom', 'csv'); out.bom = toB64(await f.arrayBuffer()); }
  if (want.includes('netlist')) { const f = await S.getNetlistFile(base + '-net', 'Protel2'); out.netlist = toB64(await f.arrayBuffer()); }
  if (want.includes('svg')) { const f = await S.getSvgFile(base + '-sch'); out.svg = toB64(await f.arrayBuffer()); }
  if (want.includes('png')) { const f = await S.getPngFile(base + '-sch', { width: 2400, height: 1700 }); out.png = toB64(await f.arrayBuffer()); }
}
return out;`
      const map = (await call(cfg, args.session, code, undefined, 240000)) as unknown as Record<string, string>
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

  ctx.tools.register(defineTool({
    name: 'lceda_route',
    description: 'Full autoroute cycle: clearRouting -> export Specctra DSN -> run Freerouting headless -> import SES back. Returns unrouted/violation counts from the Freerouting log and imported track count. Pre-drawn buses are NOT preserved by Freerouting; draw them after import.',
    parameters: {
      passes: { type: 'number', description: 'Freerouting -mp passes (default 100).' },
      session: { type: 'string' },
      workDir: { type: 'string', description: 'WSL dir for dsn/ses/log (default config workDir).' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: jsonRender },
    async execute(args) {
      await guardGui(cfg)
      const dir = args.workDir ?? cfg.workDir
      fs.mkdirSync(dir, { recursive: true })
      const dsnPath = path.join(dir, 'carrier.dsn')
      const sesPath = path.join(dir, 'carrier.ses')
      const logPath = path.join(dir, 'freerouting.log')
      const code1 = `${B64}${RETRY_GETALL}
await eda.dmt_EditorControl.openDocument(${JSON.stringify(cfg.pcbUuid)});
await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(cfg.pcbUuid)}, 30000);
await eda.pcb_Document.clearRouting();
const f = await eda.pcb_ManufactureData.getDsnFile('carrier');
return toB64(await f.arrayBuffer());`
      const b64 = (await call(cfg, args.session, code1, undefined, 180000)) as unknown as string
      fs.writeFileSync(dsnPath, b64ToBuffer(b64))
      const log = fs.openSync(logPath, 'w')
      await new Promise<void>((resolve, reject) => {
        const child = spawn(cfg.javaBin, ['-jar', cfg.freeroutingJar, '-de', dsnPath, '-do', sesPath, '-mp', String(args.passes ?? 100), '--gui.enabled=false'], { cwd: dir, stdio: ['ignore', log, log] })
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Freerouting timeout')) }, cfg.routeTimeoutMs)
        child.on('error', (e) => { clearTimeout(timer); reject(e) })
        child.on('close', () => { clearTimeout(timer); resolve() })
      })
      fs.closeSync(log)
      const logText = fs.readFileSync(logPath, 'utf8')
      const unrouted = /(\d+)\s+unrouted/i.exec(logText)?.[1] ?? null
      const violations = /(\d+)\s+clearance violation/i.exec(logText)?.[1] ?? null
      const sesWin = `${cfg.sesDirWin}/carrier.ses`
      fs.mkdirSync(winToWsl(cfg.sesDirWin), { recursive: true })
      fs.copyFileSync(sesPath, path.join(winToWsl(cfg.sesDirWin), 'carrier.ses'))
      const code2 = `${RETRY_GETALL}
await eda.dmt_EditorControl.openDocument(${JSON.stringify(cfg.pcbUuid)});
await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(cfg.pcbUuid)}, 30000);
const f = await eda.sys_FileSystem.readFileFromFileSystem(${JSON.stringify(sesWin)});
const imported = await eda.pcb_Document.importAutoRouteSesFile(f);
await eda.pcb_Document.save();
const lines = await getAllRetry(() => eda.pcb_PrimitiveLine.getAll());
return { imported, tracks: lines.length };`
      const res = (await call(cfg, args.session, code2, undefined, 180000)) as unknown as { imported: boolean; tracks: number }
      return { ...res, unrouted, violations, dsn: dsnPath, ses: sesPath, log: logPath }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'lceda_check',
    description: 'Verify the board: drc (pcb_Drc.check with getDrcResult fallback; headless check can crash the session), nets (pad nets vs an expected ref|pin->net JSON file), conn (union-find over pads/tracks/vias; pour copper is NOT counted, GND-only-by-pour reads as isolated), all.',
    parameters: {
      mode: { type: 'string', description: 'drc | nets | conn | all (default all).' },
      expectedFile: { type: 'string', description: 'WSL path of expected ref|pin->net JSON for nets mode.' },
      session: { type: 'string' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: jsonRender },
    async execute(args) {
      const mode = args.mode ?? 'all'
      const out: Record<string, Json> = {}
      if (mode === 'drc' || mode === 'all') {
        const code = `${RETRY_GETALL}
await eda.dmt_EditorControl.openDocument(${JSON.stringify(cfg.pcbUuid)});
await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(cfg.pcbUuid)}, 30000);
let ran = false; let result = null; let note = '';
try { result = await eda.pcb_Drc.getDrcResult(); } catch (e) { result = null; }
if (!result) {
  try { await Promise.race([eda.pcb_Drc.check(true, false, false), new Promise((_, rej) => setTimeout(() => rej(new Error('drc-check-timeout')), 20000))]); ran = true; } catch (e) { ran = false; }
  try { result = await eda.pcb_Drc.getDrcResult(); } catch (e) { note = 'headless DRC unavailable (canvas subscription): ' + String(e && e.message || e); }
}
return { ran, result, note };`
        out.drc = (await call(cfg, args.session, code, undefined, 180000)) as Json
      }
      if (mode === 'nets' || mode === 'all') {
        const code = `${RETRY_GETALL}
await eda.dmt_EditorControl.openDocument(${JSON.stringify(cfg.pcbUuid)});
await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(cfg.pcbUuid)}, 30000);
const comps = await getAllRetry(() => eda.pcb_PrimitiveComponent.getAll());
const actual = {};
for (const c of comps) {
  const ref = await c.getState_Designator();
  const pins = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(c.primitiveId);
  for (const p of pins || []) actual[ref + '|' + p.padNumber] = p.net || '';
}
return actual;`
        const actual = (await call(cfg, args.session, code, undefined, 180000)) as unknown as Record<string, string>
        if (args.expectedFile) {
          const expected = JSON.parse(fs.readFileSync(args.expectedFile, 'utf8')) as Record<string, string>
          out.nets = diffNets(actual, expected) as unknown as Json
        } else out.nets = { actual } as unknown as Json
      }
      if (mode === 'conn' || mode === 'all') {
        const code = `${RETRY_GETALL}
await eda.dmt_EditorControl.openDocument(${JSON.stringify(cfg.pcbUuid)});
await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(cfg.pcbUuid)}, 30000);
const comps = await getAllRetry(() => eda.pcb_PrimitiveComponent.getAll());
const pads = [];
for (const c of comps) {
  const ref = await c.getState_Designator();
  const pins = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(c.primitiveId);
  for (const p of pins || []) pads.push({ id: ref + '.' + p.padNumber, net: p.net || '', x: p.x, y: p.y, layer: p.layer ?? 1, through: (p.hole ?? 0) > 0 });
}
const lines = await getAllRetry(() => eda.pcb_PrimitiveLine.getAll());
const segs = lines.map((l) => ({ net: l.net || '', ax: l.startX, ay: l.startY, bx: l.endX, by: l.endY, layer: l.layer }));
const vias = await getAllRetry(() => eda.pcb_PrimitiveVia.getAll());
const vs = vias.map((v) => ({ id: v.primitiveId, net: v.net || '', x: v.x, y: v.y }));
return { pads, segs, vias: vs };`
        const g = (await call(cfg, args.session, code, undefined, 180000)) as unknown as { pads: ConnPad[]; segs: ConnSeg[]; vias: ConnVia[] }
        out.conn = { isolated: connectivity(g.pads, g.segs, g.vias), pads: g.pads.length, segs: g.segs.length, vias: g.vias.length } as unknown as Json
      }
      return out
    },
  }))

  ctx.tools.register(defineTool({
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
await eda.dmt_EditorControl.openDocument(${JSON.stringify(cfg.pcbUuid)});
await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(cfg.pcbUuid)}, 30000);
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
await eda.dmt_EditorControl.openDocument(${JSON.stringify(cfg.pcbUuid)});
await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(cfg.pcbUuid)}, 30000);
const pours = await getAllRetry(() => eda.pcb_PrimitivePour.getAll());
for (const p of pours) await p.rebuildCopperRegion();
await eda.pcb_Document.save();
return { pours: pours.length };`
      return { value: (await call(cfg, args.session, code, undefined, 180000)) as Json }
    },
  }))

  ctx.tools.register(defineTool({
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
await eda.dmt_EditorControl.openDocument(${JSON.stringify(cfg.schUuid)});
await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(cfg.schUuid)}, 30000);
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
      return { value: (await call(cfg, args.session, code, { wires: args.wires as unknown as Json }, 180000)) as Json }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'lceda_sch_netlist',
    description: 'Compile the schematic netlist (Protel2) and optionally diff every ref|pin->net against an expected JSON file. pin.net fields only reflect net labels; this compiled netlist is the source of truth for connectivity.',
    parameters: {
      compareFile: { type: 'string', description: 'WSL path of expected ref|pin->net JSON.' },
      session: { type: 'string' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: jsonRender },
    async execute(args) {
      const code = `${RETRY_GETALL}
await eda.dmt_EditorControl.openDocument(${JSON.stringify(cfg.schUuid)});
await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(cfg.schUuid)}, 30000);
return await eda.sch_Netlist.getNetlist('Protel2');`
      const text = (await call(cfg, args.session, code, undefined, 120000)) as unknown as string
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
