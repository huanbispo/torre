import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell } from 'electron'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitDiff, gitInfo, RepoWatcher } from './git'
import { startHookServer, writeHookFiles } from './hooks'
import { PtyManager } from './pty'
import type { CreateSessionOptions, UiState } from '../shared/types'

// Autoteste: TORRE_USER_DATA=<pasta> troca a pasta de dados do app, para um teste não mexer nas
// pastas recentes e nos ajustes de tela de quem usa o app de verdade.
if (process.env.TORRE_USER_DATA) app.setPath('userData', process.env.TORRE_USER_DATA)

let win: BrowserWindow | null = null

const send = (channel: string, ...args: unknown[]): void => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

const ptys = new PtyManager(
  (id, data) => send('session:data', id, data),
  (id, code) => send('session:exit', id, code)
)
const watcher = new RepoWatcher(root => send('git:changed', root))

// --- o que o app lembra entre aberturas: pastas recentes e ajustes da tela ----------------
interface SavedState {
  recent: string[]
  ui: UiState | null
}
const statePath = (): string => join(app.getPath('userData'), 'state.json')
function readState(): SavedState {
  try {
    // um editor pode ter salvo o arquivo com BOM; o JSON.parse não aceita
    const s = JSON.parse(readFileSync(statePath(), 'utf8').replace(/^﻿/, '')) as { recent?: unknown; ui?: unknown }
    return {
      recent: Array.isArray(s.recent) ? s.recent.filter((x): x is string => typeof x === 'string') : [],
      ui: s.ui && typeof s.ui === 'object' ? (s.ui as UiState) : null
    }
  } catch {
    return { recent: [], ui: null }
  }
}
function writeState(s: SavedState): void {
  try {
    writeFileSync(statePath(), JSON.stringify(s, null, 2))
  } catch {
    // sem disco para gravar, o estado vale só para esta abertura
  }
}
function addRecent(cwd: string): string[] {
  const s = readState()
  const recent = [cwd, ...s.recent.filter(p => p.toLowerCase() !== cwd.toLowerCase())].slice(0, 12)
  writeState({ ...s, recent })
  return recent
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 960,
    minHeight: 540,
    show: false,
    backgroundColor: '#0b1016',
    title: 'Torre',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#10171f', symbolColor: '#74859a', height: 40 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })
  win.once('ready-to-show', () => {
    win?.maximize()
    win?.show()
  })
  win.on('closed', () => {
    win = null
  })
  win.on('focus', () => win?.flashFrame(false))
  // links abrem no navegador do sistema, nunca dentro do app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win?.webContents.toggleDevTools()
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))

  // Autoteste: TORRE_SHOT=<arquivo.png> fotografa a janela depois de alguns segundos e sai.
  // TORRE_TYPE=<texto> digita esse texto e Enter no painel em foco, TORRE_TYPE_DELAY ms depois de abrir (padrão 4000).
  // TORRE_DRAG="x1,y1,x2,y2" arrasta o mouse de um ponto ao outro, a um terço da espera.
  const shot = process.env.TORRE_SHOT
  if (shot) {
    win.webContents.once('did-finish-load', () => {
      const wait = Number(process.env.TORRE_SHOT_DELAY ?? 9000)
      const typed = process.env.TORRE_TYPE
      const drag = (process.env.TORRE_DRAG ?? '').split(',').map(Number)
      if (drag.length === 4 && drag.every(Number.isFinite)) {
        const [x1, y1, x2, y2] = drag
        setTimeout(() => {
          const wc = win?.webContents
          wc?.sendInputEvent({ type: 'mouseMove', x: x1, y: y1 })
          wc?.sendInputEvent({ type: 'mouseDown', x: x1, y: y1, button: 'left', clickCount: 1 })
          for (let i = 1; i <= 8; i++) {
            wc?.sendInputEvent({ type: 'mouseMove', x: Math.round(x1 + ((x2 - x1) * i) / 8), y: Math.round(y1 + ((y2 - y1) * i) / 8), button: 'left' })
          }
          wc?.sendInputEvent({ type: 'mouseUp', x: x2, y: y2, button: 'left', clickCount: 1 })
        }, wait / 3)
      }
      if (typed) {
        setTimeout(() => {
          for (const ch of typed) win?.webContents.sendInputEvent({ type: 'char', keyCode: ch })
          win?.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
          win?.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
        }, Number(process.env.TORRE_TYPE_DELAY ?? 4000))
      }
      setTimeout(async () => {
        const img = await win?.webContents.capturePage()
        if (img) writeFileSync(shot, img.toPNG())
        app.quit()
      }, wait)
    })
  }
}

ipcMain.handle('session:create', (_e, o: CreateSessionOptions) => {
  if (!existsSync(o.cwd)) return { ok: false, error: `A pasta não existe: ${o.cwd}` }
  try {
    ptys.create(o)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})
ipcMain.on('session:write', (_e, id: string, data: string) => ptys.write(id, data))
ipcMain.on('session:resize', (_e, id: string, cols: number, rows: number) => ptys.resize(id, cols, rows))
ipcMain.on('session:kill', (_e, id: string) => ptys.kill(id))
ipcMain.handle('git:info', (_e, cwd: string) => gitInfo(cwd))
ipcMain.handle('git:diff', (_e, cwd: string) => gitDiff(cwd))
ipcMain.on('git:watch', (_e, roots: string[]) => watcher.watch(Array.isArray(roots) ? roots : []))
ipcMain.handle('dialog:pickFolder', async () => {
  if (!win) return null
  const r = await dialog.showOpenDialog(win, { title: 'Pasta do projeto', properties: ['openDirectory'] })
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
})
ipcMain.handle('recent:get', () => readState().recent)
ipcMain.handle('ui:get', () => readState().ui)
ipcMain.on('ui:set', (_e, ui: UiState) => writeState({ ...readState(), ui }))
ipcMain.handle('recent:add', (_e, cwd: string) => addRecent(cwd))

// Um agente passou a esperar o usuário, ou terminou, com a janela fora de foco.
ipcMain.on('notify', (_e, o: { id: string; title: string; body: string }) => {
  if (!win || win.isDestroyed() || win.isFocused()) return
  win.flashFrame(true)
  if (!Notification.isSupported()) return
  const n = new Notification({ title: o.title, body: o.body })
  n.on('click', () => {
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    send('focus:session', o.id)
  })
  n.show()
})

app.whenReady().then(() => {
  // O menu padrão traz Ctrl+W (fecha a janela) e Ctrl+R (recarrega), que matariam os terminais.
  Menu.setApplicationMenu(null)
  app.setAppUserModelId('Torre') // sem isso o Windows não mostra os avisos de um app não instalado
  try {
    ptys.hookSettings = writeHookFiles(app.getPath('userData'))
    // Autoteste: TORRE_HOOK_LOG=<arquivo> guarda cada evento recebido, uma linha de JSON por evento.
    const log = process.env.TORRE_HOOK_LOG
    startHookServer((pane, event) => {
      if (log) appendFileSync(log, JSON.stringify({ pane, event }) + '\n')
      send('agent:event', pane, event)
    })
  } catch {
    // sem os hooks o app continua valendo: o estado dos agentes volta a ser estimado pela saída
    ptys.hookSettings = null
  }
  createWindow()
})

app.on('window-all-closed', () => {
  watcher.close()
  ptys.killAll()
  app.quit()
})
