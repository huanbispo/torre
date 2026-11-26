import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DiffFile, DiffHunk, DiffResult, GitInfo } from '../shared/types'

const MAX_LINES_PER_FILE = 3000
const MAX_UNTRACKED_FILES = 60
const MAX_UNTRACKED_BYTES = 256 * 1024

// GIT_OPTIONAL_LOCKS=0: o app só lê. Sem isso um comando de leitura pode pegar o index.lock por um
// instante e derrubar o `git add` ou o commit que o agente estiver fazendo na mesma hora.
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }

function git(cwd: string, args: string[], stdin?: string): Promise<{ ok: boolean; out: string }> {
  return new Promise(resolve => {
    const child = execFile(
      'git',
      ['-c', 'core.quotepath=false', ...args],
      { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: GIT_ENV },
      (err, stdout) => resolve({ ok: !err, out: stdout ?? '' })
    )
    if (stdin !== undefined) child.stdin?.end(stdin)
  })
}

/** Dos caminhos dados (relativos à raiz), quais o .gitignore não cobre. */
async function notIgnored(root: string, paths: string[]): Promise<string[]> {
  // check-ignore devolve os ignorados; sai com 1 quando nenhum é, e isso não é erro
  const r = await git(root, ['check-ignore', '-z', '--stdin'], paths.join('\0') + '\0')
  const ignored = new Set(r.out.split('\0').filter(Boolean))
  return paths.filter(p => !ignored.has(p))
}

async function branchOf(cwd: string): Promise<string | null> {
  // symbolic-ref responde também num repositório ainda sem commits
  const sym = await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])
  if (sym.ok && sym.out.trim()) return sym.out.trim()
  const sha = await git(cwd, ['rev-parse', '--short', 'HEAD'])
  return sha.ok ? sha.out.trim() : null
}

export async function gitInfo(cwd: string): Promise<GitInfo> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return { root: null, branch: null }
  return { root: top.out.trim().replace(/\//g, '\\'), branch: await branchOf(cwd) }
}

export function parsePatch(patch: string): DiffFile[] {
  const files: DiffFile[] = []
  let f: DiffFile | null = null
  let h: DiffHunk | null = null
  let o = 0
  let n = 0
  let drawn = 0
  for (const raw of patch.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.startsWith('diff --git ')) {
      const m = / b\/(.+)$/.exec(line)
      f = { path: m ? m[1] : line.slice(11), status: 'M', added: 0, removed: 0, binary: false, truncated: false, hunks: [] }
      files.push(f)
      h = null
      drawn = 0
      continue
    }
    if (!f) continue
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (m) {
        o = Number(m[1])
        n = Number(m[2])
        h = { header: line, lines: [] }
        f.hunks.push(h)
      }
      continue
    }
    if (!h) {
      if (line.startsWith('new file mode')) f.status = 'A'
      else if (line.startsWith('deleted file mode')) f.status = 'D'
      else if (line.startsWith('rename to ')) {
        f.status = 'R'
        f.path = line.slice(10)
      } else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) f.binary = true
      else if (line.startsWith('+++ b/')) f.path = line.slice(6).replace(/\t$/, '')
      continue
    }
    const c = line[0]
    if (c !== '+' && c !== '-' && c !== ' ') continue
    if (c === '+') f.added++
    if (c === '-') f.removed++
    const row = { t: c, o: c === '+' ? null : o, n: c === '-' ? null : n, s: line.slice(1) } as const
    if (c !== '+') o++
    if (c !== '-') n++
    if (drawn < MAX_LINES_PER_FILE) {
      h.lines.push(row)
      drawn++
    } else f.truncated = true
  }
  return files
}

/** Um arquivo que o git ainda não acompanha, desenhado como todo adicionado. `seen` recebe o
 *  tamanho e a data dele, que entram no carimbo do diff. */
async function untrackedFile(root: string, path: string, seen: string[]): Promise<DiffFile> {
  const f: DiffFile = { path, status: 'A', added: 0, removed: 0, binary: false, truncated: false, hunks: [] }
  try {
    const full = join(root, path)
    const info = await stat(full)
    seen.push(`${path}:${info.size}:${info.mtimeMs}`)
    if (info.size > MAX_UNTRACKED_BYTES) {
      f.truncated = true
      return f
    }
    const buf = await readFile(full)
    if (buf.includes(0)) {
      f.binary = true
      return f
    }
    const lines = buf.toString('utf8').split('\n')
    if (lines.at(-1) === '') lines.pop()
    f.added = lines.length
    f.truncated = lines.length > MAX_LINES_PER_FILE
    f.hunks.push({
      header: `@@ -0,0 +1,${lines.length} @@`,
      lines: lines.slice(0, MAX_LINES_PER_FILE).map((s, i) => ({ t: '+' as const, o: null, n: i + 1, s: s.replace(/\r$/, '') }))
    })
  } catch {
    // o arquivo sumiu entre a listagem e a leitura: fica na lista, sem conteúdo
  }
  return f
}

