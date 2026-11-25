import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Config } from '../src/config'
import { driveRoot, driveRoots, exeCandidates, firstExisting, resolveExe, soleProject, workspaceProjects, wslToWin } from '../src/cli'

describe('exe discovery', () => {
  it('returns the first candidate that exists, keeps the miss list', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lceda-exe-'))
    const exe = join(dir, 'lceda-pro.exe')
    await writeFile(exe, '')
    const hit = await firstExisting([join(dir, 'none.exe'), exe])
    expect(hit.found).toBe(exe)
    expect(hit.tried).toEqual([join(dir, 'none.exe'), exe])
    expect((await firstExisting([join(dir, 'none.exe')])).found).toBeUndefined()
  })

  it('probes Program Files and its x86 sibling under every drive root', () => {
    const found = exeCandidates(['R']).map((p) => relative('R', p))
    expect(found).toEqual([
      join('Program Files', 'lceda-pro', 'lceda-pro.exe'),
      join('Program Files (x86)', 'lceda-pro', 'lceda-pro.exe'),
    ])
  })

  it('enumerates existing Windows drive roots and skips absent ones', async () => {
    const roots = await driveRoots({
      platform: 'win32',
      exists: async (p) => p === 'C:\\' || p === 'E:\\',
    })
    expect(roots).toEqual(['C:\\', 'E:\\'])
  })

  it('derives the spawn cwd drive root for WSL and Windows exe paths', () => {
    expect(driveRoot('/mnt/D/Program Files/lceda-pro/lceda-pro.exe')).toBe('/mnt/d')
    expect(driveRoot('D:\\Program Files\\lceda-pro\\lceda-pro.exe')).toBe('D:\\')
    expect(driveRoot('d:/tools/lceda-pro.exe')).toBe('D:\\')
  })

  it('accepts an existing exePath and rejects a missing one with the path named', async () => {
    expect(await resolveExe(Config({ exePath: process.execPath } as never))).toBe(process.execPath)
    const missing = join(tmpdir(), 'no-such-lceda', 'lceda-pro.exe')
    await expect(resolveExe(Config({ exePath: missing } as never))).rejects.toThrow(`cannot find "${missing}"`)
  })
})

describe('project-level default', () => {
  it('converts a workspace path to the Windows form the CLI opens', () => {
    expect(wslToWin('/mnt/d/Work/board.eprj3')).toBe('D:\\Work\\board.eprj3')
    expect(wslToWin('E:/Work/board.eprj3')).toBe('E:/Work/board.eprj3')
  })

  it('finds the only .eprj3 two levels down and ignores node_modules', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lceda-ws-'))
    await writeFile(join(dir, 'a.eprj3'), '{}')
    const other = join(dir, 'sub', 'b.eprj3')
    await mkdir(join(dir, 'sub'), { recursive: true })
    await mkdir(join(dir, 'node_modules'), { recursive: true })
    await writeFile(other, '{}')
    await writeFile(join(dir, 'node_modules', 'c.eprj3'), '{}')
    expect(workspaceProjects(dir)).toEqual([join(dir, 'a.eprj3'), other])
  })

  it('uses the sole project, and refuses when the workspace has several', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lceda-ws-'))
    await writeFile(join(dir, 'only.eprj3'), '{}')
    expect(soleProject(undefined, dir)).toBe(wslToWin(join(dir, 'only.eprj3')))
    await writeFile(join(dir, 'second.eprj3'), '{}')
    expect(() => soleProject(undefined, dir)).toThrow('found 2 .eprj3 files')
    expect(soleProject('C:\\explicit\\x.eprj3', dir)).toBe('C:\\explicit\\x.eprj3')
  })

  it('explains the empty workspace case', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lceda-ws-'))
    expect(() => soleProject(undefined, dir)).toThrow('no project path')
  })
})
