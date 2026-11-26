import type { TorreApi } from '../../shared/types'

declare global {
  interface Window {
    torre: TorreApi
  }
}

export {}
