// O estado de uma sessão do Claude Code, montado a partir dos eventos de hook: o agente principal,
// cada subagente que ele abre, e a linha do tempo do que todos fizeram.
// Função pura: mesmo estado e mesmo evento dão sempre o mesmo resultado.

import type { HookEvent } from '../../shared/types'

/** O que a sessão mostra por fora. "waiting" é derivado: há algum pedido de permissão em aberto. */
export type Phase = 'idle' | 'working' | 'waiting' | 'done'

export type StepKind = 'prompt' | 'tool' | 'ask' | 'done' | 'sub'

/** Um passo na linha do tempo da sessão. */
export interface Step {
  at: number
  kind: StepKind
  text: string
  /** Id do subagente que deu o passo; null quando foi o agente principal. */
  agent: string | null
}

export interface SubAgent {
  id: string
  /** O tipo de agente: general-purpose, Explore… */
  type: string
  /** A tarefa que o agente principal deu a ele, quando o app viu o pedido; senão, o tipo. */
  name: string
  done: boolean
  /** Parado num pedido de permissão. */
  waiting: boolean
  startedAt: number
  endedAt: number | null
  /** O que ele está fazendo agora, em uma linha. */
  detail: string
  /** Quantas ferramentas já chamou. */
  tools: number
  /** O começo da resposta final dele. */
  result: string
}

export interface AgentState {
  phase: Phase
  /** O agente principal sozinho, sem contar subagentes nem pedidos de permissão. */
  main: 'idle' | 'working' | 'done'
  /** A última coisa que o agente principal fez, em uma linha. */
  detail: string
  /** Pedidos de permissão em aberto: quem pediu ("main" ou o id do subagente) → quando. */
  asks: Record<string, number>
  /** O pedido de permissão mais recente, em palavras. */
  askDetail: string
  /** O último pedido do usuário. */
  prompt: string
  /** Id da sessão do Claude Code, para retomar com `claude --resume`. */
  claudeSession: string | null
  subagents: SubAgent[]
  /** Tarefas que o principal mandou abrir e cujo subagente ainda não apareceu. */
  pending: { type: string; name: string }[]
  /** Os últimos passos de todos, do mais antigo ao mais novo. */
  steps: Step[]
  /** Quantas ferramentas o agente principal chamou neste turno. */
  tools: number
  /** Arquivos que a sessão editou: caminho absoluto → quando. */
  edits: Record<string, number>
  lastEventAt: number
}

export const initialAgent: AgentState = {
  phase: 'idle',
  main: 'idle',
  detail: '',
  asks: {},
  askDetail: '',
  prompt: '',
  claudeSession: null,
  subagents: [],
  pending: [],
  steps: [],
  tools: 0,
  edits: {},
  lastEventAt: 0
}

const MAX_STEPS = 120
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
/** Os hooks rodam soltos, cada um num processo: o PreToolUse de uma chamada pode chegar logo depois
 *  do pedido de permissão dela. Dentro desta janela ele não desfaz o "esperando você". */
const LATE_MS = 2000

const oneLine = (s: string, n: number): string => {
  const first = s.trim().split(/\r?\n/)[0] ?? ''
  return first.length > n ? first.slice(0, n) + '…' : first
}

/** Os dois últimos pedaços do caminho: o bastante para reconhecer o arquivo numa linha curta. */
const shortPath = (p: string): string => p.split(/[\\/]/).filter(Boolean).slice(-2).join('/')

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Uma chamada de ferramenta em palavras: "Edit auth/token.ts", "Bash npm test". */
export function describeTool(name: string, input: HookEvent['tool_input'] = {}): string {
  if (name === 'Bash' || name === 'PowerShell') return `${name} ${oneLine(str(input.command), 90)}`.trim()
  if (EDIT_TOOLS.has(name) || name === 'Read') return `${name} ${shortPath(str(input.file_path) || str(input.notebook_path))}`.trim()
  if (name === 'Grep' || name === 'Glob') return `${name} ${oneLine(str(input.pattern), 70)}`.trim()
  if (name === 'Agent' || name === 'Task') return `Agent ${oneLine(str(input.description) || str(input.subagent_type), 70)}`.trim()
  if (name === 'WebFetch') return `WebFetch ${oneLine(str(input.url), 70)}`.trim()
  if (name === 'WebSearch') return `WebSearch ${oneLine(str(input.query), 70)}`.trim()
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  return mcp ? `${mcp[2]} (${mcp[1]})` : name
}

