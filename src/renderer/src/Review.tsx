// A tela Revisão: lista de arquivos, diff lado a lado em largura total, e comentário numa linha
// que vai como mensagem para o agente. O terminal do agente fica à direita (é o App que o põe lá).

import { memo, useCallback, useRef, useState } from 'react'
import type { DiffFile, DiffHunk, DiffLine } from '../../shared/types'
import { Counts, FileList, useChanges, type RepoDiff } from './DiffPanel'

interface Props {
  repos: RepoDiff[]
  /** Nome da sessão em foco, ou null sem nenhuma aberta. */
  label: string | null
  /** Só um agente recebe comentários; num terminal comum o texto viraria um comando. */
  canComment: boolean
  edits: Record<string, number>
  now: number
  onRefresh(): void
  /** Manda um comentário ao agente da sessão em foco. */
  onSend(text: string): void
}

interface Row {
  l: DiffLine | null
  r: DiffLine | null
}

/** Põe um hunk em duas colunas: cada trecho removido fica ao lado do trecho que entrou no lugar. */
function toRows(h: DiffHunk): Row[] {
  const rows: Row[] = []
  let dels: DiffLine[] = []
  let adds: DiffLine[] = []
  const flush = (): void => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) rows.push({ l: dels[i] ?? null, r: adds[i] ?? null })
    dels = []
    adds = []
  }
  for (const line of h.lines) {
    if (line.t === '-') {
      if (adds.length > 0) flush()
      dels.push(line)
    } else if (line.t === '+') adds.push(line)
    else {
      flush()
      rows.push({ l: line, r: line })
    }
  }
  flush()
  return rows
}

const Half = ({ line, side }: { line: DiffLine | null; side: 'l' | 'r' }) => {
  if (!line) return <div className="half e" />
  const changed = line.t !== ' '
  return (
    <div className={changed ? (side === 'l' ? 'half d' : 'half a') : 'half'}>
      <i>{side === 'l' ? line.o : line.n}</i>
      <b>{changed ? (side === 'l' ? '−' : '+') : ' '}</b>
      <code>{line.s}</code>
    </div>
  )
}

const SideBySide = memo(function SideBySide(p: {
  file: DiffFile
  /** Linha (do arquivo novo) com a caixa de comentário aberta. */
  openAt: number | null
  sent: Record<number, string>
  canComment: boolean
  onOpen(line: number | null): void
  onSend(line: number, text: string): void
}) {
  const { file } = p
  if (file.binary) return <p className="diff-msg">Arquivo binário.</p>
  if (file.hunks.length === 0)
    return <p className="diff-msg">{file.truncated ? 'Arquivo grande demais para desenhar aqui.' : 'Sem linhas para mostrar.'}</p>
  return (
    <div className="sbs">
      {file.hunks.map((h, i) => (
        <div key={i}>
          <div className="hk">{h.header}</div>
          {toRows(h).map((row, j) => {
            const n = row.r?.n ?? null
            return (
              <div key={j}>
                <div
                  className={p.canComment && n !== null ? 'srow can' : 'srow'}
                  onClick={() => p.canComment && n !== null && !window.getSelection()?.toString() && p.onOpen(p.openAt === n ? null : n)}
                >
                  <Half line={row.l} side="l" />
                  <Half line={row.r} side="r" />
                </div>
                {n !== null && p.sent[n] && (
                  <div className="note">
                    <span className="dim">Você · linha {n} · enviado ao agente</span>
                    <span>{p.sent[n]}</span>
                  </div>
                )}
                {n !== null && p.openAt === n && (
                  <form
                    className="note"
                    onSubmit={e => {
                      e.preventDefault()
                      const text = new FormData(e.currentTarget).get('c')?.toString().trim()
                      if (text) p.onSend(n, text)
                    }}
                  >
                    <span className="dim">Comentário na linha {n}</span>
                    <input name="c" autoFocus autoComplete="off" placeholder="O que o agente deve mudar aqui?" onKeyDown={e => e.key === 'Escape' && p.onOpen(null)} />
                    <span className="note-f">
                      <button type="submit" className="btn pri">
                        Enviar ao agente
                      </button>
                      <span className="dim">
                        <kbd>Enter</kbd> envia · <kbd>Esc</kbd> cancela
                      </span>
                    </span>
                  </form>
                )}
              </div>
            )
          })}
        </div>
      ))}
      {file.truncated && <p className="diff-msg">O resto do arquivo foi cortado.</p>}
    </div>
  )
})

export function Review({ repos, label, canComment, edits, now, onRefresh, onSend }: Props) {
  const { read, all, current, added, removed, many, message, setPicked } = useChanges(repos, label)
  const [openAt, setOpenAt] = useState<number | null>(null)
  /** Comentários já enviados: "raiz|caminho" → linha → texto. */
  const [sent, setSent] = useState<Record<string, Record<number, string>>>({})
  const index = current ? all.findIndex(f => f.key === current.key) : -1

  const pick = (key: string): void => {
    setPicked(key)
    setOpenAt(null)
  }

  // O diff é redesenhado só quando o arquivo ou os comentários mudam, não a cada segundo do
  // relógio: por isso quem ele chama tem de ter sempre a mesma identidade.
  const send = useRef<(line: number, text: string) => void>(() => {})
  send.current = (line, text) => {
    if (!current) return
    onSend(`[${current.file.path}:${line}] ${text}`)
    setSent(all => ({ ...all, [current.key]: { ...all[current.key], [line]: text } }))
    setOpenAt(null)
  }
  const handleSend = useCallback((line: number, text: string) => send.current(line, text), [])

  return (
    <div className="review">
      <aside className="review-l">
        <div className="d-h">
          <b>{label ?? 'Revisão'}</b>
          <span className="r mono">
            {read.length > 0 && <Counts added={added} removed={removed} />}
            <button className="icon" title="Atualizar" onClick={onRefresh} disabled={!label}>
              ↻
            </button>
          </span>
        </div>
        {!message && <FileList read={read} many={many} currentKey={current?.key} edits={edits} now={now} onPick={pick} />}
      </aside>
      <section className="review-c">
        {message || !current ? (
          <p className="diff-empty">{message}</p>
        ) : (
          <>
            <div className="d-h">
              <b className="mono">{current.file.path}</b>
              <span className="dim">
                {index + 1} de {all.length}
              </span>
              <span className="r">
                <span className="dim">
                  {canComment ? 'Clique numa linha para comentar; o comentário vira mensagem para o agente.' : 'Abra a revisão a partir de um agente para poder comentar.'}
                </span>
                <button className="btn" disabled={index <= 0} onClick={() => pick(all[index - 1].key)}>
                  Anterior
                </button>
                <button className="btn" disabled={index >= all.length - 1} onClick={() => pick(all[index + 1].key)}>
                  Próximo
                </button>
              </span>
            </div>
            <div className="code">
              <SideBySide
                file={current.file}
                openAt={openAt}
                sent={sent[current.key] ?? EMPTY}
                canComment={canComment}
                onOpen={setOpenAt}
                onSend={handleSend}
              />
            </div>
          </>
        )}
      </section>
    </div>
  )
}

const EMPTY: Record<number, string> = {}