export async function gitDiff(cwd: string): Promise<DiffResult> {
  const empty = (error: string | null, root: string | null = null): DiffResult => ({ root, branch: null, stamp: `erro:${error}`, base: '', files: [], added: 0, removed: 0, error })
  const top = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return empty('not-a-repo')
  const root = top.out.trim().replace(/\//g, '\\')
  const hasHead = (await git(root, ['rev-parse', '--verify', '-q', 'HEAD'])).ok
  const base = ['diff', '--no-color', '--no-ext-diff', '-M', '-U3']
  const patch = await git(root, hasHead ? [...base, 'HEAD'] : [...base, '--cached'])
  if (!patch.ok) return empty('diff-failed', root)
  const files = parsePatch(patch.out)
  const others = await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  const seen: string[] = []
  if (others.ok) {
    const paths = others.out.split('\0').filter(Boolean)
    const tracked = new Set(files.map(f => f.path))
    for (const p of paths.slice(0, MAX_UNTRACKED_FILES)) {
      if (!tracked.has(p)) files.push(await untrackedFile(root, p, seen))
    }
  }
  const branch = await branchOf(root)
  return {
    root,
    branch,
    // muda quando qualquer coisa do resultado muda; a interface compara só isto para saber se redesenha
    stamp: createHash('sha1').update(patch.out).update(others.out).update(seen.join('|')).update(`${branch}|${hasHead}`).digest('hex'),
    base: hasHead ? 'HEAD' : 'repositório sem commits',
    files,
    added: files.reduce((a, f) => a + f.added, 0),
    removed: files.reduce((a, f) => a + f.removed, 0),
    error: null
  }
}

/** Mais repositórios que isto numa sessão só e o vigia deixa os últimos de fora. */
const MAX_WATCHED = 8

/** Quanto o vigia junta de eventos antes de avisar. Conta a partir do primeiro evento e não é
 *  renovado pelos seguintes: num projeto que grava em disco sem parar (um editor de jogo aberto, um
 *  build) esperar o silêncio seria esperar para sempre. */
const BATCH_MS = 400
/** Acima disto num só lote nem vale perguntar ao git: alguma coisa relevante mudou. */
const MAX_BATCH = 400

/** Vigia os repositórios da sessão em foco e avisa, um por um, quando muda algo que o git enxerga. */
export class RepoWatcher {
  private watchers = new Map<string, FSWatcher>()
  private timers = new Map<string, NodeJS.Timeout>()
  private batches = new Map<string, Set<string>>()

  constructor(private onChange: (root: string) => void) {}

  /** Passa a vigiar exatamente estas pastas: abre as novas e solta as que saíram da lista. */
  watch(roots: string[]): void {
    const want = new Set(roots.slice(0, MAX_WATCHED))
    this.wanted = want
    for (const root of [...this.watchers.keys()]) if (!want.has(root)) this.drop(root)
    for (const root of want) if (!this.watchers.has(root)) this.add(root)
  }

  private add(root: string): void {
    try {
      const w = watch(root, { recursive: true }, (_ev, file) => {
        if (!file) return
        const p = file.replace(/\\/g, '/')
        if (/(^|\/)node_modules\//.test(p)) return
        // dentro de .git só interessa o que muda com commit, checkout e add
        if (p.startsWith('.git/') && !/^\.git\/(HEAD|index|refs\/)/.test(p)) return
        if (p.endsWith('.lock')) return
        let batch = this.batches.get(root)
        if (!batch) this.batches.set(root, (batch = new Set()))
        if (batch.size <= MAX_BATCH) batch.add(p)
        if (!this.timers.has(root)) this.timers.set(root, setTimeout(() => void this.flush(root), BATCH_MS))
      })
      w.on('error', () => {
        // Sob muita gravação o Windows estoura o buffer de eventos e o vigia morre. Avisa (algo
        // mudou, não se sabe o quê) e abre outro, em vez de deixar o painel parado.
        this.drop(root)
        this.onChange(root)
        setTimeout(() => this.wanted.has(root) && !this.watchers.has(root) && this.add(root), 2000)
      })
      this.watchers.set(root, w)
    } catch {
      // a pasta sumiu ou não deixa vigiar: o painel ainda relê sozinho de tempos em tempos
    }
  }

  /** Fecha o lote: avisa se nele há algo que o git acompanha (ou acompanharia). */
  private async flush(root: string): Promise<void> {
    this.timers.delete(root)
    const batch = [...(this.batches.get(root) ?? [])]
    this.batches.delete(root)
    if (batch.length === 0) return
    const internal = batch.some(p => p.startsWith('.git/'))
    const files = batch.filter(p => !p.startsWith('.git/'))
    // o que o .gitignore cobre (Saved/, Intermediate/, dist/…) não muda o diff: não vale reler
    const relevant = internal || batch.length > MAX_BATCH || (files.length > 0 && (await notIgnored(root, files)).length > 0)
    if (relevant && this.watchers.has(root)) this.onChange(root)
  }

  private wanted = new Set<string>()

  private drop(root: string): void {
    const pending = this.timers.get(root)
    if (pending) clearTimeout(pending)
    this.timers.delete(root)
    this.batches.delete(root)
    this.watchers.get(root)?.close()
    this.watchers.delete(root)
  }

  close(): void {
    this.wanted = new Set()
    for (const root of [...this.watchers.keys()]) this.drop(root)
  }
}
