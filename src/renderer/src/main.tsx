import { createRoot } from 'react-dom/client'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-sans-condensed/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import './views.css'
import { App } from './App'

// Sem StrictMode: a montagem dupla dele abriria cada terminal duas vezes.
createRoot(document.getElementById('root')!).render(<App />)
