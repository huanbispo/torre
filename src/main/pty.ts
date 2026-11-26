import * as pty from 'node-pty'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { CreateSessionOptions } from '../shared/types'
import { PIPE } from './hooks'

/** Junta a saída por alguns milissegundos: uma mensagem por pedaço trava a interface numa enxurrada. */
const FLUSH_MS = 8

function findShell(): string {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, 'pwsh.exe'))) return join(dir, 'pwsh.exe')
  }
  return 'powershell.exe'
}

/** O ambiente do filho: o do app, sem o que é do Electron ou de uma sessão do Claude Code que tenha aberto o app. */
function childEnv(id: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    // Quando o próprio Torre foi aberto de dentro de uma sessão do Claude Code, estas variáveis
    // marcam os filhos como "sessão filha" daquela (sem transcript, falando com o pai). Um agente
    // aberto aqui é uma sessão independente, então elas não passam adiante.
    if (/^(ELECTRON_|NODE_ENV_ELECTRON_VITE|TORRE_|CLAUDECODE$|CLAUDE_PID$|CLAUDE_CODE_(ENTRYPOINT|SSE_PORT|CHILD_|MESSAGING_|SESSION_))/i.test(k)) continue
    env[k] = v
  }
  env.TORRE_PANE = id
  env.TORRE_PIPE = PIPE // por aqui os hooks do Claude Code avisam o app
  env.TERM_PROGRAM = 'torre'
  env.COLORTERM = 'truecolor'
  return env
}

export class PtyManager {
  private ptys = new Map<string, pty.IPty>()
  private pending = new Map<string, string>()
  private timer: NodeJS.Timeout | null = null
  /** O settings com os hooks, que cada agente recebe por --settings; null abre o claude sem eles. */
  hookSettings: string | null = null

  constructor(
    private onData: (id: string, data: string) => void,
    private onExit: (id: string, code: number) => void
  ) {}

  create(o: CreateSessionOptions): void {
    if (this.ptys.has(o.id)) return
    // --settings soma os hooks só a esta sessão: o settings.json do usuário fica como está
    const claude = this.hookSettings ? `claude --settings '${this.hookSettings.replace(/'/g, "''")}'` : 'claude'
    const args = o.kind === 'agent' ? ['-NoLogo', '-NoExit', '-Command', claude] : ['-NoLogo']
    const p = pty.spawn(findShell(), args, {
      name: 'xterm-256color',
      cols: Math.max(o.cols, 20),
      rows: Math.max(o.rows, 5),
      cwd: o.cwd,
      env: childEnv(o.id)
    })
    this.ptys.set(o.id, p)
    p.onData(d => this.push(o.id, d))
    p.onExit(({ exitCode }) => {
      this.flush()
      this.ptys.delete(o.id)
      this.onExit(o.id, exitCode)
    })
  }

  write(id: string, data: string): void {
    this.ptys.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const p = this.ptys.get(id)
    if (!p || cols < 2 || rows < 2) return
    try {
      p.resize(cols, rows)
    } catch {
      // o processo pode ter saído entre o pedido e a chamada
    }
  }

  kill(id: string): void {
    const p = this.ptys.get(id)
    if (!p) return
    this.ptys.delete(id)
    this.pending.delete(id)
    try {
      p.kill()
    } catch {
      // já saiu
    }
  }

  killAll(): void {
    for (const id of [...this.ptys.keys()]) this.kill(id)
  }

  private push(id: string, data: string): void {
    this.pending.set(id, (this.pending.get(id) ?? '') + data)
    this.timer ??= setTimeout(() => this.flush(), FLUSH_MS)
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const [id, data] of this.pending) this.onData(id, data)
    this.pending.clear()
  }
}
