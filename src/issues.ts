import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Local failure records + upstream submission. Nothing leaves the machine until
 * `lceda_report submit` runs: it shells out to the user's own authenticated `gh`.
 */
export interface IssueRecord {
  id: string
  at: string
  plugin: string
  tool: string
  error: string
  input: string
  env: { platform: string; node: string }
  issueUrl?: string
  resolution?: { at: string; note: string }
}

const PATH_START = /^(?:[A-Za-z]:[\\/]|\/(?:mnt\/[a-z]|home|Users|root|tmp)\/|~[\\/])/

/**
 * Drop what must not leave the machine: home dir, absolute paths, tokens.
 * Paths are scanned token by token so a path with spaces (`D:\Clients\ACME`) is fully
 * covered, including the next whitespace-delimited chunk when it still contains a separator.
 */
export function redact(text: string): string {
  let out = text.split(os.homedir()).join('~')
  out = out.replace(/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '<token>')
  let inPath = false
  return out
    .split(/(\s+)/)
    .map((token) => {
      if (token === '' || /^\s+$/.test(token)) return token
      const bare = token.replace(/[.,:;)]+$/, '')
      if (PATH_START.test(bare)) {
        inPath = true
        return '<path>'
      }
      if (inPath && /[\\/]/.test(bare)) return '<path>' // the rest of a path that contained a space
      inPath = false
      return token
    })
    .join('')
}

export function issuesDir(workDir: string): string {
  return path.join(workDir, 'issues')
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message
  return typeof e === 'string' ? e : JSON.stringify(e)
}

/** Errors that already name their fix are configuration problems, not bugs: skip them. */
export function countable(e: unknown): boolean {
  return !errorText(e).includes('README.md#')
}

export function recordFailure(opts: {
  dir: string
  plugin: string
  tool: string
  input: unknown
  error: unknown
}): IssueRecord | undefined {
  try {
    const at = new Date().toISOString()
    const rec: IssueRecord = {
      id: `${at.replace(/[-:]/g, '').replace(/\..+$/, '')}Z-${opts.tool}`,
      at,
      plugin: opts.plugin,
      tool: opts.tool,
      error: redact(errorText(opts.error)).slice(0, 4000),
      input: redact(JSON.stringify(opts.input ?? {})).slice(0, 800),
      env: { platform: process.platform, node: process.version },
    }
    fs.mkdirSync(opts.dir, { recursive: true })
    fs.writeFileSync(path.join(opts.dir, `${rec.id}.json`), `${JSON.stringify(rec, null, 2)}\n`)
    return rec
  } catch {
    return undefined
  }
}

export function listIssues(dir: string): IssueRecord[] {
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const out: IssueRecord[] = []
  for (const f of files) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as IssueRecord)
    } catch {
      /* ignore a half-written record */
    }
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1))
}

export function loadIssue(dir: string, id: string): IssueRecord {
  const issues = listIssues(dir)
  const hit = issues.find((i) => i.id === id)
  if (!hit) {
    throw new Error(
      `no issue record "${id}" in ${dir}` +
        (issues.length ? `; known ids: ${issues.map((i) => i.id).join(', ')}` : '; nothing recorded yet') +
        ' — run lceda_report { "action": "list" }',
    )
  }
  return hit
}

export function saveIssue(dir: string, rec: IssueRecord): void {
  fs.writeFileSync(path.join(dir, `${rec.id}.json`), `${JSON.stringify(rec, null, 2)}\n`)
}

/** Run a command, resolve with stdout; rejects with stderr so the agent sees the real reason. */
export function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (b: Buffer) => { out += b.toString() })
    child.stderr.on('data', (b: Buffer) => { err += b.toString() })
    child.on('error', (e: NodeJS.ErrnoException) => {
      reject(new Error(e.code === 'ENOENT' ? `cannot start "${cmd}": install it (for issues: gh, from https://cli.github.com) or resolve it another way` : e.message))
    })
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`${cmd} exited ${code}: ${err.trim() || out.trim()}`))))
  })
}

/** Issue title and markdown body for one record, plus a browser fallback with no credentials. */
export function draft(repo: string, rec: IssueRecord, plugin: string): { title: string; text: string; prefilled: string } {
  const title = `${rec.tool}: ${rec.error.split('\n')[0]?.slice(0, 120) ?? 'failed'}`
  const text = [
    `\`${rec.tool}\` failed in ${plugin} (${rec.id}).`,
    '',
    '**Error**',
    '```',
    rec.error,
    '```',
    '',
    '**Call**',
    '```json',
    rec.input,
    '```',
    '',
    '**Environment**',
    `- platform: \`${rec.env.platform}\``,
    `- node: \`${rec.env.node}\``,
    ...(rec.resolution?.note?.trim() ? ['', '**Fix that worked**', rec.resolution.note.trim()] : []),
    '',
    '<!-- filed by lceda_report; paths and tokens were redacted before writing this body -->',
  ].join('\n')
  const prefilled =
    `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(text.slice(0, 3000))}`
  return { title, text, prefilled }
}

/** Words worth searching an issue tracker with: long enough, not a path, not noise. */
function keywords(rec: IssueRecord): string[] {
  const words = `${rec.tool} ${rec.error}`
    .replace(/<path>|<token>|[\\/][^\s]*/g, ' ')
    .toLowerCase()
    .match(/[a-z_][a-z0-9_.-]{3,}/g)
  if (!words) return []
  return [...new Set(words)].slice(0, 8)
}

export function issueQuery(rec: IssueRecord): string {
  return keywords(rec).join(' ')
}

