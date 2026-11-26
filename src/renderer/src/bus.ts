// Um só ouvinte para a saída de todos os terminais: entrega a quem está montado e
// guarda quando cada sessão falou por último, que é de onde sai o "trabalhando".

type Sink = (data: string) => void

const sinks = new Map<string, Sink>()
const lastOutput = new Map<string, number>()
const lastInput = new Map<string, number>()

/** Saída logo depois de uma tecla é eco da digitação, não trabalho. */
const ECHO_MS = 300
const ACTIVE_MS = 1500

window.torre.onData((id, data) => {
  const now = Date.now()
  if (now - (lastInput.get(id) ?? 0) > ECHO_MS) lastOutput.set(id, now)
  sinks.get(id)?.(data)
})

export const bus = {
  attach(id: string, sink: Sink): () => void {
    sinks.set(id, sink)
    return () => {
      sinks.delete(id)
      lastOutput.delete(id)
      lastInput.delete(id)
    }
  },
  input(id: string): void {
    lastInput.set(id, Date.now())
  },
  isActive(id: string, now: number, windowMs = ACTIVE_MS): boolean {
    return now - (lastOutput.get(id) ?? 0) < windowMs
  }
}
