// A tela Quadro: o que cada agente e cada subagente está fazendo, lado a lado, com a linha do
// tempo de cada um. É a tela para acompanhar sem ler terminal.

import type { Step, SubAgent } from './agent'
import { clock, durationShort, elapsed, runningSubs, statusLabel, statusLine, subStatus, type Sess, type Status } from './session'

interface Props {
  sessions: Sess[]
  status: Map<string, Status>
  now: number
  totals(roots: string[]): { added: number; removed: number } | null
  /** Vai para a Grade com o terminal desta sessão em foco. */
  onOpen(id: string): void
  /** Vai para a Revisão desta sessão. */
  onReview(id: string): void
}

/** Quem precisa de você vem primeiro; quem já encerrou, por último. */
const ORDER: Status[] = ['wait', 'run', 'done', 'idle', 'exit']

/** Quantos passos cada faixa mostra. */
const LANE_STEPS = 7

function Steps({ steps }: { steps: Step[] }) {
  if (steps.length === 0) return <p className="lane-empty">Nenhum passo ainda.</p>
  return (
    <ol className="steps">
      {steps.map((s, i) => (
        <li key={`${s.at}-${i}`} className={`k-${s.kind}`}>
          <time>{clock(s.at)}</time>
          <span>{s.text}</span>
        </li>
      ))}
    </ol>
  )
}

function SubLane({ a, steps, now }: { a: SubAgent; steps: Step[]; now: number }) {
  const st = subStatus(a)
  return (
    <section className={`lane is-${st}`}>
      <header className="lane-h">
        <i className="dot" />
        <b title={a.name}>{a.name}</b>
        <span className="t">{st === 'wait' ? 'esperando você' : st === 'done' ? 'terminou' : 'trabalhando'}</span>
      </header>
      <p className="lane-m">
        <span className="chip">{a.type}</span>
        <span>{durationShort((a.endedAt ?? now) - a.startedAt)}</span>
        <span>{a.tools === 1 ? '1 ferramenta' : `${a.tools} ferramentas`}</span>
      </p>
      {a.done && a.result && <p className="lane-r">{a.result}</p>}
      <Steps steps={steps.filter(s => s.kind !== 'sub').slice(-LANE_STEPS)} />
    </section>
  )
}

function Card(p: { s: Sess; st: Status } & Omit<Props, 'sessions' | 'status'>) {
  const { s, st, now } = p
  const a = s.agent
  const d = p.totals(s.roots)
  const time = elapsed(s.id, st, now)
  return (
    <article className={`card is-${st}`}>
      <header className="card-h">
        <i className="dot" />
        <b>{s.name}</b>
        <span className="mono dim">{s.branch ? s.branch : s.cwd}</span>
        <span className="pill">
          {statusLabel(s, st)}
          {time && ` · ${time}`}
        </span>
        <span className="card-a">
          {d && (
            <button className="btn" onClick={() => p.onReview(s.id)}>
              Revisar <span className="add">+{d.added}</span> <span className="del">−{d.removed}</span>
            </button>
          )}
          <button className="btn" onClick={() => p.onOpen(s.id)}>
            Abrir terminal
          </button>
        </span>
      </header>

      {!a ? (
        <p className="card-note">
          {s.kind === 'shell'
            ? `Terminal comum: ${statusLine(s, st).toLowerCase()}.`
            : 'Ainda sem eventos deste agente. Eles começam a chegar no primeiro pedido que você fizer a ele.'}
        </p>
      ) : (
        <>
          {a.prompt && (
            <p className="card-p">
              <span className="lbl">Pedido</span>
              {a.prompt}
            </p>
          )}
          {st === 'wait' && <p className="card-ask">{a.askDetail || 'Pediu sua atenção'}</p>}
          <div className="lanes">
            <section className={`lane is-${a.asks.main ? 'wait' : a.main === 'working' ? 'run' : a.main === 'done' ? 'done' : 'idle'}`}>
              <header className="lane-h">
                <i className="dot" />
                <b>Agente principal</b>
                <span className="t">
                  {a.asks.main ? 'esperando você' : a.main === 'working' ? 'trabalhando' : a.main === 'done' ? 'terminou o turno' : 'parado'}
                </span>
              </header>
              <p className="lane-m">
                <span>{a.tools === 1 ? '1 ferramenta neste turno' : `${a.tools} ferramentas neste turno`}</span>
                {runningSubs(s).length > 0 && a.main !== 'working' && <span>esperando subagentes</span>}
              </p>
              <Steps steps={a.steps.filter(x => x.agent === null).slice(-LANE_STEPS)} />
            </section>
            {a.subagents.map(sub => (
              <SubLane key={sub.id} a={sub} steps={a.steps.filter(x => x.agent === sub.id)} now={now} />
            ))}
          </div>
        </>
      )}
    </article>
  )
}

export function Board(p: Props) {
  const sorted = [...p.sessions].sort((x, y) => ORDER.indexOf(p.status.get(x.id)!) - ORDER.indexOf(p.status.get(y.id)!))

  // a atividade de todo mundo numa lista só, a mais nova em cima
  const feed = p.sessions
    .flatMap(s => (s.agent?.steps ?? []).map(step => ({ step, s, sub: step.agent ? s.agent!.subagents.find(a => a.id === step.agent) : null })))
    .sort((x, y) => y.step.at - x.step.at)
    .slice(0, 80)

  return (
    <div className="board">
      <div className="board-main">
        {sorted.length === 0 && <p className="board-empty">Nenhum agente aberto. Abra um pela lateral e o que ele fizer aparece aqui.</p>}
        {sorted.map(s => (
          <Card key={s.id} s={s} st={p.status.get(s.id)!} now={p.now} totals={p.totals} onOpen={p.onOpen} onReview={p.onReview} />
        ))}
      </div>
      <aside className="feed">
        <div className="feed-h">
          <b>Atividade</b>
          <span className="dim">ao vivo</span>
        </div>
        <div className="feed-b">
          {feed.length === 0 && <p className="lane-empty">Os passos dos agentes aparecem aqui conforme acontecem.</p>}
          {feed.map(({ step, s, sub }, i) => (
            <div key={`${s.id}-${step.at}-${i}`} className={`ev k-${step.kind}`}>
              <time>{clock(step.at)}</time>
              <div>
                <b>
                  {s.name}
                  {sub && <span className="dim"> › {sub.name}</span>}
                </b>
                <span>{step.text}</span>
              </div>
            </div>
          ))}
        </div>
      </aside>
    </div>
  )
}
