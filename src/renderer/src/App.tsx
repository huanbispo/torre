import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { DiffResult, GridLayout, SessionKind } from '../../shared/types'
import { answered, initialAgent, reduce, type AgentState } from './agent'
import { Board } from './Board'
import { bus } from './bus'
import { DiffPanel } from './DiffPanel'
import { Review } from './Review'
import { baseName, durationShort, elapsed, forget, runningSubs, statusLabel, statusLine, statusOf, subStatus, type Sess, type Status } from './session'
import { TerminalView } from './TerminalView'

const api = window.torre

/** Quantos subagentes de cada sessão a lateral lista; o resto fica no Quadro. */
const SIDE_SUBS = 6

// --- tamanhos da grade ----------------------------------------------------------------------
const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0)

/** Quantos painéis em cada fileira, para n sessões: até 4 são 2 por fileira, depois 3. */
function rowCounts(n: number): number[] {
  const perRow = n <= 1 ? 1 : n <= 4 ? 2 : 3
  const counts: number[] = []
  for (let i = 0; i < n; i += perRow) counts.push(Math.min(perRow, n - i))
  return counts
}

const equalLayout = (counts: number[]): GridLayout => ({
  rowH: counts.map(() => 1),
  colW: counts.map(c => Array<number>(c).fill(1))
})

/** Um arranjo guardado só vale se tiver o formato da grade de agora e números usáveis. */
function fits(l: GridLayout | undefined, counts: number[]): l is GridLayout {
  const ok = (a: unknown, len: number): boolean =>
    Array.isArray(a) && a.length === len && a.every(v => typeof v === 'number' && v > 0)
  return !!l && ok(l.rowH, counts.length) && Array.isArray(l.colW) && l.colW.length === counts.length && counts.every((c, i) => ok(l.colW[i], c))
}

/** Nenhum painel encolhe abaixo desta fatia da fileira (ou da coluna de fileiras). */
const MIN_SHARE = 0.12

/** Passa `delta` do vizinho i+1 para o i, sem deixar nenhum dos dois menor que o mínimo. */
function shift(vals: number[], i: number, delta: number): number[] {
  const min = sum(vals) * MIN_SHARE
  const pair = vals[i] + vals[i + 1]
  if (pair <= 2 * min) return vals
  const out = [...vals]
  out[i] = Math.min(Math.max(vals[i] + delta, min), pair - min)
  out[i + 1] = pair - out[i]
  return out
}

/** Uma divisa arrastável. `onStart` devolve quem recebe o deslocamento desde o início do arrasto. */
function Gutter(p: { className: string; style?: CSSProperties; onStart(): (dx: number, dy: number) => void; onReset(): void }) {
  const drag = useRef<{ x: number; y: number; move(dx: number, dy: number): void } | null>(null)
  return (
    <div
      className={p.className}
      style={p.style}
      title="Arraste para redimensionar; dois cliques igualam"
      onMouseDown={e => e.preventDefault() /* o terminal em foco não perde o teclado */}
      onPointerDown={e => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { x: e.clientX, y: e.clientY, move: p.onStart() }
      }}
      onPointerMove={e => drag.current?.move(e.clientX - drag.current.x, e.clientY - drag.current.y)}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={p.onReset}
    />
  )
}

function Launcher(p: { kind: SessionKind; onOpen(kind: SessionKind, cwd: string): void; onClose(): void }) {
  const [kind, setKind] = useState(p.kind)
  const [recent, setRecent] = useState<string[]>([])
  useEffect(() => {
    void api.getRecent().then(setRecent)
  }, [])
  const pick = async (): Promise<void> => {
    const cwd = await api.pickFolder()
    if (cwd) p.onOpen(kind, cwd)
  }
  return (
    <div className="veil" onMouseDown={e => e.target === e.currentTarget && p.onClose()}>
      <div className="launcher" role="dialog" aria-label="Abrir sessão">
        <div className="launcher-h">
          <b>Abrir em qual pasta?</b>
          <div className="seg">
            <button className={kind === 'agent' ? 'on' : ''} onClick={() => setKind('agent')}>
              Agente (claude)
            </button>
            <button className={kind === 'shell' ? 'on' : ''} onClick={() => setKind('shell')}>
              Terminal
            </button>
          </div>
        </div>
        <div className="launcher-list">
          {recent.length === 0 && <p className="dim">Nenhuma pasta recente ainda.</p>}
          {recent.map((cwd, i) => (
            <button key={cwd} className="launcher-row" autoFocus={i === 0} onClick={() => p.onOpen(kind, cwd)}>
              <b>{baseName(cwd)}</b>
              <span className="mono dim">{cwd}</span>
            </button>
          ))}
        </div>
        <div className="launcher-f">
          <button className="btn" autoFocus={recent.length === 0} onClick={() => void pick()}>
            Escolher outra pasta…
          </button>
          <span className="dim">
            <kbd>Esc</kbd> fecha
          </span>
        </div>
      </div>
    </div>
  )
}

