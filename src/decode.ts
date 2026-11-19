/** Pure helpers: base64/UTF-16 decoding, Protel2 netlist parsing, connectivity union-find. */

export function b64ToBuffer(b64: string): Buffer {
  return Buffer.from(b64, 'base64')
}

/** LCEDA BOM/PNP CSVs are UTF-16LE; normalize to UTF-8 for downstream tools. */
export function normalizeCsv(buf: Buffer): Buffer {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return Buffer.from(buf.toString('utf16le').replace(/^\ufeff/, ''), 'utf8')
  // BOM-less UTF-16LE: ascii chars interleaved with zero bytes
  const sample = buf.subarray(0, Math.min(buf.length, 200))
  let zeros = 0
  for (let i = 1; i < sample.length; i += 2) if (sample[i] === 0) zeros++
  if (zeros > sample.length / 4) return Buffer.from(buf.toString('utf16le').replace(/^\ufeff/, ''), 'utf8')
  return buf
}

export interface Netlist {
  /** ref -> pin -> net */
  comps: Record<string, Record<string, string>>
  /** net -> node refs like "C5-1" */
  nets: Record<string, string[]>
}

/** Parse a Protel2 netlist: [ component blocks ] then ( netname nodes... ) blocks. */
export function parseProtel2(text: string): Netlist {
  const comps: Netlist['comps'] = {}
  const nets: Netlist['nets'] = {}
  const lines = text.split(/\r?\n/)
  let i = 0
  let curRef: string | null = null
  let inComp = false
  let curNet: string | null = null
  for (; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '[') { inComp = true; curRef = null; continue }
    if (line === ']') { inComp = false; continue }
    if (inComp) {
      // first non-empty line inside a component block is the reference
      if (curRef === null && line && !line.startsWith('*')) curRef = line
      continue
    }
    if (line === '(') { curNet = null; continue }
    if (line === ')') { curNet = null; continue }
    if (curNet === null && line && !line.startsWith('*')) { curNet = line; nets[curNet] = []; continue }
    if (curNet !== null && line) {
      const node = line.split(/\s+/)[0]
      nets[curNet].push(node)
      const dash = node.lastIndexOf('-')
      if (dash > 0) {
        const ref = node.slice(0, dash)
        const pin = node.slice(dash + 1)
        comps[ref] = comps[ref] ?? {}
        comps[ref][pin] = curNet
      }
    }
  }
  return { comps, nets }
}

export interface ConnPad { id: string; net: string; x: number; y: number; layer: number; through?: boolean }
export interface ConnSeg { net: string; ax: number; ay: number; bx: number; by: number; layer: number }
export interface ConnVia { id: string; net: string; x: number; y: number }

/** Union-find connectivity over pads/track endpoints/vias (pour copper NOT counted). */
export function connectivity(pads: ConnPad[], segs: ConnSeg[], vias: ConnVia[], tol = 0.6): Record<string, string[]> {
  const parent = new Map<string, string>()
  const find = (a: string): string => {
    let r = a
    while (parent.get(r) !== r) r = parent.get(r)!
    let c = a
    while (parent.get(c) !== c) { const n = parent.get(c)!; parent.set(c, r); c = n }
    return r
  }
  const union = (a: string, b: string) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb) }
  const add = (id: string) => { if (!parent.has(id)) parent.set(id, id) }
  interface Pt { id: string; net: string; x: number; y: number; layer: number; through?: boolean }
  const pts: Pt[] = [
    ...pads.map((p) => ({ id: p.id, net: p.net, x: p.x, y: p.y, layer: p.layer, through: p.through })),
    ...vias.map((v) => ({ id: v.id, net: v.net, x: v.x, y: v.y, layer: 0, through: true })),
  ]
  for (const p of pts) add(p.id)
  const segPts: Pt[][] = segs.map((s, i) => {
    const a: Pt = { id: `seg${i}a`, net: s.net, x: s.ax, y: s.ay, layer: s.layer }
    const b: Pt = { id: `seg${i}b`, net: s.net, x: s.bx, y: s.by, layer: s.layer }
    add(a.id); add(b.id); union(a.id, b.id)
    return [a, b]
  })
  const all: Pt[] = [...pts, ...segPts.flat()]
  const near = (p: Pt, q: Pt) => Math.abs(p.x - q.x) <= tol && Math.abs(p.y - q.y) <= tol
  const layerOk = (p: Pt, q: Pt) => p.through || q.through || p.layer === q.layer || p.layer === 0 || q.layer === 0
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const p = all[i]; const q = all[j]
      if (p.net !== q.net || !p.net) continue
      if (near(p, q) && layerOk(p, q)) union(p.id, q.id)
    }
  }
  const groups = new Map<string, Set<string>>()
  for (const p of pts) {
    if (!p.net) continue
    const r = find(p.id)
    if (!groups.has(p.net)) groups.set(p.net, new Set())
    groups.get(p.net)!.add(r)
  }
  const isolated: Record<string, string[]> = {}
  for (const [net, roots] of groups) {
    if (roots.size > 1) {
      isolated[net] = pts.filter((p) => p.net === net).map((p) => p.id)
    }
  }
  return isolated
}

/** Diff actual ref|pin->net against expected; empty-string nets mean intentional NC. */
export function diffNets(actual: Record<string, string>, expected: Record<string, string>): { checked: number; mismatches: { key: string; actual: string; expected: string }[] } {
  const mismatches: { key: string; actual: string; expected: string }[] = []
  let checked = 0
  for (const [key, want] of Object.entries(expected)) {
    checked++
    const got = actual[key] ?? ''
    if (got !== want) mismatches.push({ key, actual: got, expected: want })
  }
  return { checked, mismatches }
}
