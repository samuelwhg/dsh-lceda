import { EventEmitter } from 'node:events'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectivity, diffNets, normalizeCsv, parseProtel2 } from '../src/decode'
import { apply, Config } from '../src/index'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

/** Minimal CLI child: emits one JSON envelope on stdout, then closes. */
function cliChild(envelope: unknown) {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { write() {}, end() {} }
  child.kill = () => true
  queueMicrotask(() => {
    ;(child.stdout as EventEmitter).emit('data', Buffer.from(JSON.stringify(envelope)))
    child.emit('close')
  })
  return child
}

/** Host surface `apply` touches: tools + effect + the injected skills service. */
function fakeCtx() {
  const tools: Record<string, { execute: (args: Record<string, unknown>) => Promise<unknown> }> = {}
  const skills: Array<{ name: string; description?: string; source?: string; content: string; resourceBase?: { kind: string; path: string } }> = []
  const presets: Array<{ id: string; name?: string; plugins: Array<Record<string, unknown>> }> = []
  const disposers: Array<() => unknown> = []
  // A host that ships the `standard` preset, like the web bundle does.
  const standardRow = { options: { name: '@deepseek-ai/dsh-agent-preset', config: { id: 'standard', order: 1, plugins: [{ id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'base' } }, { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' }] } } }
  let rows: unknown[] = [standardRow]
  const loader = { entries: () => rows as Array<{ options?: { name?: unknown; config?: unknown } }> }
  const listeners: Record<string, () => void> = {}
  const host = {
    /** Simulate the loader finishing a row after our plugin already activated. */
    addStandard: () => { rows = [standardRow] },
    dropStandard: () => { rows = [] },
    emit: (event: string) => listeners[event]?.(),
  }
  const agentPresets = {
    register: async (preset: { id: string; name?: string; plugins: Array<Record<string, unknown>> }) => {
      presets.push(preset)
      return async () => {
        const at = presets.indexOf(preset)
        if (at >= 0) presets.splice(at, 1)
      }
    },
  }
  // cordis runs the effect body immediately and keeps what it returns as the disposer,
  // awaiting it when the body is async.
  const effect = (fn: () => unknown) => {
    const out = fn()
    if (typeof out === 'function') disposers.push(out as () => unknown)
    else if (out && typeof (out as Promise<unknown>).then === 'function') {
      disposers.push(async () => {
        const dispose = await (out as Promise<unknown>)
        if (typeof dispose === 'function') await (dispose as () => unknown)()
      })
    }
  }
  return {
    tools,
    skills,
    presets,
    disposers,
    host,
    ctx: {
      tools: { register: (t: { name: string }) => { tools[t.name] = t as never } },
      effect,
      inject: (_deps: string[], cb: (c: unknown) => void) =>
        cb({
          skills: { register: (s: never) => { skills.push(s); return () => {} } },
          agentPresets,
          loader,
          effect,
          get: (name: string) => (name === 'loader' ? loader : undefined),
          on: (event: string, listener: () => void) => {
            listeners[event] = listener
            return () => delete listeners[event]
          },
        }),
    },
  }
}

describe('normalizeCsv', () => {
  it('converts UTF-16LE BOM csv to utf8', () => {
    const src = '位号,值\nR1,10k\n'
    const buf = Buffer.from('\ufeff' + src, 'utf16le')
    expect(normalizeCsv(buf).toString('utf8')).toBe(src)
  })
  it('leaves utf8 untouched', () => {
    const buf = Buffer.from('a,b\n1,2\n', 'utf8')
    expect(normalizeCsv(buf).toString('utf8')).toBe('a,b\n1,2\n')
  })
})

describe('parseProtel2', () => {
  const text = ['[', 'C5', 'CAP-0805', ']', '(', 'GND', 'C5-1 CAP-0805-1 Passive', 'U1-7 QFN-32-7 Passive', ')', '(', 'VSYS', 'C5-2 CAP-0805-2 Passive', ')'].join('\n')
  it('maps component pins to nets', () => {
    const nl = parseProtel2(text)
    expect(nl.comps.C5['1']).toBe('GND')
    expect(nl.comps.C5['2']).toBe('VSYS')
    expect(nl.comps.U1['7']).toBe('GND')
  })
  it('collects net nodes', () => {
    const nl = parseProtel2(text)
    expect(nl.nets.GND).toEqual(['C5-1', 'U1-7'])
  })
  it('handles refs containing underscores and dashes in pin suffix', () => {
    const nl = parseProtel2(['[', 'R_MISO', ']', '(', 'PN532_MISO', 'R_MISO-2 x Passive', ')'].join('\n'))
    expect(nl.comps.R_MISO['2']).toBe('PN532_MISO')
  })
})

describe('connectivity', () => {
  it('joins pad-track-pad chains and reports isolated nets', () => {
    const pads = [
      { id: 'A.1', net: 'N', x: 0, y: 0, layer: 1 },
      { id: 'B.1', net: 'N', x: 100, y: 0, layer: 1 },
      { id: 'C.1', net: 'M', x: 0, y: 50, layer: 1 },
      { id: 'D.1', net: 'M', x: 90, y: 50, layer: 1 },
    ]
    const segs = [{ net: 'N', ax: 0, ay: 0, bx: 100, by: 0, layer: 1 }]
    const iso = connectivity(pads, segs, [])
    expect(iso.N).toBeUndefined()
    expect(iso.M).toEqual(['C.1', 'D.1'])
  })
  it('through pads bridge layers', () => {
    const pads = [
      { id: 'T.1', net: 'N', x: 0, y: 0, layer: 1, through: true },
      { id: 'B.1', net: 'N', x: 0, y: 0, layer: 2 },
    ]
    expect(connectivity(pads, [], []).N).toBeUndefined()
  })
})

describe('diffNets', () => {
  it('counts checked and lists mismatches including missing keys', () => {
    const r = diffNets({ 'R1|1': 'BAT' }, { 'R1|1': 'BAT', 'R1|2': 'GND' })
    expect(r.checked).toBe(2)
    expect(r.mismatches).toEqual([{ key: 'R1|2', actual: '', expected: 'GND' }])
  })
})

describe('unconfigured project guards', () => {
  const { ctx, tools } = fakeCtx()
  apply(ctx as never, Config({} as never))
  it('lceda_run doc=pcb fails clearly when pcbUuid is unset', async () => {
    await expect(tools.lceda_run.execute({ code: 'return 1', doc: 'pcb', write: false })).rejects.toThrow('pcbUuid is not set')
  })
  it('lceda_route fails clearly when freeroutingJar/sesDirWin are unset', async () => {
    await expect(tools.lceda_route.execute({})).rejects.toThrow('freeroutingJar and sesDirWin')
  })
})

describe('plugin wiring', () => {
  it('registers the bundled lceda-dev skill, red lines included', () => {
    const { ctx, skills } = fakeCtx()
    apply(ctx as never, Config({} as never))
    const skill = skills.find((s) => s.name === 'lceda-dev')
    expect(skill).toBeDefined()
    expect(skill!.source).toBe('bundled')
    expect(skill!.description).toContain('嘉立创')
    expect(skill!.content).toContain('勿整文件覆盖')
    expect(skill!.content.startsWith('---')).toBe(false)
    expect(skill!.resourceBase?.kind).toBe('directory')
  })

  it('registers the lceda preset built from the host standard preset, and drops it on dispose', async () => {
    const { ctx, presets, disposers } = fakeCtx()
    apply(ctx as never, Config({} as never))
    await Promise.resolve()

    expect(presets).toHaveLength(1)
    expect(presets[0].id).toBe('lceda')
    const names = presets[0].plugins.map((p) => p.name)
    expect(names).toContain('@deepseek-ai/dsh-tool-fs')
    expect(names.filter((n) => n === '@deepseek-ai/dsh-persona')).toHaveLength(1)
    const persona = presets[0].plugins[0] as { config: { prefix: string } }
    expect(persona.config.prefix).toContain('lceda_* tools')

    for (const off of disposers) await off()
    expect(presets).toHaveLength(0)
  })

  it('waits for a host preset that loads after the plugin, then registers', async () => {
    const { ctx, presets, host } = fakeCtx()
    host.dropStandard()
    apply(ctx as never, Config({} as never))
    await Promise.resolve()
    expect(presets).toHaveLength(0)

    host.addStandard()
    host.emit('loader/entry-init')
    await Promise.resolve()
    await Promise.resolve()
    expect(presets.map((p) => p.id)).toEqual(['lceda'])
  })

  it('closes the sessions it opened on dispose', async () => {
    spawnMock.mockImplementation(() => cliChild({ ok: true, value: { sessionId: 's1' } }))
    const { ctx, tools, disposers } = fakeCtx()
    apply(ctx as never, Config({ projectPath: 'D:\\work\\board.eprj3', exePath: process.execPath } as never))
    expect(await tools.lceda_session.execute({ action: 'open' })).toEqual({ sessionId: 's1' })

    spawnMock.mockClear()
    spawnMock.mockImplementation(() => cliChild({ ok: true }))
    await (disposers[0] as () => Promise<void>)()
    expect(spawnMock.mock.calls[0]).toEqual([expect.any(String), ['session', 'close', '--session', 's1', '--destroy'], expect.objectContaining({ cwd: expect.any(String) })])
  })
})

describe('failure capture', () => {
  it('records an unexpected tool error and points at lceda_report', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'lceda-work-'))
    spawnMock.mockImplementation(() => cliChild({ ok: false, error: { message: 'editor exploded at D:\\Clients\\ACME\\x.epcb2' } }))
    const { ctx, tools } = fakeCtx()
    apply(ctx as never, Config({ workDir, exePath: process.execPath } as never))
    await expect(tools.lceda_session.execute({ action: 'open', path: 'E:/x/board.eprj3' })).rejects.toThrow(
      /editor exploded[\s\S]*recorded as .*lceda_session/,
    )
    const files = readdirSync(join(workDir, 'issues'))
    expect(files).toHaveLength(1)
    const body = readFileSync(join(workDir, 'issues', files[0]), 'utf8')
    expect(body).not.toContain('ACME') // redacted before it hits disk
    expect(body).toContain('<path>')
    expect(JSON.parse(body).tool).toBe('lceda_session')

    // the borrow-then-report loop: solve here, then search reports that fix back to the agent
    const solved = (await tools.lceda_report.execute({ action: 'solve', note: 'clean stale sessions first' })) as {
      resolution?: string
    }
    expect(solved.resolution).toBe('clean stale sessions first')
    const search = (await tools.lceda_report.execute({ action: 'search' })) as {
      resolution?: string
      hint: string
      local: unknown[]
    }
    expect(search.resolution).toBe('clean stale sessions first')
    expect(search.hint).toContain('already solved here')
    expect(search.hint).toContain('feeds it back')
    expect(search.local).toEqual([]) // only this record exists, and it is not its own duplicate
  })
})
