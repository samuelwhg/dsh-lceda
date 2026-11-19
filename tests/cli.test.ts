import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Config } from '../src/config'
import { firstExisting, resolveExe } from '../src/cli'

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

  it('accepts an existing exePath and rejects a missing one with the path named', async () => {
    expect(await resolveExe(Config({ exePath: process.execPath } as never))).toBe(process.execPath)
    const missing = join(tmpdir(), 'no-such-lceda', 'lceda-pro.exe')
    await expect(resolveExe(Config({ exePath: missing } as never))).rejects.toThrow(`cannot find "${missing}"`)
  })
})
