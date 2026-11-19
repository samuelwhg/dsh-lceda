import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Config, needUuid, projectIds } from '../src/index'

/** A minimal `.eprj3`: the document ids are the keys of profile.pcbs / profile.sheets. */
async function fixture(profile: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), 'lceda-eprj3-'))
  const path = join(dir, 'board.eprj3')
  await writeFile(path, JSON.stringify({ name: 'board', profile }))
  return path
}

describe('document ids from the project file', () => {
  it('reads the first board and schematic page id out of a .eprj3', async () => {
    const path = await fixture({ pcbs: { aaa111: {} }, sheets: { bbb222: {} } })
    expect(projectIds(path)).toEqual({ pcb: 'aaa111', sch: 'bbb222' })
  })

  it('lets an explicit config id win over the derived one', async () => {
    const path = await fixture({ pcbs: { aaa111: {} }, sheets: { bbb222: {} } })
    expect(needUuid(Config({ projectPath: path } as never), 'pcb')).toBe('aaa111')
    expect(needUuid(Config({ projectPath: path, pcbUuid: 'explicit' } as never), 'pcb')).toBe('explicit')
  })

  it('names both ways out when neither config nor project provides an id', async () => {
    const path = await fixture({ sheets: { bbb222: {} } })
    expect(() => needUuid(Config({ projectPath: path } as never), 'pcb')).toThrow('pcbUuid is not set')
    expect(() => needUuid(Config({ projectPath: path } as never), 'pcb')).toThrow('contains no board')
    expect(() => needUuid(Config({} as never), 'sch')).toThrow('projectPath is empty')
  })

  it('derives ids again after the project file changes', async () => {
    const path = await fixture({ pcbs: { old: {} } })
    expect(projectIds(path).pcb).toBe('old')
    await writeFile(path, JSON.stringify({ profile: { pcbs: { fresh: {} } } }))
    expect(projectIds(path).pcb).toBe('fresh')
  })
})