/** A fase que a sessão mostra: um pedido em aberto vence o resto. */
const phaseOf = (s: AgentState): Phase => (Object.keys(s.asks).length > 0 ? 'waiting' : s.main)

const withStep = (s: AgentState, step: Step): AgentState => ({ ...s, steps: [...s.steps, step].slice(-MAX_STEPS) })

/** Aplica uma mudança a um subagente; se o app não viu ele começar, passa a conhecê-lo agora. */
function onSub(s: AgentState, id: string, type: string | undefined, now: number, change: (a: SubAgent) => SubAgent): AgentState {
  const known = s.subagents.some(a => a.id === id)
  const list: SubAgent[] = known
    ? s.subagents
    : [...s.subagents, { id, type: type ?? 'subagente', name: type ?? 'subagente', done: false, waiting: false, startedAt: now, endedAt: null, detail: '', tools: 0, result: '' }]
  return { ...s, subagents: list.map(a => (a.id === id ? change(a) : a)) }
}

const dropAsk = (asks: Record<string, number>, key: string): Record<string, number> => {
  if (!(key in asks)) return asks
  const { [key]: _gone, ...rest } = asks
  return rest
}

/** O usuário respondeu no terminal (Enter, um número, Esc): os pedidos em aberto saem. */
export function answered(s: AgentState, now: number): AgentState {
  const next: AgentState = { ...s, asks: {}, lastEventAt: now, subagents: s.subagents.map(a => (a.waiting ? { ...a, waiting: false } : a)) }
  return { ...next, phase: phaseOf(next) }
}

export function reduce(s: AgentState, ev: HookEvent, now: number): AgentState {
  const next = step(s, ev, now)
  return { ...next, phase: phaseOf(next) }
}

