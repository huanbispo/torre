// Uma sessão do app (um painel de terminal) e o estado que ela mostra por fora.

import type { SessionKind } from '../../shared/types'
import type { AgentState, SubAgent } from './agent'
import { bus } from './bus'

export interface Sess {
  id: string
  kind: SessionKind
  cwd: string
  name: string
  /** Raiz do repositório; a própria pasta enquanto o git não respondeu ou quando não é repositório. */
  root: string
  /** Os repositórios que o painel de mudanças mostra para esta sessão: o da pasta onde ela abriu
   *  (se for um) e os de cada arquivo que o agente editou depois. */
  roots: string[]
  branch: string | null
  /** Título que o programa deu ao terminal; o Claude Code põe aqui um resumo do que faz. */
  title: string
  attention: string | null
  exitCode: number | null
  error: string | null
  /** O estado contado pelos hooks do Claude Code; null enquanto nenhum evento chegou desta sessão. */
  agent: AgentState | null
}

export type Status = 'run' | 'wait' | 'done' | 'idle' | 'exit'

export const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

/** Um turno interrompido com Esc não dispara hook nenhum. Quem trabalha mexe na tela o tempo todo
 *  (o contador do Claude Code gira), então "trabalhando" sem evento e sem saída por este tempo é parado. */
const SILENT_MS = 6000

export const runningSubs = (s: Sess): SubAgent[] => s.agent?.subagents.filter(a => !a.done) ?? []

export function statusOf(s: Sess, now: number): Status {
  if (s.exitCode !== null || s.error) return 'exit'
  const a = s.agent
  if (a) {
    if (a.phase === 'waiting') return 'wait'
    // um subagente de fundo ainda rodando: a sessão trabalha, mesmo com o principal parado à espera dele
    if (runningSubs(s).length > 0) return 'run'
    if (a.main === 'working') return now - a.lastEventAt < SILENT_MS || bus.isActive(s.id, now, SILENT_MS) ? 'run' : 'idle'
    return a.main === 'done' ? 'done' : 'idle'
  }
  // sem hooks (um terminal, ou um claude aberto à mão): estima pela saída
  if (s.attention) return 'wait'
  return bus.isActive(s.id, now) ? 'run' : 'idle'
}

export function statusLabel(s: Sess, st: Status): string {
  if (st === 'exit') return 'encerrado'
  if (st === 'wait') return 'esperando você'
  if (st === 'done') return 'terminou'
  if (st === 'run') return s.kind === 'agent' ? 'trabalhando' : 'rodando'
  return s.kind === 'agent' ? 'parado' : 'livre'
}

/** A linha de baixo de cada sessão na lateral: o que ela está fazendo, em palavras. */
export function statusLine(s: Sess, st: Status): string {
  if (st === 'exit') return s.error ?? 'Processo encerrado'
  const a = s.agent
  if (a) {
    if (st === 'wait') return a.askDetail || 'Pediu sua atenção'
    if (st === 'run' && a.main !== 'working') {
      const n = runningSubs(s).length
      return n === 1 ? 'Esperando 1 subagente' : `Esperando ${n} subagentes`
    }
    if (st !== 'idle' && a.detail) return a.detail
  }
  if (st === 'wait') return s.attention ?? 'Pediu sua atenção'
  if (s.kind === 'agent' && s.title) return s.title
  const label = statusLabel(s, st)
  return label[0].toUpperCase() + label.slice(1)
}

// Desde quando cada sessão está no estado atual, para o "· 12 min" ao lado dele.
const since = new Map<string, { st: Status; at: number }>()

export function elapsed(id: string, st: Status, now: number): string {
  const cur = since.get(id)
  if (!cur || cur.st !== st) {
    since.set(id, { st, at: now })
    return ''
  }
  return duration(now - cur.at)
}

export const forget = (id: string): void => void since.delete(id)

/** "12 min", "1 h 05 min"; vazio abaixo de um minuto. */
export function duration(ms: number): string {
  const min = Math.floor(ms / 60000)
  if (min < 1) return ''
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`
}

/** Como `duration`, mas conta também os segundos do primeiro minuto: "40 s". */
export const durationShort = (ms: number): string => duration(ms) || `${Math.max(0, Math.floor(ms / 1000))} s`

/** Hora do relógio de um instante: "14:32". */
export const clock = (at: number): string => new Date(at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

/** O estado de um subagente com as mesmas palavras e cores de uma sessão. */
export const subStatus = (a: SubAgent): Status => (a.waiting ? 'wait' : a.done ? 'done' : 'run')
