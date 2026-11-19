import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  countable,
  draft,
  issueQuery,
  issuesDir,
  listIssues,
  loadIssue,
  recordFailure,
  redact,
  similarLocal,
  solveIssue,
  submitIssue,
} from '../src/issues'

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
  it('records, lists and resolves a failure', async () => {
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

    const done = await solveIssue(dir, found[0].id, 'reran after cleaning zombie sessions')
    expect(done.commented).toBe(false) // no issue URL yet, so nothing to comment on
    expect(listIssues(dir)[0].resolution?.note).toContain('zombie')
  })
})

describe('submission without gh', () => {
  const rec = {
    id: '20261119T000000Z-lceda_run',
    at: '2026-11-19T00:00:00.000Z',
    plugin: 'dsh-lceda@0.1.0',
    tool: 'lceda_run',
    error: 'boom at <path>',
    input: '{"code":"x"}',
    env: { platform: 'linux', node: 'v22.0.0' },
  }

  it('builds a prefilled browser URL', () => {
    const { title, prefilled } = draft('samuelwhg/dsh-lceda', rec, rec.plugin)
    expect(title).toBe('lceda_run: boom at <path>')
    expect(prefilled).toMatch(/^https:\/\/github\.com\/samuelwhg\/dsh-lceda\/issues\/new\?title=/)
    expect(prefilled).toContain(encodeURIComponent('lceda_run: boom at <path>'))
  })

  it('falls back to the URL when gh is missing, and rethrows real gh failures', async () => {
    const dir = issuesDir(fs.mkdtempSync(path.join(os.tmpdir(), 'lceda-submit-')))
    recordFailure({ dir, plugin: rec.plugin, tool: rec.tool, input: rec.input, error: rec.error })

    const noGh = () => Promise.reject(new Error('cannot start "gh": install it'))
    const sub = await submitIssue(dir, 'o/r', rec, rec.plugin, noGh)
    expect(sub.filed).toBe(false)
    expect(sub.prefilled).toContain('github.com/o/r/issues/new')
    expect(sub.hint).toContain('gh is not installed')

    await expect(submitIssue(dir, 'o/r', rec, rec.plugin, () => Promise.reject(new Error('gh exited 1: not logged in')))).rejects.toThrow(/not logged in/)
  })
})

describe('the borrow-then-report loop', () => {
  const rec = {
    id: '20261119T010000Z-lceda_check',
    at: '2026-11-19T01:00:00.000Z',
    plugin: 'dsh-lceda@0.1.0',
    tool: 'lceda_check',
    error: 'drc failed: session crashed while checking copper',
    input: '{"doc":"pcb","what":"drc"}',
    env: { platform: 'linux', node: 'v22.0.0' },
  }

  it('queries the tracker with the tool and the distinctive error words', () => {
    expect(issueQuery(rec)).toContain('lceda_check')
    expect(issueQuery(rec)).toContain('crashed')
  })

  it('finds a local record of the same failure', () => {
    const dir = issuesDir(fs.mkdtempSync(path.join(os.tmpdir(), 'lceda-similar-')))
    recordFailure({ dir, plugin: rec.plugin, tool: rec.tool, input: rec.input, error: new Error('drc failed: session crashed while checking copper') })
    recordFailure({ dir, plugin: rec.plugin, tool: 'lceda_export', input: '{}', error: new Error('gerber export blew up') })
    const hits = similarLocal(dir, { ...rec, id: 'other' })
    expect(hits.map((h) => h.tool)).toEqual(['lceda_check'])
  })

  it('folds into a matching issue and comments the fix instead of opening a new one', async () => {
    const dir = issuesDir(fs.mkdtempSync(path.join(os.tmpdir(), 'lceda-dup-')))
    recordFailure({ dir, plugin: rec.plugin, tool: rec.tool, input: rec.input, error: rec.error })
    const withFix = { ...rec, resolution: { at: '2026-11-19T02:00:00.000Z', note: 'clean the zombie session first' } }
    const calls: string[][] = []
    const exec = (cmd: string, args: string[]) => {
      calls.push([cmd, ...args])
      if (args[0] === 'issue' && args[1] === 'list') {
        return Promise.resolve(JSON.stringify([
          { number: 7, title: 'lceda_check: drc failed: session crashed', url: 'https://github.com/o/r/issues/7', state: 'OPEN', body: 'same' },
        ]))
      }
      return Promise.resolve('')
    }
    const sub = await submitIssue(dir, 'o/r', withFix, rec.plugin, exec)
    expect(sub.filed).toBe(false)
    expect(sub.duplicateOf).toBe('https://github.com/o/r/issues/7')
    expect(sub.commented).toBe(true)
    expect(calls.some((c) => c.includes('create'))).toBe(false) // no duplicate issue filed
    expect(calls.some((c) => c.includes('comment'))).toBe(true)
    expect(loadIssue(dir, rec.id).issueUrl).toBe('https://github.com/o/r/issues/7')
  })

  it('carries the fix in the body of a brand-new issue', () => {
    const { text } = draft('o/r', { ...rec, resolution: { at: '2026-11-19T02:00:00.000Z', note: 'clean first' } }, rec.plugin)
    expect(text).toContain('**Fix that worked**')
    expect(text).toContain('clean first')
  })
})
