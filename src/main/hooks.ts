import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import type { HookEvent } from '../shared/types'

/** O canal por onde os hooks falam com o app. Um por processo, para duas janelas do Torre não se misturarem. */
export const PIPE = `\\\\.\\pipe\\torre-${process.pid}`

/** Os eventos do Claude Code que o app escuta. Um nome que a versão instalada não conheça vira só um aviso lá. */
const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'SessionEnd'
]

// O script que o Claude Code roda em cada evento. Lê o JSON do evento na entrada padrão, corta o
// que é grande (conteúdo de arquivo, saída de comando) e manda uma linha pelo pipe. Não escreve
// nada na saída: em alguns eventos o Claude Code põe a saída do hook na conversa.
const HOOK_SCRIPT = String.raw`'use strict'
const pipe = process.env.TORRE_PIPE
const pane = process.env.TORRE_PANE
if (!pipe || !pane) process.exit(0) // fora do Torre: nada a fazer

const cut = (v, n) => (v.length > n ? v.slice(0, n) + '…' : v)
const scalars = (obj, n) => {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') out[k] = cut(v, n)
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v
  }
  return out
}

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', d => (raw += d))
process.stdin.on('end', () => {
  let ev
  try {
    ev = JSON.parse(raw)
  } catch {
    process.exit(0)
  }
  if (!ev || typeof ev !== 'object') process.exit(0)
  const event = scalars(ev, 500)
  if (ev.tool_input && typeof ev.tool_input === 'object') event.tool_input = scalars(ev.tool_input, 300)
  const done = () => process.exit(0)
  const sock = require('net').connect(pipe)
  sock.on('error', done)
  sock.on('connect', () => sock.end(JSON.stringify({ pane, event }) + '\n', done))
  setTimeout(done, 1500)
})
`

/** Grava o script e o settings dos hooks na pasta de dados do app e devolve o caminho do settings. */
export function writeHookFiles(userData: string): string {
  const dir = join(userData, 'hook')
  mkdirSync(dir, { recursive: true })
  const script = join(dir, 'torre-hook.cjs')
  writeFileSync(script, HOOK_SCRIPT)
  // Forma exec (comando + args): o Claude Code chama o node direto, sem shell no meio e sem aspas
  // para errar. async: o hook só avisa, então não segura a ferramenta enquanto o node sobe.
  const hook = { type: 'command', command: 'node', args: [script.replace(/\\/g, '/')], async: true, timeout: 5 }
  const hooks: Record<string, unknown> = {}
  for (const name of EVENTS) hooks[name] = [{ hooks: [hook] }]
  const settings = join(dir, 'claude-settings.json')
  writeFileSync(settings, JSON.stringify({ hooks }, null, 2))
  return settings
}

export function startHookServer(onEvent: (pane: string, event: HookEvent) => void): Server {
  const server = createServer(sock => {
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('data', d => {
      buf += d
      if (buf.length > 256 * 1024) sock.destroy() // um evento já cortado nunca chega perto disso
    })
    sock.on('error', () => {})
    sock.on('end', () => {
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line) as { pane?: unknown; event?: { hook_event_name?: unknown } }
          if (typeof msg.pane === 'string' && msg.event && typeof msg.event.hook_event_name === 'string') {
            onEvent(msg.pane, msg.event as HookEvent)
          }
        } catch {
          // linha quebrada: ignora
        }
      }
    })
  })
  server.on('error', () => {})
  server.listen(PIPE)
  return server
}
