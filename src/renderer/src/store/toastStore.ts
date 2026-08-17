import { create } from 'zustand'

interface ToastEntry {
  id: string
  message: string
  type: 'success' | 'error' | 'info'
  /** Stay until dismissed by hand — for things the user must act on, not status chatter. */
  persist?: boolean
  /** Opens in the system browser via the main process's setWindowOpenHandler. */
  action?: { label: string; href: string }
}

type ToastOptions = Pick<ToastEntry, 'persist' | 'action'>

interface ToastState {
  toasts: ToastEntry[]
  show: (message: string, type?: ToastEntry['type'], options?: ToastOptions) => void
  dismiss: (id: string) => void
}

let counter = 0

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  show: (message, type = 'info', options) =>
    set((s) => {
      // A persistent toast is keyed by its message so repeated triggers (e.g. an
      // update check on every launch) can't stack duplicates on screen.
      if (options?.persist && s.toasts.some((t) => t.persist && t.message === message)) return s
      return { toasts: [...s.toasts, { id: String(counter++), message, type, ...options }] }
    }),
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))
