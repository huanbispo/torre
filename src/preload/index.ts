import { clipboard, contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { release } from 'node:os'
import type { SessionKind, StartupSession, TorreApi } from '../shared/types'

function on<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const h = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, h)
  return () => ipcRenderer.removeListener(channel, h)
}

/** TORRE_OPEN="agent|D:\pasta;shell|D:\outra" abre o app já com essas sessões. */
function startup(): StartupSession[] {
  return (process.env.TORRE_OPEN ?? '')
    .split(';')
    .map(s => s.split('|'))
    .filter(p => p.length === 2 && (p[0] === 'agent' || p[0] === 'shell') && p[1])
    .map(p => ({ kind: p[0] as SessionKind, cwd: p[1] }))
}

const api: TorreApi = {
  onAgentEvent: cb => on('agent:event', cb),
  notify: o => ipcRenderer.send('notify', o),
  onFocusSession: cb => on('focus:session', cb),
  getUi: () => ipcRenderer.invoke('ui:get'),
  setUi: ui => ipcRenderer.send('ui:set', ui),
  winBuild: Number(release().split('.')[2] ?? 0),
  startup: startup(),
  startView: process.env.TORRE_VIEW === 'board' || process.env.TORRE_VIEW === 'review' ? process.env.TORRE_VIEW : null,
  startViewDelay: Number(process.env.TORRE_VIEW_DELAY ?? 0) || 0,
  createSession: o => ipcRenderer.invoke('session:create', o),
  write: (id, data) => ipcRenderer.send('session:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('session:resize', id, cols, rows),
  kill: id => ipcRenderer.send('session:kill', id),
  onData: cb => on('session:data', cb),
  onExit: cb => on('session:exit', cb),
  gitInfo: cwd => ipcRenderer.invoke('git:info', cwd),
  gitDiff: cwd => ipcRenderer.invoke('git:diff', cwd),
  gitWatch: roots => ipcRenderer.send('git:watch', roots),
  onGitChanged: cb => on('git:changed', cb),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  getRecent: () => ipcRenderer.invoke('recent:get'),
  addRecent: cwd => ipcRenderer.invoke('recent:add', cwd),
  clipboardRead: async () => clipboard.readText(),
  clipboardWrite: text => void clipboard.writeText(text)
}

contextBridge.exposeInMainWorld('torre', api)
