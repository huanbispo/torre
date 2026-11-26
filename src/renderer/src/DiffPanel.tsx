import { memo, useState } from 'react'
import type { DiffFile, DiffResult } from '../../shared/types'

/** Um repositório que a sessão em foco acompanha, com o diff dele (undefined enquanto não foi lido). */
export interface RepoDiff {
  root: string
  diff: DiffResult | undefined
}

interface Props {
  /** Os repositórios da sessão em foco: o da pasta onde ela abriu e os que o agente editou. */
  repos: RepoDiff[]
  /** Nome da sessão em foco, ou null sem nenhuma aberta. */
  label: string | null
  /** Arquivos que um agente acabou de editar: caminho absoluto, com / e em minúsculas → quando. */
  edits: Record<string, number>
  now: number
  onRefresh(): void
  onMinimize(): void
}

/** Por quanto tempo depois de uma edição o arquivo leva o selo. */
const FRESH_MS = 120_000

const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase()

function editedAgo(at: number | undefined, now: number): string | null {
  if (!at || now - at > FRESH_MS) return null
  const s = Math.floor((now - at) / 1000)
  return s < 5 ? 'editado agora' : s < 60 ? `editado há ${s} s` : `editado há ${Math.floor(s / 60)} min`
}

export function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <>
      <span className="add">+{added}</span>
      <span className="del">−{removed}</span>
    </>
  )
}

// memo: o painel é redesenhado a cada segundo (o relógio dos selos), e um diff pode ter milhares de linhas
const FileBody = memo(function FileBody({ file }: { file: DiffFile }) {
  if (file.binary) return <p className="diff-msg">Arquivo binário.</p>
  if (file.hunks.length === 0)
    return <p className="diff-msg">{file.truncated ? 'Arquivo grande demais para desenhar aqui.' : 'Sem linhas para mostrar.'}</p>
  return (
    <div className="code-inner">
      {file.hunks.map((h, i) => (
        <div key={i}>
          <div className="hk">{h.header}</div>
          {h.lines.map((l, j) => (
            <div key={j} className={l.t === '+' ? 'dl a' : l.t === '-' ? 'dl d' : 'dl'}>
              <i>{l.o ?? ''}</i>
              <i>{l.n ?? ''}</i>
              <b>{l.t === '-' ? '−' : l.t}</b>
              <code>{l.s}</code>
            </div>
          ))}
        </div>
      ))}
      {file.truncated && <p className="diff-msg">O resto do arquivo foi cortado.</p>}
    </div>
  )
})

/** O que as duas telas de mudanças (o painel da Grade e a Revisão) tiram da mesma lista de repositórios. */
export function useChanges(repos: RepoDiff[], label: string | null) {
  /** O arquivo escolhido: "raiz|caminho". */
  const [picked, setPicked] = useState<string | null>(null)

  const read = repos.filter(r => r.diff && !r.diff.error)
  const all = read.flatMap(r => r.diff!.files.map(file => ({ key: `${r.root}|${file.path}`, root: r.root, file })))
  const current = all.find(f => f.key === picked) ?? all[0]
  const added = read.reduce((a, r) => a + r.diff!.added, 0)
  const removed = read.reduce((a, r) => a + r.diff!.removed, 0)
  const many = repos.length > 1

  let message: string | null = null
  if (!label) message = 'Abra um agente ou um terminal para ver aqui o que muda no código.'
  else if (repos.length === 0)
    message =
      'Esta pasta não é um repositório git. Quando o agente editar um arquivo de algum repositório, as mudanças dele aparecem aqui.'
  else if (repos.every(r => !r.diff)) message = 'Lendo o repositório…'
  else if (read.length === 0) message = 'O git não conseguiu calcular as mudanças desta pasta.'
  else if (all.length === 0) message = many ? `Nada mudou nos ${repos.length} repositórios desde o último commit.` : 'Nada mudou desde o último commit.'

  return { read, all, current, added, removed, many, message, setPicked }
}

/** A lista de arquivos mudados, agrupada por repositório quando há mais de um. */
export function FileList(p: {
  read: RepoDiff[]
  many: boolean
  currentKey: string | undefined
  edits: Record<string, number>
  now: number
  onPick(key: string): void
}) {
  return (
    <div className="files">
      {p.read.map(r => (
        <div key={r.root} className="repo">
          {/* com um repositório só, o cabeçalho da tela já diz tudo */}
          {p.many && (
            <div className="repo-h" title={r.root}>
              <b>{baseName(r.root)}</b>
              {r.diff!.branch && <span className="mono dim">{r.diff!.branch}</span>}
              <span className="r mono">
                {r.diff!.files.length === 0 ? <span className="dim">sem mudanças</span> : <Counts added={r.diff!.added} removed={r.diff!.removed} />}
              </span>
            </div>
          )}
          {r.diff!.files.map(f => {
            const key = `${r.root}|${f.path}`
            const ago = editedAgo(p.edits[norm(`${r.root}/${f.path}`)], p.now)
            return (
              <button key={key} className={p.currentKey === key ? 'f on' : 'f'} onClick={() => p.onPick(key)} title={f.path}>
                <span className="l">{f.status}</span>
                {/* a marca de esquerda-para-direita segura o ponto de ".gitignore" no lugar: o corte pelo começo usa direction: rtl */}
                <span className="n">{'‎' + f.path}</span>
                {ago && <span className="live">{ago}</span>}
                <Counts added={f.added} removed={f.removed} />
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

export function DiffPanel({ repos, label, edits, now, onRefresh, onMinimize }: Props) {
  const { read, current, added, removed, many, message, setPicked } = useChanges(repos, label)

  return (
    <aside className="diff">
      <div className="d-h">
        <b>Mudanças</b>
        {label && <span className="chip">{label}</span>}
        {many ? <span className="dim">{repos.length} repositórios</span> : read[0]?.diff?.base && <span className="dim">contra {read[0].diff.base}</span>}
        <span className="r mono">
          {read.length > 0 && <Counts added={added} removed={removed} />}
          <button className="icon" title="Atualizar" onClick={onRefresh} disabled={!label}>
            ↻
          </button>
          <button className="icon" title="Minimizar (Ctrl+Shift+D)" onClick={onMinimize}>
            »
          </button>
        </span>
      </div>
      {message ? (
        <p className="diff-empty">{message}</p>
      ) : (
        <>
          <FileList read={read} many={many} currentKey={current?.key} edits={edits} now={now} onPick={setPicked} />
          <div className="code">{current && <FileBody file={current.file} />}</div>
        </>
      )}
    </aside>
  )
}
