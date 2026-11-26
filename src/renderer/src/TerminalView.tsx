import { memo, useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import type { SessionKind } from '../../shared/types'
import { bus } from './bus'

const api = window.torre

const THEME = {
  background: '#0d131a',
  foreground: '#cdd6e1',
  cursor: '#cdd6e1',
  cursorAccent: '#0d131a',
  selectionBackground: 'rgba(86,182,247,.32)',
  black: '#17202b',
  red: '#f47070',
  green: '#5ccf88',
  yellow: '#f5b04c',
  blue: '#56b6f7',
  magenta: '#b9a4f5',
  cyan: '#5fd0d6',
  white: '#cdd6e1',
  brightBlack: '#74859a',
  brightRed: '#ff8f8f',
  brightGreen: '#7ee2a4',
  brightYellow: '#ffc876',
  brightBlue: '#82caff',
  brightMagenta: '#cdbdff',
  brightCyan: '#86e3e8',
  brightWhite: '#f1f5f9'
}

interface Props {
  id: string
  kind: SessionKind
  cwd: string
  focused: boolean
  onFocus(id: string): void
  onTitle(id: string, title: string): void
  onAttention(id: string, text: string): void
  onInput(id: string, data: string): void
  onError(id: string, message: string): void
}

export const TerminalView = memo(function TerminalView(p: Props) {
  const host = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  // os avisos mudam de identidade a cada desenho do pai; o terminal é criado uma vez só
  const cb = useRef(p)
  cb.current = p

  useEffect(() => {
    const el = host.current!
    const { id, kind, cwd } = cb.current
    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      windowsPty: { backend: 'conpty', buildNumber: api.winBuild },
      theme: THEME
    })
    termRef.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    try {
      const gl = new WebglAddon()
      gl.onContextLoss(() => gl.dispose())
      term.loadAddon(gl)
    } catch {
      // sem WebGL o xterm desenha pelo DOM, mais devagar e igual
    }
    fit.fit()

    const detach = bus.attach(id, data => term.write(data))
    void api.createSession({ id, kind, cwd, cols: term.cols, rows: term.rows }).then(r => {
      if (!r.ok) cb.current.onError(id, r.error ?? 'Não foi possível abrir o terminal')
    })

    term.onData(data => {
      bus.input(id)
      cb.current.onInput(id, data)
      api.write(id, data)
    })
    term.onResize(({ cols, rows }) => api.resize(id, cols, rows))
    term.onTitleChange(title => cb.current.onTitle(id, title))
    term.onBell(() => {
      // o PowerShell toca o sino por qualquer coisa; num agente ele quer dizer "olhe aqui"
      if (kind === 'agent') cb.current.onAttention(id, 'Pediu sua atenção')
    })
    // OSC 9 "mensagem" (9;4;… é barra de progresso), OSC 777 "notify;título;corpo", OSC 99 "meta;texto"
    term.parser.registerOscHandler(9, data => {
      if (!/^4;/.test(data) && data.trim()) cb.current.onAttention(id, data.trim())
      return true
    })
    term.parser.registerOscHandler(777, data => {
      const [verb, title, body] = data.split(';')
      if (verb === 'notify') cb.current.onAttention(id, (body || title || 'Pediu sua atenção').trim())
      return true
    })
    term.parser.registerOscHandler(99, data => {
      const text = data.slice(data.indexOf(';') + 1).trim()
      if (text) cb.current.onAttention(id, text)
      return true
    })

    term.attachCustomKeyEventHandler(ev => {
      if (ev.type !== 'keydown') return true
      const key = ev.key.toLowerCase()
      if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && key === 'c' && term.hasSelection()) {
        api.clipboardWrite(term.getSelection())
        term.clearSelection()
        return false
      }
      if (ev.ctrlKey && !ev.altKey && key === 'v') {
        ev.preventDefault()
        void api.clipboardRead().then(text => {
          if (text) term.paste(text)
          else api.write(id, '\x16') // sem texto (uma imagem, por exemplo): o programa recebe o Ctrl+V
        })
        return false
      }
      if (kind === 'agent' && ev.shiftKey && !ev.ctrlKey && !ev.altKey && ev.key === 'Enter') {
        ev.preventDefault()
        api.write(id, '\x1b\r') // quebra de linha no Claude Code
        return false
      }
      return true
    })

    const onContext = (ev: MouseEvent): void => {
      ev.preventDefault()
      if (term.hasSelection()) {
        api.clipboardWrite(term.getSelection())
        term.clearSelection()
      } else {
        void api.clipboardRead().then(text => text && term.paste(text))
      }
    }
    el.addEventListener('contextmenu', onContext)
    const onFocusIn = (): void => cb.current.onFocus(id)
    el.addEventListener('focusin', onFocusIn)

    // Enquanto uma divisa é arrastada o tamanho muda a cada quadro; o ConPTY embaralha o texto se
    // for redimensionado nesse ritmo, então o ajuste espera o arrasto assentar.
    let timer = 0
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (el.clientWidth > 0 && el.clientHeight > 0) fit.fit()
      }, 70)
    })
    ro.observe(el)

    return () => {
      window.clearTimeout(timer)
      ro.disconnect()
      el.removeEventListener('contextmenu', onContext)
      el.removeEventListener('focusin', onFocusIn)
      detach()
      api.kill(id)
      term.dispose()
      termRef.current = null
    }
  }, [])

  useEffect(() => {
    if (p.focused) termRef.current?.focus()
  }, [p.focused])

  return <div className="term" ref={host} />
})