export function App() {
  const [sessions, setSessions] = useState<Sess[]>([])
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [diffOpen, setDiffOpen] = useState(true)
  const [launcher, setLauncher] = useState<SessionKind | null>(null)
  const [diffs, setDiffs] = useState<Record<string, DiffResult>>({})
  const [now, setNow] = useState(Date.now())
  const [diffW, setDiffW] = useState<number | null>(null)
  const [layouts, setLayouts] = useState<Record<string, GridLayout>>({})
  /** O painel em foco ocupa a grade toda; os outros continuam rodando, escondidos. */
  const [zoomed, setZoomed] = useState(false)
  /** A tela: os terminais em grade, o quadro dos agentes ou a revisão das mudanças. */
  const [view, setView] = useState<'grid' | 'board' | 'review'>('grid')
  // autoteste: TORRE_VIEW abre noutra tela, na hora ou depois de TORRE_VIEW_DELAY ms
  useEffect(() => {
    const target = api.startView
    if (!target) return
    const t = setTimeout(() => setView(target), api.startViewDelay)
    return () => clearTimeout(t)
  }, [])
  /** Largura do terminal na Revisão, em px; null enquanto ninguém arrastou. */
  const [reviewW, setReviewW] = useState<number | null>(null)
  const gridRef = useRef<HTMLElement>(null)
  const diffRef = useRef<HTMLDivElement>(null)

  // ajustes da tela: lidos uma vez na abertura, gravados pouco depois de cada mudança
  const uiLoaded = useRef(false)
  useEffect(() => {
    void api.getUi().then(ui => {
      if (ui) {
        if (typeof ui.diffOpen === 'boolean') setDiffOpen(ui.diffOpen)
        if (typeof ui.diffW === 'number') setDiffW(ui.diffW)
        if (typeof ui.reviewW === 'number') setReviewW(ui.reviewW)
        if (ui.layouts && typeof ui.layouts === 'object') setLayouts(ui.layouts)
      }
      uiLoaded.current = true
    })
  }, [])
  useEffect(() => {
    if (!uiLoaded.current) return
    const t = setTimeout(() => api.setUi({ diffOpen, diffW, reviewW, layouts }), 400)
    return () => clearTimeout(t)
  }, [diffOpen, diffW, reviewW, layouts])

  // os atalhos e os avisos dos terminais leem o estado mais novo sem serem refeitos
  const live = useRef({ sessions, focusedId, launcher })
  live.current = { sessions, focusedId, launcher }

  const patch = useCallback((id: string, change: Partial<Sess>) => {
    setSessions(list => list.map(s => (s.id === id ? { ...s, ...change } : s)))
  }, [])

  // Relê as mudanças de um repositório. Um pedido que chega com outro em andamento não abre um
  // segundo git: marca que é preciso reler de novo quando o primeiro voltar.
  const diffJobs = useRef(new Map<string, 'busy' | 'again'>())
  const refreshDiff = useCallback((root: string) => {
    const jobs = diffJobs.current
    if (jobs.has(root)) {
      jobs.set(root, 'again')
      return
    }
    jobs.set(root, 'busy')
    const run = (): void => {
      void api
        .gitDiff(root)
        // leitura igual à anterior não troca o objeto, e nada é redesenhado
        .then(d => setDiffs(all => (all[root]?.stamp === d.stamp ? all : { ...all, [root]: d })))
        .finally(() => {
          if (jobs.get(root) === 'again') {
            jobs.set(root, 'busy')
            run()
          } else jobs.delete(root)
        })
    }
    run()
  }, [])

  const openSession = useCallback(
    (kind: SessionKind, cwd: string) => {
      const id = crypto.randomUUID().slice(0, 8)
      setSessions(list => [
        ...list,
        { id, kind, cwd, name: baseName(cwd), root: cwd, roots: [], branch: null, title: '', attention: null, exitCode: null, error: null, agent: null }
      ])
      setFocusedId(id)
      setLauncher(null)
      void api.addRecent(cwd)
      void api.gitInfo(cwd).then(info => {
        const found = info.root
        if (!found) return // pasta fora de repositório: o painel espera o agente editar algum
        setSessions(list => list.map(s => (s.id === id ? { ...s, root: found, branch: info.branch, roots: [found, ...s.roots.filter(r => r !== found)] } : s)))
        refreshDiff(found)
      })
    },
    [patch, refreshDiff]
  )

  const closeSession = useCallback((id: string) => {
    const list = live.current.sessions
    const i = list.findIndex(s => s.id === id)
    if (i < 0) return
    const rest = list.filter(s => s.id !== id)
    setSessions(rest)
    forget(id)
    agentsRef.current.delete(id)
    if (live.current.focusedId === id) setFocusedId(rest[Math.min(i, rest.length - 1)]?.id ?? null)
  }, [])

  const onFocus = useCallback(
    (id: string) => {
      setFocusedId(id)
      patch(id, { attention: null })
    },
    [patch]
  )
  // O estado de cada agente pelos hooks. Fica também fora do React porque dois eventos podem
  // chegar antes de um redesenho, e o segundo tem de partir do resultado do primeiro.
  const agentsRef = useRef(new Map<string, AgentState>())

  const onInput = useCallback(
    (id: string, data: string) => {
      if (live.current.sessions.find(s => s.id === id)?.attention) patch(id, { attention: null })
      // Enter, um número ou Esc respondem a um pedido de permissão: o agente volta a trabalhar
      // (ou para) sem que nenhum hook avise, então o "esperando você" sai por aqui.
      const a = agentsRef.current.get(id)
      if (a?.phase === 'waiting' && (data.includes('\r') || /^[1-9]$/.test(data) || data === '\x1b')) {
        const next: AgentState = answered(a, Date.now())
        agentsRef.current.set(id, next)
        patch(id, { agent: next })
      }
    },
    [patch]
  )
  const onTitle = useCallback(
    (id: string, title: string) => {
      // o PowerShell põe o caminho do próprio executável no título; isso não diz nada
      patch(id, { title: /\.exe$/i.test(title.trim()) ? '' : title.trim() })
    },
    [patch]
  )
  const onAttention = useCallback(
    (id: string, text: string) => {
      // quem já está olhando para o painel não precisa de aviso
      if (live.current.focusedId === id && document.hasFocus()) return
      // com hooks o estado vem deles; o sino do terminal só repetiria o aviso
      if (agentsRef.current.has(id)) return
      patch(id, { attention: text })
    },
    [patch]
  )
  const onError = useCallback((id: string, message: string) => patch(id, { error: message }), [patch])

  // sessões pedidas na abertura (TORRE_OPEN)
  useEffect(() => {
    for (const s of api.startup) openSession(s.kind, s.cwd)
  }, [openSession])

  useEffect(() => api.onExit((id, code) => patch(id, { exitCode: code })), [patch])

  // eventos dos hooks do Claude Code: cada um avança o estado do agente daquele painel
  useEffect(
    () =>
      api.onAgentEvent((pane, ev) => {
        const s = live.current.sessions.find(x => x.id === pane)
        if (!s) return
        const before = agentsRef.current.get(pane) ?? initialAgent
        const after = reduce(before, ev, Date.now())
        agentsRef.current.set(pane, after)
        patch(pane, { agent: after, attention: null })
        // O agente acabou de gravar um arquivo. O repositório desse arquivo entra na lista da
        // sessão, esteja onde estiver, e o painel de mudanças relê na hora, sem esperar o vigia.
        const edited = String(ev.tool_input?.file_path ?? ev.tool_input?.notebook_path ?? '')
        if (after.edits !== before.edits && edited) {
          const dir = edited.replace(/[\\/][^\\/]*$/, '')
          void api.gitInfo(dir).then(info => {
            const found = info.root
            if (!found) return
            setSessions(list => list.map(x => (x.id === pane && !x.roots.includes(found) ? { ...x, roots: [...x.roots, found] } : x)))
            refreshDiff(found)
          })
        }
        const turned = after.phase !== before.phase && (after.phase === 'waiting' || after.phase === 'done')
        if (turned && !document.hasFocus()) {
          api.notify({ id: pane, title: `${s.name}: ${after.phase === 'waiting' ? 'esperando você' : 'terminou'}`, body: after.detail })
        }
      }),
    [patch, refreshDiff]
  )
  useEffect(() => api.onFocusSession(id => onFocus(id)), [onFocus])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const focused = sessions.find(s => s.id === focusedId) ?? null
  const focusedRoots = focused?.roots ?? []
  const rootsKey = focusedRoots.join('|')

  // o painel de mudanças segue a sessão em foco: vigia os repositórios dela e relê quando algo muda
  useEffect(() => {
    const roots = rootsKey ? rootsKey.split('|') : []
    api.gitWatch(roots)
    for (const root of roots) refreshDiff(root)
    // Rede de segurança: o vigia de arquivos pode perder eventos num disco muito ocupado, então
    // os repositórios em foco são relidos a cada poucos segundos de qualquer jeito.
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') for (const root of roots) refreshDiff(root)
    }, 4000)
    return () => clearInterval(poll)
  }, [rootsKey, refreshDiff])

  useEffect(
    () =>
      api.onGitChanged(root => {
        refreshDiff(root)
        for (const s of live.current.sessions) {
          if (s.root === root) void api.gitInfo(s.cwd).then(info => patch(s.id, { branch: info.branch }))
        }
      }),
    [patch, refreshDiff]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const { sessions: list, focusedId: cur, launcher: open } = live.current
      if (open) {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          setLauncher(null)
        }
        return
      }
      if (!e.ctrlKey || e.altKey || e.metaKey) return
      const key = e.key.toLowerCase()
      if (e.shiftKey) {
        if (key === 'n') setLauncher('agent')
        else if (key === 't') setLauncher('shell')
        else if (key === 'w') cur && closeSession(cur)
        else if (key === 'd') setDiffOpen(v => !v)
        else if (key === 'm') setZoomed(v => !v)
        else if (key === 'g') setView('grid')
        else if (key === 'q') setView('board')
        else if (key === 'r') setView('review')
        else if (key === 'a') {
          const waiting = list.filter(s => statusOf(s, Date.now()) === 'wait')
          const next = waiting[(waiting.findIndex(s => s.id === cur) + 1) % (waiting.length || 1)]
          if (next) onFocus(next.id)
        } else return
      } else if (/^[1-9]$/.test(e.key)) {
        const target = list[Number(e.key) - 1]
        if (target) onFocus(target.id)
      } else return
      e.preventDefault()
      e.stopPropagation()
    }
    // na captura: o xterm não chega a ver as teclas que são do app
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [closeSession, onFocus])

  const status = new Map(sessions.map(s => [s.id, statusOf(s, now)]))
  const count = (st: Status): number => sessions.filter(s => status.get(s.id) === st).length
  const agents = sessions.filter(s => s.kind === 'agent')
  const shells = sessions.filter(s => s.kind === 'shell')

  // A grade: fileiras de painéis, cada fileira com a sua altura e cada painel com a sua largura.
  // Os painéis são posicionados por conta, e não aninhados em fileiras, para que mudar o arranjo
  // nunca desmonte um terminal (desmontar mata o processo dele).
  const counts = rowCounts(sessions.length)
  const sig = counts.join(',')
  const layout = fits(layouts[sig], counts) ? layouts[sig] : equalLayout(counts)
  // na Revisão o terminal ao lado do diff é sempre o da sessão em foco, sozinho
  const isZoomed = (zoomed || view === 'review') && sessions.length > 1 && focused !== null
  const rects: { l: number; t: number; w: number; h: number }[] = []
  const rowTop: number[] = []
  {
    const totalH = sum(layout.rowH)
    let y = 0
    counts.forEach((c, r) => {
      const h = (layout.rowH[r] / totalH) * 100
      const totalW = sum(layout.colW[r])
      let x = 0
      rowTop.push(y)
      for (let k = 0; k < c; k++) {
        const w = (layout.colW[r][k] / totalW) * 100
        rects.push({ l: x, t: y, w, h })
        x += w
      }
      y += h
    })
  }
  const setLayout = (change: (l: GridLayout) => GridLayout): void =>
    setLayouts(all => ({ ...all, [sig]: change(fits(all[sig], counts) ? all[sig] : equalLayout(counts)) }))
  const box = (r: { l: number; t: number; w: number; h: number }): CSSProperties => ({
    left: `calc(${r.l}% + 3.5px)`,
    top: `calc(${r.t}% + 3.5px)`,
    width: `calc(${r.w}% - 7px)`,
    height: `calc(${r.h}% - 7px)`
  })
  const FULL = { l: 0, t: 0, w: 100, h: 100 }
  const diffCol = !diffOpen ? '34px' : diffW ? `min(${diffW}px, 60vw)` : 'clamp(420px, 28vw, 760px)'
  const reviewCol = reviewW ? `min(${reviewW}px, 60vw)` : 'clamp(420px, 30vw, 760px)'
  const focusedRepos = focusedRoots.map(root => ({ root, diff: diffs[root] }))
  /** Linhas mudadas nos repositórios de uma sessão; null quando não há nada para mostrar. */
  const totals = (roots: string[]): { added: number; removed: number } | null => {
    const read = roots.map(r => diffs[r]).filter(d => d && !d.error && d.files.length > 0)
    return read.length === 0 ? null : { added: sum(read.map(d => d.added)), removed: sum(read.map(d => d.removed)) }
  }
  const focusedTotals = totals(focusedRoots)

  // Arquivos que algum agente acabou de editar, pelo caminho absoluto normalizado: é o selo
  // "editado há 40 s" na lista de mudanças.
  const edits: Record<string, number> = {}
  for (const s of sessions) {
    for (const [path, at] of Object.entries(s.agent?.edits ?? {})) {
      const p = path.replace(/\\/g, '/').toLowerCase()
      edits[p] = Math.max(edits[p] ?? 0, at)
    }
  }

  const row = (s: Sess) => {
    const st = status.get(s.id)!
    const d = totals(s.roots)
    const running = runningSubs(s).length
    const subs = s.agent?.subagents ?? []
    return (
      <div key={s.id} className="ag-g">
      <button className={`ag is-${st}${s.id === focusedId ? ' sel' : ''}`} onClick={() => onFocus(s.id)}>
        <i className="dot" />
        <span className="ag-b">
          <span className="ag-h">
            <b>{s.name}</b>
            <span className="dim">{elapsed(s.id, st, now) || `Ctrl+${sessions.indexOf(s) + 1}`}</span>
          </span>
          <span className="ag-m">{s.branch ? `${baseName(s.root)} · ${s.branch}` : s.cwd}</span>
          <span className="ag-s">{statusLine(s, st)}</span>
          {(d || running > 0) && (
            <span className="ag-c">
              {d && <span className="add">+{d.added}</span>}
              {d && <span className="del">−{d.removed}</span>}
              {s.roots.length > 1 && <span className="chip">{s.roots.length} repositórios</span>}
              {running > 0 && <span className="chip">{running === 1 ? '1 subagente' : `${running} subagentes`}</span>}
            </span>
          )}
        </span>
      </button>
      {/* cada subagente da sessão, com o que está fazendo agora; um clique leva ao Quadro */}
      {subs.slice(-SIDE_SUBS).map(a => (
        <button key={a.id} className={`sub is-${subStatus(a)}`} title={`${a.name} (${a.type})`} onClick={() => setView('board')}>
          <i className="dot" />
          <span className="ag-b">
            <span className="ag-h">
              <b>{a.name}</b>
              <span className="dim">{durationShort((a.endedAt ?? now) - a.startedAt)}</span>
            </span>
            <span className="ag-s">{a.detail || (a.done ? 'Terminou' : 'Começando')}</span>
          </span>
        </button>
      ))}
      {subs.length > SIDE_SUBS && (
        <button className="sub more" onClick={() => setView('board')}>
          mais {subs.length - SIDE_SUBS} no Quadro
        </button>
      )}
      </div>
    )
  }

  return (
    <div className="app">
      <header className="top">
        <div className="logo">
          <i />
          Torre
        </div>
        <div className="find" title="Busca por agente, arquivo e comando: ainda não feita">
          <span>Ir para agente, arquivo ou comando</span>
          <span className="mono">em breve</span>
        </div>
        <div className="seg">
          <button className={view === 'grid' ? 'on' : ''} title="Terminais em grade (Ctrl+Shift+G)" onClick={() => setView('grid')}>
            Grade
          </button>
          <button className={view === 'board' ? 'on' : ''} title="O que cada agente está fazendo (Ctrl+Shift+Q)" onClick={() => setView('board')}>
            Quadro
          </button>
          <button className={view === 'review' ? 'on' : ''} title="Revisar as mudanças lado a lado (Ctrl+Shift+R)" onClick={() => setView('review')}>
            Revisão
          </button>
        </div>
      </header>

      <div
        className={`body v-${view}`}
        style={{
          gridTemplateColumns:
            view === 'grid' ? `264px minmax(0, 1fr) ${diffCol}` : view === 'board' ? '264px minmax(0, 1fr)' : `minmax(0, 1fr) ${reviewCol}`
        }}
      >
        <aside className="side">
          <div className="sec">
            <span>Agentes</span>
            <span>{agents.length}</span>
          </div>
          {agents.map(row)}
          <div className="sec">
            <span>Terminais</span>
            <span>{shells.length}</span>
          </div>
          {shells.map(row)}
          <div className="side-f">
            <button className="new" onClick={() => setLauncher('agent')}>
              <span>Novo agente</span>
              <span className="mono">Ctrl+Shift+N</span>
            </button>
            <button className="new" onClick={() => setLauncher('shell')}>
              <span>Novo terminal</span>
              <span className="mono">Ctrl+Shift+T</span>
            </button>
          </div>
        </aside>

        <main className="grid" ref={gridRef}>
          {sessions.length === 0 && (
            <div className="empty">
              <b>Nenhum agente aberto</b>
              <p>Cada agente roda num terminal próprio, na pasta que você escolher.</p>
              <div className="empty-a">
                <button className="btn pri" onClick={() => setLauncher('agent')}>
                  Novo agente
                </button>
                <button className="btn" onClick={() => setLauncher('shell')}>
                  Novo terminal
                </button>
              </div>
            </div>
          )}
          {sessions.map((s, i) => {
            const st = status.get(s.id)!
            const time = elapsed(s.id, st, now)
            return (
              <section
                key={s.id}
                className={`pane is-${st}${s.id === focusedId ? ' focus' : ''}`}
                style={!isZoomed ? box(rects[i]) : s.id === focusedId ? box(FULL) : { display: 'none' }}
                onMouseDown={() => s.id !== focusedId && onFocus(s.id)}
              >
                <div className="pane-h" onDoubleClick={e => (e.target as HTMLElement).closest('button') || setZoomed(v => !v)}>
                  <i className="dot" />
                  <b>{s.name}</b>
                  <span className="mono dim">{s.branch ?? ''}</span>
                  <span className="t">
                    {statusLabel(s, st)}
                    {time && ` · ${time}`}
                  </span>
                  {sessions.length > 1 && view === 'grid' && (
                    <button
                      className={isZoomed ? 'icon on' : 'icon'}
                      title={isZoomed ? 'Voltar à grade (Ctrl+Shift+M)' : 'Maximizar (Ctrl+Shift+M)'}
                      onClick={() => {
                        onFocus(s.id)
                        setZoomed(v => !v)
                      }}
                    >
                      <i className="ico-max" />
                    </button>
                  )}
                  <button className="icon" title="Fechar (Ctrl+Shift+W)" onClick={() => closeSession(s.id)}>
                    ×
                  </button>
                </div>
                <TerminalView
                  id={s.id}
                  kind={s.kind}
                  cwd={s.cwd}
                  focused={s.id === focusedId && launcher === null && view !== 'board'}
                  onFocus={onFocus}
                  onTitle={onTitle}
                  onAttention={onAttention}
                  onInput={onInput}
                  onError={onError}
                />
              </section>
            )
          })}
          {!isZoomed &&
            counts.flatMap((c, r) => {
              const first = sum(counts.slice(0, r))
              const gutters = []
              // entre dois painéis da mesma fileira
              for (let k = 0; k < c - 1; k++) {
                const right = rects[first + k + 1]
                gutters.push(
                  <Gutter
                    key={`v${r}-${k}`}
                    className="gut v"
                    style={{ left: `${right.l}%`, top: `${right.t}%`, height: `${right.h}%` }}
                    onStart={() => {
                      const start = layout.colW[r]
                      const width = gridRef.current?.clientWidth || 1
                      return dx =>
                        setLayout(l => ({ ...l, colW: l.colW.map((row, i) => (i === r ? shift(start, k, (dx / width) * sum(start)) : row)) }))
                    }}
                    onReset={() => setLayout(l => ({ ...l, colW: l.colW.map((row, i) => (i === r ? row.map(() => 1) : row)) }))}
                  />
                )
              }
              // entre esta fileira e a de cima
              if (r > 0) {
                gutters.push(
                  <Gutter
                    key={`h${r}`}
                    className="gut h"
                    style={{ top: `${rowTop[r]}%` }}
                    onStart={() => {
                      const start = layout.rowH
                      const height = gridRef.current?.clientHeight || 1
                      return (_dx, dy) => setLayout(l => ({ ...l, rowH: shift(start, r - 1, (dy / height) * sum(start)) }))
                    }}
                    onReset={() => setLayout(l => ({ ...l, rowH: l.rowH.map(() => 1) }))}
                  />
                )
              }
              return gutters
            })}
        </main>

        {view === 'board' && (
          <Board
            sessions={sessions}
            status={status}
            now={now}
            totals={totals}
            onOpen={id => {
              onFocus(id)
              setView('grid')
            }}
            onReview={id => {
              onFocus(id)
              setView('review')
            }}
          />
        )}

        {view === 'review' && (
          <div className="review-wrap">
            <Review
              repos={focusedRepos}
              label={focused?.name ?? null}
              canComment={!!focused && (focused.kind === 'agent' || focused.agent !== null)}
              edits={edits}
              now={now}
              onRefresh={() => focusedRoots.forEach(refreshDiff)}
              onSend={text => focused && api.write(focused.id, text + '\r')}
            />
            <Gutter
              className="gut v edge-r"
              onStart={() => {
                const start = gridRef.current?.offsetWidth ?? 600
                const max = Math.max(360, window.innerWidth - 700)
                return dx => setReviewW(Math.round(Math.min(Math.max(start - dx, 360), max)))
              }}
              onReset={() => setReviewW(null)}
            />
          </div>
        )}

        {view !== 'grid' ? null : diffOpen ? (
          <div className="diff-wrap" ref={diffRef}>
            <Gutter
              className="gut v edge"
              onStart={() => {
                const start = diffRef.current?.offsetWidth ?? 600
                const max = Math.max(320, window.innerWidth - 264 - 360)
                return dx => setDiffW(Math.round(Math.min(Math.max(start - dx, 320), max)))
              }}
              onReset={() => setDiffW(null)}
            />
            <DiffPanel
              edits={edits}
              now={now}
              repos={focusedRepos}
              label={focused?.name ?? null}
              onRefresh={() => focusedRoots.forEach(refreshDiff)}
              onMinimize={() => setDiffOpen(false)}
            />
          </div>
        ) : (
          <aside className="rail">
            <button className="icon" title="Abrir mudanças (Ctrl+Shift+D)" onClick={() => setDiffOpen(true)}>
              «
            </button>
            <button className="rail-b" title="Abrir mudanças (Ctrl+Shift+D)" onClick={() => setDiffOpen(true)}>
              <span>Mudanças</span>
              {focusedTotals && (
                <span className="mono">
                  <span className="add">+{focusedTotals.added}</span> <span className="del">−{focusedTotals.removed}</span>
                </span>
              )}
            </button>
          </aside>
        )}
      </div>

      <footer className="status">
        <span>
          {sessions.length} {sessions.length === 1 ? 'sessão' : 'sessões'}
        </span>
        <span className="is-run">
          <i className="dot" /> {count('run')} trabalhando
        </span>
        <span className="is-wait">
          <i className="dot" /> {count('wait')} esperando você
        </span>
        <span className="is-done">
          <i className="dot" /> {count('done')} terminou
        </span>
        <span className="is-idle">
          <i className="dot" /> {count('idle')} parado
        </span>
        <span className="r">
          <span>
            <kbd>Ctrl</kbd> <kbd>1…9</kbd> pular para sessão
          </span>
          <span>
            <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>A</kbd> ir para quem espera
          </span>
          <span>
            <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>M</kbd> maximizar
          </span>
          <span>
            <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>D</kbd> mudanças
          </span>
        </span>
      </footer>

      {launcher && <Launcher kind={launcher} onOpen={openSession} onClose={() => setLauncher(null)} />}
    </div>
  )
}
