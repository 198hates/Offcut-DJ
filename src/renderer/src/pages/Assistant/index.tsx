/**
 * Assistant — a conversational agent over your own library.
 *
 * The agent reasons in the main process with tools (search the library,
 * read an overview, create a playlist). This page streams its transcript and
 * lets you ask for things in plain language:
 *   "build a 90-minute warm-up set from my unplayed deep house and save it"
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLibraryStore } from '../../store/libraryStore'
import { useAiStatus } from '../../hooks/useAiStatus'
import type { AiAgentEvent } from '@shared/types'

type Entry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; text: string; ok?: boolean; pending?: boolean }
  | { kind: 'error'; text: string }

const SUGGESTIONS = [
  'Build a 90-minute warm-up set from my unplayed deep house and save it',
  'Find peak-time tracks around 128 BPM in 8A or 9A',
  'What are the most common genres in my library?',
  'Make a harmonic journey starting calm and building to high energy'
]

export function AssistantPage(): JSX.Element {
  const aiEnabled = useAiStatus()
  const loadLibrary = useLibraryStore((s) => s.loadLibrary)

  const [entries, setEntries] = useState<Entry[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)

  // Plain-text conversation history for context across turns.
  const historyRef = useRef<{ role: 'user' | 'assistant'; content: string }[]>([])
  const runIdRef = useRef(0)
  const assistantBufRef = useRef('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const off = window.api.ai.onAgentEvent((evt: AiAgentEvent) => {
      if (evt.runId !== runIdRef.current) return
      switch (evt.type) {
        case 'text':
          assistantBufRef.current += (assistantBufRef.current ? '\n\n' : '') + evt.text
          setEntries((e) => [...e, { kind: 'assistant', text: evt.text }])
          break
        case 'tool':
          setEntries((e) => [...e, { kind: 'tool', text: evt.summary, pending: true }])
          break
        case 'tool_result':
          // Resolve the most recent pending tool note for this tool.
          setEntries((e) => {
            const copy = [...e]
            for (let i = copy.length - 1; i >= 0; i--) {
              const x = copy[i]
              if (x.kind === 'tool' && x.pending) { copy[i] = { kind: 'tool', text: evt.summary, ok: evt.ok }; break }
            }
            return copy
          })
          break
        case 'library_changed':
          void loadLibrary()
          break
        case 'done':
          if (assistantBufRef.current.trim())
            historyRef.current.push({ role: 'assistant', content: assistantBufRef.current })
          assistantBufRef.current = ''
          setBusy(false)
          break
        case 'error':
          setEntries((e) => [...e, { kind: 'error', text: evt.message }])
          setBusy(false)
          break
      }
    })
    return off
  }, [loadLibrary])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [entries])

  const send = useCallback(
    (text: string) => {
      const q = text.trim()
      if (!q || busy) return
      const runId = runIdRef.current + 1
      runIdRef.current = runId
      assistantBufRef.current = ''
      setEntries((e) => [...e, { kind: 'user', text: q }])
      setInput('')
      setBusy(true)
      const history = [...historyRef.current]
      historyRef.current.push({ role: 'user', content: q })
      window.api.ai.agentRun(q, history, runId).catch((err) => {
        setEntries((e) => [...e, { kind: 'error', text: (err as Error).message }])
        setBusy(false)
      })
    },
    [busy]
  )

  const reset = useCallback(() => {
    runIdRef.current += 1 // orphan any in-flight run's events
    historyRef.current = []
    assistantBufRef.current = ''
    setEntries([])
    setBusy(false)
  }, [])

  if (!aiEnabled) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-6">
        <p className="font-mono text-[13px] font-bold uppercase tracking-[0.15em] text-ink">✦ assistant</p>
        <p className="font-mono text-[13px] text-muted max-w-md">
          Turn on AI in <span className="text-accent">Settings → AI</span> (enable it and add your
          Anthropic API key) to chat with an assistant that can search your library and build playlists.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-chassis">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b border-border/30 bg-chassis-soft">
        <span className="font-mono text-[12px] font-bold uppercase tracking-[0.18em] text-accent">✦ Assistant</span>
        {entries.length > 0 && (
          <button onClick={reset} disabled={busy}
            className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted hover:text-accent transition-colors disabled:opacity-40">
            new chat
          </button>
        )}
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {entries.length === 0 ? (
          <div className="max-w-xl mx-auto pt-10 space-y-4">
            <p className="font-mono text-[13px] text-muted text-center">
              Ask me to explore your library or assemble a set. I can search by BPM, key, energy, mood and
              genre, and save the result as a playlist.
            </p>
            <div className="space-y-1.5">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)}
                  className="w-full text-left font-mono text-[12px] text-ink/80 bg-ink/[0.03] hover:bg-ink/[0.06] border border-border/30 hover:border-accent/40 rounded px-3 py-2 transition-colors">
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          entries.map((e, i) => <EntryRow key={i} entry={e} />)
        )}
        {busy && (
          <div className="flex items-center gap-2 font-mono text-[12px] text-muted">
            <span className="cd-spinner inline-block w-3 h-3 rounded-full border border-accent/40 border-t-accent animate-spin" />
            thinking…
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-border/30 bg-chassis-soft px-4 py-3">
        <div className="flex items-end gap-2 max-w-3xl mx-auto">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input) }
            }}
            rows={1}
            placeholder="Ask the assistant…  (Enter to send, Shift+Enter for a new line)"
            className="flex-1 resize-none bg-paper border border-border/40 rounded px-3 py-2 font-mono text-[13px] text-ink outline-none focus:border-accent transition-colors placeholder-muted/50 max-h-32"
          />
          <button onClick={() => send(input)} disabled={busy || !input.trim()}
            className="shrink-0 font-mono text-[12px] uppercase tracking-[0.1em] bg-accent hover:bg-accent/90 text-paper rounded px-4 py-2 transition-colors disabled:opacity-40">
            send
          </button>
        </div>
      </div>
    </div>
  )
}

function EntryRow({ entry }: { entry: Entry }): JSX.Element {
  if (entry.kind === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] font-mono text-[13px] text-ink bg-accent/10 border border-accent/25 rounded-lg px-3 py-2 whitespace-pre-wrap">
          {entry.text}
        </div>
      </div>
    )
  }
  if (entry.kind === 'assistant') {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] font-mono text-[13px] text-ink/90 bg-ink/[0.03] border border-border/30 rounded-lg px-3 py-2 whitespace-pre-wrap leading-relaxed">
          {entry.text}
        </div>
      </div>
    )
  }
  if (entry.kind === 'error') {
    return (
      <div className="font-mono text-[12px] text-red-400/90 pl-1">⚠ {entry.text}</div>
    )
  }
  // tool
  return (
    <div className="flex items-center gap-2 pl-1 font-mono text-[11px] text-muted">
      <span className={entry.pending ? 'text-accent' : entry.ok === false ? 'text-red-400' : 'text-green-500/80'}>
        {entry.pending ? '◌' : entry.ok === false ? '✕' : '✓'}
      </span>
      <span className="uppercase tracking-[0.08em]">{entry.text}</span>
    </div>
  )
}
