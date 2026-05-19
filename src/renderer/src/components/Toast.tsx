import { useEffect } from 'react'
import { useToastStore } from '../store/toastStore'

export function Toast(): JSX.Element {
  const { toasts, dismiss } = useToastStore()

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <ToastItem key={t.id} {...t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  )
}

interface ToastItemProps {
  id: string
  message: string
  type: 'success' | 'error' | 'info'
  onDismiss: () => void
}

function ToastItem({ message, type, onDismiss }: ToastItemProps): JSX.Element {
  useEffect(() => {
    const timer = setTimeout(onDismiss, type === 'error' ? 6000 : 3500)
    return () => clearTimeout(timer)
  }, [type, onDismiss])

  const colors = {
    success: 'bg-green-900/80 border-green-600/40 text-green-300',
    error: 'bg-red-900/80 border-red-600/40 text-red-300',
    info: 'bg-surface-800/90 border-white/10 text-white/80'
  }

  const icons = { success: '✓', error: '✕', info: 'ℹ' }

  return (
    <div
      className={`pointer-events-auto flex items-start gap-2.5 px-4 py-3 rounded-lg border backdrop-blur-sm text-sm max-w-xs shadow-xl ${colors[type]}`}
    >
      <span className="shrink-0 font-bold">{icons[type]}</span>
      <span className="leading-snug">{message}</span>
      <button onClick={onDismiss} className="shrink-0 opacity-50 hover:opacity-100 ml-auto pl-2">×</button>
    </div>
  )
}