function step(s: AgentState, ev: HookEvent, now: number): AgentState {
  const base: AgentState = { ...s, lastEventAt: now, claudeSession: ev.session_id ?? s.claudeSession }
  const name = ev.hook_event_name
  // um evento de ferramenta com agent_id aconteceu dentro de um subagente
  const sub = name !== 'SubagentStart' && name !== 'SubagentStop' && ev.agent_id ? ev.agent_id : null
  const who = sub ?? 'main'
  const tool = (): string => describeTool(ev.tool_name ?? '', ev.tool_input)

  switch (name) {
    case 'SessionStart':
    case 'SessionEnd':
      return { ...initialAgent, claudeSession: base.claudeSession, lastEventAt: now }

    case 'UserPromptSubmit':
      return withStep(
        // os subagentes de fundo continuam valendo de um turno para o outro; os que já acabaram saem
        { ...base, main: 'working', prompt: ev.prompt ?? '', detail: 'Pensando', tools: 0, asks: {}, subagents: s.subagents.filter(a => !a.done) },
        { at: now, kind: 'prompt', text: oneLine(ev.prompt ?? '', 140), agent: null }
      )

    case 'PreToolUse': {
      const late = who in s.asks && now - s.asks[who] < LATE_MS
      const text = tool()
      const asks = late ? s.asks : dropAsk(s.asks, who)
      if (sub) {
        const out = onSub({ ...base, asks }, sub, ev.agent_type, now, a => ({ ...a, detail: text, tools: a.tools + 1, waiting: late ? a.waiting : false }))
        return withStep(out, { at: now, kind: 'tool', text, agent: sub })
      }
      const isAgent = ev.tool_name === 'Agent' || ev.tool_name === 'Task'
      const pending = isAgent
        ? [...s.pending, { type: str(ev.tool_input?.subagent_type) || 'general-purpose', name: oneLine(str(ev.tool_input?.description), 90) }].slice(-20)
        : s.pending
      return withStep({ ...base, asks, main: 'working', detail: text, tools: s.tools + 1, pending }, { at: now, kind: 'tool', text, agent: null })
    }

    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const path = String(ev.tool_input?.file_path ?? ev.tool_input?.notebook_path ?? '')
      const edited = name === 'PostToolUse' && EDIT_TOOLS.has(ev.tool_name ?? '') && path
      const out: AgentState = { ...base, asks: dropAsk(s.asks, who), edits: edited ? { ...s.edits, [path]: now } : s.edits }
      if (sub) return onSub(out, sub, ev.agent_type, now, a => ({ ...a, waiting: false }))
      return { ...out, main: 'working' }
    }

    case 'PermissionRequest': {
      const text = `Pede permissão: ${tool()}`
      const out: AgentState = { ...base, asks: { ...s.asks, [who]: now }, askDetail: text }
      const marked = sub ? onSub(out, sub, ev.agent_type, now, a => ({ ...a, waiting: true, detail: text })) : out
      return withStep(marked, { at: now, kind: 'ask', text, agent: sub })
    }

    case 'Notification': {
      const type = ev.notification_type ?? ''
      const message = ev.message ?? ''
      // "esperando há um minuto": o turno já acabou; não é um pedido novo
      if (type === 'idle_prompt') return s.main === 'working' ? { ...base, main: 'done', detail: 'Terminou' } : base
      const asks =
        ['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input'].includes(type) ||
        (!type && /permission|needs your|waiting for/i.test(message))
      // se o PermissionRequest já registrou o pedido, ele disse mais do que esta mensagem genérica
      if (!asks || Object.keys(s.asks).length > 0) return base
      return withStep(
        { ...base, asks: { main: now }, askDetail: message || 'Pediu sua atenção' },
        { at: now, kind: 'ask', text: message || 'Pediu sua atenção', agent: null }
      )
    }

    case 'Stop': {
      const text = oneLine(ev.last_assistant_message ?? '', 160) || 'Terminou'
      return withStep({ ...base, main: 'done', detail: text, asks: dropAsk(s.asks, 'main') }, { at: now, kind: 'done', text, agent: null })
    }

    case 'StopFailure':
      // o turno acabou por erro da API (limite, autenticação); o Stop não vem nesse caso
      return withStep(
        { ...base, main: 'done', detail: 'Parou por erro da API', asks: dropAsk(s.asks, 'main') },
        { at: now, kind: 'done', text: 'Parou por erro da API', agent: null }
      )

    case 'SubagentStart': {
      const id = ev.agent_id ?? ''
      if (!id) return base
      const type = ev.agent_type ?? 'subagente'
      // a tarefa veio pouco antes, na chamada Agent do principal: a mais antiga do mesmo tipo é a dele
      const i = Math.max(
        s.pending.findIndex(p => p.type === type),
        s.pending.length > 0 ? 0 : -1
      )
      const task = i >= 0 ? s.pending[i] : null
      const label = task?.name || type
      const out = onSub({ ...base, pending: task ? s.pending.filter((_, k) => k !== i) : s.pending }, id, type, now, a => ({
        ...a,
        type,
        name: label,
        done: false,
        startedAt: now,
        endedAt: null
      }))
      return withStep(out, { at: now, kind: 'sub', text: `Começou: ${label}`, agent: id })
    }

    case 'SubagentStop': {
      const id = ev.agent_id ?? ''
      if (!id) return base
      const result = oneLine(ev.last_assistant_message ?? '', 160)
      const out = onSub({ ...base, asks: dropAsk(s.asks, id) }, id, ev.agent_type, now, a => ({
        ...a,
        done: true,
        waiting: false,
        endedAt: now,
        result,
        detail: result || 'Terminou'
      }))
      return withStep(out, { at: now, kind: 'sub', text: `Terminou${result ? `: ${result}` : ''}`, agent: id })
    }

    default:
      return base
  }
}
