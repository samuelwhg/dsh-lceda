import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { countable, issuesDir, listIssues, loadIssue, recordFailure, redact } from '../src/issues'

describe('redact', () => {
  it('strips home, absolute paths and tokens but keeps the message', () => {
    const raw =
      `editor exploded at ${os.homedir()}/work/board.eprj3 when opening D:\\Clients\\ACME\\x.epcb2 with gh token ghp_abcdefghijklmnopqrstuvwxyz012345`
    const out = redact(raw)
    expect(out).toMatch(/^editor exploded at /)
    expect(out).toContain('<path>')
    expect(out).toContain('<token>')
    expect(out).not.toContain(os.homedir())
    for (const secret of ['ACME', 'Clients', 'board.epcb2', 'ghp_']) expect(out).not.toContain(secret)
  })
})

describe('countable', () => {
  it('skips errors that already name their fix', () => {
    expect(countable(new Error('config pcbUuid is not set (see README.md#configuration)'))).toBe(false)
    expect(countable(new Error('editor exploded'))).toBe(true)
  })
})

describe('the issue ledger', () => {
  it('records, lists and resolves a failure', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lceda-issues-'))
    const dir = issuesDir(workDir)
    expect(listIssues(dir)).toEqual([])

    const rec = recordFailure({
      dir,
      plugin: 'dsh-lceda@0.1.0',
      tool: 'lceda_run',
      input: { code: 'eda.pcb_Document.save()' },
      error: new Error('boom at D:\\Clients\\ACME\\x.epcb2'),
    })
    expect(rec?.id).toMatch(/^\d{8}T\d{6}Z-lceda_run$/)
    expect(rec?.error).not.toContain('ACME')

    const found = listIssues(dir)
    expect(found).toHaveLength(1)
    expect(loadIssue(dir, found[0].id).tool).toBe('lceda_run')
    expect(() => loadIssue(dir, 'nope')).toThrow(/no issue record "nope".*known ids: /)
  })
})