/** Records already on this machine that look like the same failure. */
export function similarLocal(dir: string, rec: IssueRecord): IssueRecord[] {
  const want = new Set(keywords(rec))
  return listIssues(dir).filter((other) => {
    if (other.id === rec.id || other.tool !== rec.tool) return false
    const have = keywords(other)
    const overlap = have.filter((w) => want.has(w)).length
    return overlap >= Math.max(2, Math.min(3, want.size))
  })
}

export interface RemoteIssue {
  number: number
  title: string
  url: string
  state: string
  body: string
}

/** Search the upstream tracker. Only `gh` talks to the network; the plugin never does. */
export async function searchIssues(
  repo: string,
  rec: IssueRecord,
  exec: (cmd: string, args: string[]) => Promise<string> = run,
): Promise<RemoteIssue[]> {
  const query = issueQuery(rec)
  if (!query) return []
  const out = await exec('gh', [
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'all',
    '--limit',
    '5',
    '--search',
    query,
    '--json',
    'number,title,url,state,body',
  ])
  try {
    return JSON.parse(out) as RemoteIssue[]
  } catch {
    return []
  }
}

/** How to get `gh` on this platform: the one thing the user cannot be talked through twice. */
export function ghInstall(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'install it with "winget install --id GitHub.cli"'
  if (platform === 'darwin') return 'install it with "brew install gh"'
  return 'install it with "sudo apt install gh" or the release tarball from https://github.com/cli/cli/releases'
}

/**
 * Recent issues, read straight from the API. GitHub's search index lags a few seconds behind a
 * create, so a failure filed moments ago is invisible to `--search`; listing is not.
 */
export async function recentIssues(
  repo: string,
  exec: (cmd: string, args: string[]) => Promise<string> = run,
  limit = 50,
): Promise<RemoteIssue[]> {
  const out = await exec('gh', ['issue', 'list', '--repo', repo, '--state', 'all', '--limit', String(limit), '--json', 'number,title,url,state,body'])
  try {
    return JSON.parse(out) as RemoteIssue[]
  } catch {
    return []
  }
}

/** Browser search for the same query, used when `gh` is not installed. */
export function searchUrl(repo: string, rec: IssueRecord): string {
  return `https://github.com/${repo}/issues?q=${encodeURIComponent(issueQuery(rec) || rec.tool)}`
}

export interface Submission {
  /** true only when a new issue was created. */
  filed: boolean
  issueUrl: string
  /** An existing issue that already describes this failure; the record was folded into it. */
  duplicateOf: string
  /** Our fix was posted as a comment on that existing issue. */
  commented: boolean
  /** Opens the same issue in a browser; used when `gh` is not installed (no token needed). */
  prefilled: string
  hint: string
}

export function missingTool(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith('cannot start "')
}

/** First search result that reads like the same failure (shared keywords in the title). */
function sameFailure(results: RemoteIssue[], rec: IssueRecord): RemoteIssue | undefined {
  const want = new Set(keywords(rec))
  return results.find((r) => {
    const have = r.title.toLowerCase().match(/[a-z_][a-z0-9_.-]{3,}/g) ?? []
    return have.filter((w) => want.has(w)).length >= 2
  })
}

/**
 * Feed a record upstream through the user's own `gh`: search first, fold into a matching
 * open issue (commenting our fix), and only create when nothing matches. Without `gh`
 * the same title/body come back as a prefilled URL — nothing is sent.
 */
export async function submitIssue(
  dir: string,
  repo: string,
  rec: IssueRecord,
  plugin: string,
  exec: (cmd: string, args: string[]) => Promise<string> = run,
): Promise<Submission> {
  const { title, text, prefilled } = draft(repo, rec, plugin)
  const base = { filed: false, issueUrl: '', duplicateOf: '', commented: false, prefilled, hint: '' }

  let dup = rec.issueUrl
  if (!dup) {
    try {
      dup = sameFailure(await recentIssues(repo, exec), rec)?.url ?? sameFailure(await searchIssues(repo, rec, exec), rec)?.url ?? ''
    } catch (e) {
      if (!missingTool(e)) throw e // a broken gh (auth, network) must surface, not be swallowed
    }
  }

  if (dup) {
    let commented = false
    const note = rec.resolution?.note?.trim()
    if (note) {
      try {
        await exec('gh', ['issue', 'comment', dup, '--body', `Same failure here. Fix that worked:\n\n${note}`])
        commented = true
      } catch (e) {
        if (!missingTool(e)) throw e
      }
    }
    saveIssue(dir, { ...rec, issueUrl: dup })
    return { ...base, issueUrl: dup, duplicateOf: dup, commented }
  }

  try {
    const url = await exec('gh', ['issue', 'create', '--repo', repo, '--title', title, '--body', text])
    saveIssue(dir, { ...rec, issueUrl: url })
    return { ...base, filed: true, issueUrl: url }
  } catch (e) {
    if (!missingTool(e)) throw e
    return {
      ...base,
      hint: `gh is not installed, so nothing was sent: open ${prefilled} in a browser to file it, or ${ghInstall()}, run \"gh auth login\" once, and rerun submit`,
    }
  }
}

/** Attach the fix locally, and comment it on the upstream issue when both exist. */
export async function solveIssue(
  dir: string,
  id: string,
  note: string,
  exec: (cmd: string, args: string[]) => Promise<string> = run,
): Promise<{ record: IssueRecord; commented: boolean }> {
  const rec = loadIssue(dir, id)
  const updated: IssueRecord = { ...rec, resolution: { at: new Date().toISOString(), note } }
  saveIssue(dir, updated)
  if (!updated.issueUrl) return { record: updated, commented: false }
  try {
    await exec('gh', ['issue', 'comment', updated.issueUrl, '--body', `Resolved: ${note}`])
  } catch (e) {
    if (!missingTool(e)) throw e
    return { record: updated, commented: false }
  }
  return { record: updated, commented: true }
}
