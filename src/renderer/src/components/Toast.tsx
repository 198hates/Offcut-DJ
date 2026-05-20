import { useEffect } from 'react'
import { useToastStore } from '../store/toastStore'

export function Toast(): JSX.Element {
  const { toasts, dismiss } = useToastStore()
  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <ToastItem key={t.id} {...t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  )
}

interface ToastItemProps {
  id: string; message: string; type: 'success' | 'error' | 'info'; onDismiss: () => void
}

function ToastItem({ message, type, onDismiss }: ToastItemProps): JSX.Element {
  useEffect(() => {
    const t = setTimeout(onDismiss, type === 'error' ? 6000 : 3500)
    return () => clearTimeout(t)
  }, [type, onDismiss])

  const style = {
    success: 'bg-paper border-border/50 text-ink',
    error:   'bg-paper border-red-500/40 text-ink',
    info:    'bg-paper border-border/50 text-ink'
  }[type]

  const dot = {
    success: 'bg-green-500',
    error:   'bg-red-500',
    info:    'bg-accent'
  }[type]

  return (
    <div className={`pointer-events-auto flex items-start gap-3 px-4 py-3 rounded border shadow-lg max-w-xs ${style}`}
         style={{ boxShadow: '0 4px 20px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.08)' }}>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1 ${dot}`} />
      <span className="font-mono text-[10.5px] leading-snug flex-1">{message}</span>
      <button onClick={onDismiss} className="shrink-0 text-muted hover:text-ink transition-colors text-sm leading-none ml-1">×</button>
    </div>
  )
}
