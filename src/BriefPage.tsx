import { useEffect, useState } from 'react'
import {
  analyzeChats,
  briefInput,
  formatToday,
  draftReply,
  warmModel,
  type AskResult,
  type Brief,
  type BriefItem,
  type Conflict,
  type Progress,
  type Urgency,
} from './brief'
import { OLLAMA_MODEL, type DataSource } from './config'
import { loadScenario, ScenarioError, type BriefMessage, type Scenario, type ScenarioErrorKind } from './scenario'
import './BriefPage.css'

const URGENCY_ORDER: Record<Urgency, number> = { today: 0, soon: 1, fyi: 2 }

type ModelState = 'warming' | 'ready' | 'error'

type DraftState =
  | { status: 'drafting'; progress?: Progress }
  | { status: 'done'; text: string }
  | { status: 'error'; error: string }

function ModelChip({ state }: { state: ModelState }) {
  const label = { warming: 'loading…', ready: 'ready', error: 'not reachable' }[state]
  return (
    <p className={`model-chip model-${state}`}>
      <span className="dot" aria-hidden /> {OLLAMA_MODEL} {label}
    </p>
  )
}

function StatusLog({ steps, running }: { steps: Progress[]; running: boolean }) {
  return (
    <ol className="status-log">
      {steps.map((s, i) => {
        const active = running && i === steps.length - 1
        return (
          <li key={i} className={active ? 'active' : 'done'}>
            {active ? <span className="spinner" aria-hidden /> : <span aria-hidden>✓</span>}
            <span>
              {s.step}
              {s.detail && <span className="status-detail"> — {s.detail}</span>}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function Sources({ ids, messages, real }: { ids: string[]; messages: BriefMessage[]; real?: Scenario['sources'] }) {
  if (!ids.length) return null
  return (
    <details className="sources">
      <summary>source</summary>
      {ids.map((id) => {
        const m = messages.find((msg) => msg.id === id)
        return m ? (
          <blockquote key={id} title={real?.[id] ? `chat file ${real[id].fileId}` : undefined}>
            <span className="source-meta">
              {id} · {m.from.name} · {m.conversation} · {new Date(m.sentAt).toLocaleString()}
            </span>
            {m.text}
          </blockquote>
        ) : (
          <blockquote key={id} className="source-missing">
            No message with id “{id}”
          </blockquote>
        )
      })}
    </details>
  )
}

function ConflictBanner({ conflict, messages, real }: { conflict: Conflict; messages: BriefMessage[]; real?: Scenario['sources'] }) {
  return (
    <section className="conflict" role="alert">
      <p className="conflict-summary">
        <span aria-hidden>⚠️</span> <strong>{conflict.when}:</strong> {conflict.summary}
      </p>
      <div className="conflict-events">
        {conflict.events.map((e, i) => (
          <div key={i} className="conflict-event">
            <strong>{e.person}</strong>
            <span>{e.what}</span>
            {e.where && <span>📍 {e.where}</span>}
            <span>🕕 {e.time}</span>
            <Sources ids={e.sourceIds} messages={messages} real={real} />
          </div>
        ))}
      </div>
      <p className="conflict-suggestion">
        <strong>Suggestion:</strong> {conflict.suggestion}
      </p>
    </section>
  )
}

function DraftArea({ text }: { text: string }) {
  const [draft, setDraft] = useState(text)
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    await navigator.clipboard.writeText(draft)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <>
      <label className="draft">
        <span>Draft reply</span>
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} />
      </label>
      <button type="button" className="secondary" onClick={copy}>
        {copied ? 'Copied ✓' : 'Copy'}
      </button>
    </>
  )
}

function PersonCard({
  item,
  messages,
  real,
  draft,
  onDraft,
  busy,
}: {
  item: BriefItem
  messages: BriefMessage[]
  real?: Scenario['sources']
  draft?: DraftState
  onDraft: () => void
  busy: boolean
}) {
  return (
    <article className="person-card">
      <header>
        <h3>{item.person}</h3>
        <span className={`pill pill-${item.urgency}`}>{item.urgency}</span>
      </header>
      <p className="headline">{item.headline}</p>
      <p>
        <strong>Needs:</strong> {item.needs}
      </p>
      {item.openPromises.length > 0 && (
        <div>
          <strong>Open promises:</strong>
          <ul className="promises">
            {item.openPromises.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="how">
        <strong>How I know:</strong> {item.howIKnow}
      </p>
      <Sources ids={item.sourceIds} messages={messages} real={real} />

      {draft?.status === 'drafting' && (
        <StatusLog steps={[draft.progress ?? { step: 'Drafting' }]} running />
      )}
      {draft?.status === 'error' && <p className="brief-error">{draft.error}</p>}
      {/* key: a redraft replaces the text even if the old one was edited */}
      {draft?.status === 'done' && <DraftArea key={draft.text} text={draft.text} />}

      <div className="card-actions">
        <button type="button" className="secondary" onClick={onDraft} disabled={busy}>
          {draft?.status === 'done' ? '↻ Redraft' : '✍️ Draft reply'}
        </button>
      </div>
    </article>
  )
}

function InputPanel({ scenario }: { scenario: Scenario }) {
  return (
    <details className="input-panel">
      <summary>
        Input — {scenario.messages.length} messages · {scenario.me.name} ({scenario.me.id}) · {scenario.today}
      </summary>
      <p>
        <strong>me:</strong> {scenario.me.name} ({scenario.me.id}) · <strong>today:</strong> {scenario.today} (
        {formatToday(scenario.today)}) · <strong>messages:</strong> {scenario.messages.length}
      </p>
      <p className="input-note">Sent to the model exactly as below:</p>
      <pre>{JSON.stringify(briefInput(scenario), null, 2)}</pre>
    </details>
  )
}

export function BriefPage({
  source,
  onSwitchToMock,
  onNeedSignIn,
}: {
  source: DataSource
  onSwitchToMock?: () => void
  onNeedSignIn?: () => void
}) {
  const [model, setModel] = useState<ModelState>('warming')
  const [loading, setLoading] = useState(false)
  const [steps, setSteps] = useState<Progress[]>([])
  const [scenario, setScenario] = useState<Scenario>()
  const [result, setResult] = useState<AskResult<Brief>>()
  const [error, setError] = useState<{ kind: ScenarioErrorKind | 'other'; message: string }>()
  const [drafts, setDrafts] = useState<Record<string, DraftState>>({})
  const [drafting, setDrafting] = useState(false)

  // Load the model as soon as the page opens, so the first click doesn't wait on it.
  useEffect(() => {
    warmModel()
      .then(() => setModel('ready'))
      .catch((e) => {
        console.error(e)
        setModel('error')
      })
  }, [])

  // A repeated step updates the current line's detail; a new step starts a new line.
  const onProgress = (p: Progress) =>
    setSteps((prev) => (prev.at(-1)?.step === p.step ? [...prev.slice(0, -1), p] : [...prev, p]))

  const findConflicts = async () => {
    const started = performance.now()
    setLoading(true)
    setSteps([])
    setResult(undefined)
    setDrafts({})
    setError(undefined)
    try {
      onProgress({ step: 'Reading your chats' })
      const s = await loadScenario(source)
      console.log('[brief] input', { me: s.me, count: s.messages.length, ...briefInput(s) })
      const conversations = new Set(s.messages.map((m) => m.conversation)).size
      onProgress({ step: 'Reading your chats', detail: `${s.messages.length} messages from ${conversations} conversations` })
      setScenario(s)
      onProgress({ step: 'Looking for conflicts and open promises' })
      const r = await analyzeChats(s, onProgress)
      const secs = ((performance.now() - started) / 1000).toFixed(0)
      onProgress(r.ok ? { step: 'Done', detail: `${secs}s` } : { step: 'Gave up', detail: r.error })
      setResult(r)
    } catch (e) {
      console.error(e)
      setError(
        e instanceof ScenarioError
          ? { kind: e.kind, message: e.message }
          : { kind: 'other', message: e instanceof Error ? e.message : String(e) },
      )
      onProgress({ step: 'Stopped' })
    } finally {
      setLoading(false)
    }
  }

  const draftFor = async (brief: Brief, item: BriefItem) => {
    if (!scenario) return
    const set = (d: DraftState) => setDrafts((prev) => ({ ...prev, [item.person]: d }))
    set({ status: 'drafting' })
    try {
      const r = await draftReply(scenario, brief, item, (progress) => set({ status: 'drafting', progress }))
      set(r.ok ? { status: 'done', text: r.value } : { status: 'error', error: r.error })
    } catch (e) {
      console.error(e)
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) })
    }
  }

  // One at a time: the model handles one request at a time anyway, and the cards fill in order.
  const runDrafts = async (brief: Brief, items: BriefItem[]) => {
    setDrafting(true)
    try {
      for (const item of items) await draftFor(brief, item)
    } finally {
      setDrafting(false)
    }
  }

  const messages = scenario?.messages ?? []
  const brief = result?.ok ? result.value : undefined
  const items = brief
    ? [...brief.items].sort((a, b) => URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency])
    : []

  return (
    <main className="brief">
      <ModelChip state={model} />
      <button type="button" className="generate" onClick={findConflicts} disabled={loading || drafting}>
        {brief ? 'Start over' : 'Find conflicts'}
      </button>

      {steps.length > 0 && <StatusLog steps={steps} running={loading} />}
      {error && (
        <section className="brief-error">
          <p>{error.message}</p>
          {error.kind === 'not-signed-in' && onNeedSignIn && (
            <button type="button" className="secondary" onClick={onNeedSignIn}>
              Sign in
            </button>
          )}
          {(error.kind === 'read-failed' || error.kind === 'other') && source === 'live' && onSwitchToMock && (
            <button type="button" className="secondary" onClick={onSwitchToMock}>
              Switch to mock data
            </button>
          )}
        </section>
      )}

      {result && !result.ok && (
        <section className="brief-error">
          <p>{result.error}. Here's what the model said:</p>
          <pre>{result.raw}</pre>
        </section>
      )}

      {brief && (
        <>
          {brief.conflicts.length === 0 && <p className="no-conflicts">✅ No conflicts found.</p>}
          {brief.conflicts.map((c, i) => (
            <ConflictBanner key={i} conflict={c} messages={messages} real={scenario?.sources} />
          ))}

          {items.length > 0 && (
            <button
              type="button"
              className="generate"
              onClick={() => runDrafts(brief, items)}
              disabled={drafting}
            >
              ✍️ Draft all replies
            </button>
          )}

          {items.map((item, i) => (
            <PersonCard
              key={`${item.person}-${i}`}
              item={item}
              messages={messages}
              real={scenario?.sources}
              draft={drafts[item.person]}
              onDraft={() => runDrafts(brief, [item])}
              busy={drafting}
            />
          ))}
          {brief.skipped.length > 0 && <p className="skipped">Skipped: {brief.skipped.join(' · ')}</p>}
        </>
      )}

      {scenario && <InputPanel scenario={scenario} />}
    </main>
  )
}
