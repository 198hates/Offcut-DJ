import { create } from 'zustand'

interface ToastEntry {
  id: string
  message: string
  type: 'success' | 'error' | 'info'
}

interface ToastState {
  toasts: ToastEntry[]
  show: (message: string, type?: ToastEntry['type']) => void
  dismiss: (id: string) => void
}

let counter = 0

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  show: (message, type = 'info') =>
    set((s) => ({ toasts: [...s.toasts, { id: String(counter++), message, type }] })),
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))
