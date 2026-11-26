export type SessionKind = 'agent' | 'shell'

export interface CreateSessionOptions {
  id: string
  kind: SessionKind
  cwd: string
  cols: number
  rows: number
}

export interface GitInfo {
  /** Raiz do repositório, ou null quando a pasta não é um repositório git. */
  root: string | null
  branch: string | null
}

export interface DiffLine {
  t: ' ' | '+' | '-'
  /** Número da linha no arquivo antigo; null em linha adicionada. */
  o: number | null
  /** Número da linha no arquivo novo; null em linha removida. */
  n: number | null
  s: string
}

export interface DiffHunk {
  header: string
  lines: DiffLine[]
}

export interface DiffFile {
  path: string
  status: 'M' | 'A' | 'D' | 'R'
  added: number
  removed: number
  binary: boolean
  /** O arquivo tinha mais linhas do que o painel desenha. */
  truncated: boolean
  hunks: DiffHunk[]
}

export interface DiffResult {
  root: string | null
  branch: string | null
  /** Igual entre duas leituras quando nada mudou. */
  stamp: string
  /** Contra o que o diff foi feito, em palavras: "HEAD" ou "repositório sem commits". */
  base: string
  files: DiffFile[]
  added: number
  removed: number
  error: string | null
}

export interface StartupSession {
  kind: SessionKind
  cwd: string
}

/** Tamanhos de uma grade: a altura relativa de cada fileira e, por fileira, a largura relativa de cada painel. */
export interface GridLayout {
  rowH: number[]
  colW: number[][]
}

/** O que o usuário ajustou na tela e o app lembra entre aberturas. */
export interface UiState {
  diffOpen: boolean
  /** Largura do painel de mudanças em px; null enquanto ninguém arrastou. */
  diffW: number | null
  /** Largura do terminal na tela Revisão em px; null enquanto ninguém arrastou. */
  reviewW?: number | null
  /** Um arranjo por formato de grade: "2,1" são duas fileiras, com 2 e 1 painéis. */
  layouts: Record<string, GridLayout>
}

/** Um evento de hook do Claude Code, já cortado pelo script: só campos escalares e o tool_input raso. */
export interface HookEvent {
  hook_event_name: string
  session_id?: string
  cwd?: string
  /** Presente quando o evento vem de dentro de um subagente, e nos eventos SubagentStart/Stop. */
  agent_id?: string
  agent_type?: string
  tool_name?: string
  tool_input?: Record<string, string | number | boolean>
  message?: string
  notification_type?: string
  prompt?: string
  last_assistant_message?: string
}

export interface TorreApi {
  /** Eventos dos hooks do Claude Code, com o id do painel de onde vieram. */
  onAgentEvent(cb: (pane: string, event: HookEvent) => void): () => void
  /** Aviso do Windows e barra de tarefas piscando; só age com a janela fora de foco. */
  notify(o: { id: string; title: string; body: string }): void
  /** O usuário clicou num aviso do Windows: a sessão que ele quer ver. */
  onFocusSession(cb: (id: string) => void): () => void
  getUi(): Promise<UiState | null>
  setUi(ui: UiState): void
  winBuild: number
  startup: StartupSession[]
  /** Tela em que o app abre (autoteste: TORRE_VIEW); null abre na Grade. */
  startView: 'grid' | 'board' | 'review' | null
  /** Quantos ms depois de abrir a tela de TORRE_VIEW entra (autoteste: TORRE_VIEW_DELAY). */
  startViewDelay: number
  createSession(o: CreateSessionOptions): Promise<{ ok: boolean; error?: string }>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  kill(id: string): void
  onData(cb: (id: string, data: string) => void): () => void
  onExit(cb: (id: string, code: number) => void): () => void
  gitInfo(cwd: string): Promise<GitInfo>
  gitDiff(cwd: string): Promise<DiffResult>
  /** Vigia estes repositórios (os da sessão em foco) e para de vigiar os outros. */
  gitWatch(roots: string[]): void
  onGitChanged(cb: (root: string) => void): () => void
  pickFolder(): Promise<string | null>
  getRecent(): Promise<string[]>
  addRecent(cwd: string): Promise<string[]>
  clipboardRead(): Promise<string>
  clipboardWrite(text: string): void
}
