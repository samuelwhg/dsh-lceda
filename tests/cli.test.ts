import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Config } from '../src/config'
import { driveRoot, driveRoots, exeCandidates, firstExisting, resolveExe } from '../src/cli'

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
