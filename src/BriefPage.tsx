import { useEffect, useRef, useState } from 'react'
import {
  analysisRequest,
  analyzeChats,
  primeAnalysis,
  briefInput,
  draftRequest,
  sameName,
  draftReply,
  warmModel,
  type AskResult,
  type Brief,
  type BriefItem,
  type Conflict,
  type Progress,
  type Urgency,
} from './brief'
import { extendPermissionsUrl, getDotYouClient } from './auth/auth'
import { replyTargetFor, sendChatMessage, SendPermissionError, type ReplyTarget } from './brief/send'
import { OLLAMA_MODEL, type DataSource } from './config'
import { loadScenario, ScenarioError, type BriefMessage, type Scenario, type ScenarioErrorKind } from './scenario'
import './BriefPage.css'

const URGENCY_ORDER: Record<Urgency, number> = { today: 0, soon: 1, fyi: 2 }

type ModelState = 'warming' | 'ready' | 'error'

type DraftState =
  { status: 'drafting'; progress?: Progress } | { status: 'done'; text: string } | { status: 'error'; error: string }

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

function ConflictBanner({
  conflict,
  messages,
  real,
}: {
  conflict: Conflict
  messages: BriefMessage[]
  real?: Scenario['sources']
}) {
  return (
    <section className="conflict" role="alert">
      <p className="conflict-summary">
        <span aria-hidden>⚠️</span> <strong>{conflict.when}:</strong> {conflict.summary}
      </p>
      <div className="conflict-events">
        {conflict.events.map((e, i) => (
          <div
            key={i}
            className={`conflict-event ${conflict.keep ? (sameName(e.person, conflict.keep) ? 'kept' : 'dropped') : ''}`}
          >
            {conflict.keep && (
              <span className="decision">{sameName(e.person, conflict.keep) ? '✓ Keep' : '✕ Drop'}</span>
            )}
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

type SendState = 'idle' | 'confirm' | 'sending' | 'sent' | 'needs-permission' | 'failed'

/**
 * The editable draft, with Copy and, in live mode, Send. Sending asks for a confirmation first:
 * it posts a real message to real people.
 */
function DraftArea({ text, person, target }: { text: string; person: string; target?: ReplyTarget }) {
  const [draft, setDraft] = useState(text)
  const [copied, setCopied] = useState(false)
  const [send, setSend] = useState<SendState>('idle')

  const copy = async () => {
    await navigator.clipboard.writeText(draft)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const confirmSend = async () => {
    if (!target) return
    setSend('sending')
    try {
      await sendChatMessage(getDotYouClient(), target, draft.trim())
      setSend('sent')
    } catch (e) {
      setSend(e instanceof SendPermissionError ? 'needs-permission' : 'failed')
    }
  }

  const to = target?.conversationName ?? person
  return (
    <>
      <label className="draft">
        <span>Draft reply</span>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={4}
          readOnly={send === 'sending' || send === 'sent'}
        />
      </label>
      <div className="draft-actions">
        <button type="button" className="secondary" onClick={copy}>
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
        {target && send === 'idle' && (
          <button type="button" className="send" onClick={() => setSend('confirm')} disabled={!draft.trim()}>
            Send to {to}
          </button>
        )}
        {send === 'confirm' && (
          <>
            <span className="send-note">Send this to {to} in Homebase Chat?</span>
            <button type="button" className="secondary" onClick={() => setSend('idle')}>
              Cancel
            </button>
            <button type="button" className="send" onClick={confirmSend}>
              Confirm send
            </button>
          </>
        )}
        {send === 'sending' && <span className="send-note">Sending…</span>}
        {send === 'sent' && <span className="send-done">✓ Sent to {to}</span>}
      </div>
      {send === 'needs-permission' && (
        <p className="brief-error">
          Morning Brief isn’t allowed to send messages yet.{' '}
          <a className="secondary" href={extendPermissionsUrl()}>
            Allow sending
          </a>{' '}
          (opens your Homebase, then comes back here; the brief will need to run again).
        </p>
      )}
      {send === 'failed' && (
        <p className="brief-error">
          The message couldn’t be sent.{' '}
          <button type="button" className="link-button" onClick={() => setSend('confirm')}>
            Try again
          </button>
        </p>
      )}
    </>
  )
}

function PersonCard({
  item,
  messages,
  real,
  draft,
  draftPrompt,
  sendTarget,
  onDraft,
  busy,
}: {
  item: BriefItem
  messages: BriefMessage[]
  real?: Scenario['sources']
  draftPrompt?: Prompt
  /** Live only: where a reply to this person would be sent. */
  sendTarget?: ReplyTarget
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

      {draft?.status === 'drafting' && <StatusLog steps={[draft.progress ?? { step: 'Drafting' }]} running />}
      {draft?.status === 'error' && <p className="brief-error">{draft.error}</p>}
      {/* key: a redraft replaces the text even if the old one was edited */}
      {draft?.status === 'done' && (
        <DraftArea key={draft.text} text={draft.text} person={item.person} target={sendTarget} />
      )}
      {draft && draftPrompt && (
        <PromptView
          prompt={draftPrompt}
          title="🔍 Prompt for this reply"
          dataLabel={`Context sent about ${item.person}`}
        />
      )}

      <div className="card-actions">
        <button type="button" className="secondary" onClick={onDraft} disabled={busy}>
          {draft?.status === 'done' ? '↻ Redraft' : '✍️ Draft reply'}
        </button>
      </div>
    </article>
  )
}

type Prompt = { system: string; user: string; schema: object }

/** The user message is sent as compact JSON; shown indented so it can be read. */
const readable = (json: string) => {
  try {
    return JSON.stringify(JSON.parse(json), null, 2)
  } catch {
    return json
  }
}

/**
 * Exactly what is sent to the model: the prompt (instructions) beside the schema that forces the
 * shape of the answer, then the data they apply to.
 */
function PromptView({
  prompt,
  title,
  dataLabel,
  open,
  onToggle,
}: {
  prompt: Prompt
  title: string
  dataLabel?: string
  /** Controlled when given; otherwise the panel opens and closes on its own. */
  open?: boolean
  onToggle?: (open: boolean) => void
}) {
  return (
    <details
      className="prompt-panel"
      open={open}
      onToggle={onToggle && ((e) => onToggle((e.currentTarget as HTMLDetailsElement).open))}
    >
      <summary>{title}</summary>
      <div className="prompt-columns">
        <div>
          <p className="prompt-label">Prompt — what we ask</p>
          <pre className="prompt-text">{prompt.system}</pre>
        </div>
        <div>
          <p className="prompt-label">Schema — the shape the answer must take</p>
          <pre>{JSON.stringify(prompt.schema, null, 2)}</pre>
        </div>
      </div>
      {dataLabel && (
        <>
          <p className="prompt-label">{dataLabel}</p>
          <pre>{readable(prompt.user)}</pre>
        </>
      )}
    </details>
  )
}

/** Avatar from the identity's public profile image; an initial if there's none (or in mock mode). */
function Avatar({ odinId, name, load }: { odinId: string; name: string; load: boolean }) {
  const [failed, setFailed] = useState(false)
  return load && !failed ? (
    <img className="person-avatar" src={`https://${odinId}/pub/image`} alt="" onError={() => setFailed(true)} />
  ) : (
    <span className="person-avatar person-initial" aria-hidden>
      {name.charAt(0).toUpperCase()}
    </span>
  )
}

/** Everyone the brief is reviewing: each identity found in the chats, with how many messages. */
function PeopleStrip({ scenario, source }: { scenario: Scenario; source: DataSource }) {
  const people = new Map<string, { name: string; count: number }>()
  for (const m of scenario.messages) {
    if (m.from.id === scenario.me.id) continue
    const p = people.get(m.from.id) ?? { name: m.from.name, count: 0 }
    p.count++
    people.set(m.from.id, p)
  }
  const mine = scenario.messages.filter((m) => m.from.id === scenario.me.id).length

  return (
    <section className="people">
      <p className="people-title">
        Reviewing chats with {people.size} {people.size === 1 ? 'person' : 'people'} · {scenario.messages.length}{' '}
        messages ({mine} from you)
      </p>
      <ul>
        {[...people].map(([id, p]) => (
          <li key={id}>
            <Avatar odinId={id} name={p.name} load={source === 'live'} />
            <span className="person-text">
              <strong>{p.name}</strong>
              <span className="person-id">{id}</span>
            </span>
            <span className="person-count">{p.count}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Message ids the model has cited so far, e.g. `"m3"`, in the order first seen. */
const citedIds = (stream: string) => [...new Set([...stream.matchAll(/"(m\d+)"/g)].map((m) => m[1]))]

/**
 * While the model works: the chats on one side, lighting up as the model cites them, and its
 * answer streaming in on the other.
 */
function LiveView({ scenario, stream }: { scenario: Scenario; stream: string }) {
  const cited = citedIds(stream)
  const bubbles = useRef<HTMLDivElement>(null)
  const output = useRef<HTMLPreElement>(null)
  const latest = cited.at(-1)

  useEffect(() => {
    if (output.current) output.current.scrollTop = output.current.scrollHeight
  }, [stream])

  useEffect(() => {
    if (!latest || !bubbles.current) return
    const el = bubbles.current.querySelector<HTMLElement>(`[data-id="${latest}"]`)
    if (el) bubbles.current.scrollTo({ top: el.offsetTop - 40, behavior: 'smooth' })
  }, [latest])

  return (
    <section className="live">
      <div className="live-chats" ref={bubbles}>
        {scenario.messages.map((m) => (
          <div
            key={m.id}
            data-id={m.id}
            className={[
              'bubble',
              m.from.id === scenario.me.id ? 'mine' : 'theirs',
              cited.includes(m.id) ? 'cited' : '',
              m.id === latest ? 'latest' : '',
            ].join(' ')}
          >
            <span className="bubble-meta">
              {m.id} · {m.from.id === scenario.me.id ? `You → ${m.conversation}` : m.from.name}
            </span>
            {m.text}
          </div>
        ))}
      </div>
      <pre className="live-output" ref={output}>
        {stream || 'Waiting for the first words…'}
      </pre>
    </section>
  )
}

/** Shown before the first run: what clicking the button will do. */
function Intro({ source }: { source: DataSource }) {
  return (
    <section className="intro">
      <h2>Your morning brief</h2>
      <p>
        {source === 'live'
          ? 'Reads your Homebase chats from the last 7 days, including what you said, and finds what needs your attention.'
          : 'Uses a sample Lord of the Rings scenario: Frodo’s chats with Gandalf and Sam. No sign-in needed.'}
      </p>
      <ol>
        <li>
          <strong>Find conflicts</strong> — plans you agreed to that clash, across every conversation, with a suggestion
          for which to keep.
        </li>
        <li>
          <strong>See who needs what</strong> — one card per person, most urgent first, with the promises you made them
          and the messages it’s based on.
        </li>
        <li>
          <strong>Draft replies</strong> — on request, one warm reply per person that follows the conflict decision.
          Edit and copy.
        </li>
      </ol>
      <p className="intro-note">
        🔒 Runs on this computer with {OLLAMA_MODEL}. Your messages never leave it. The first analysis takes about 20–30
        seconds.
      </p>
    </section>
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
  const [error, setError] = useState<{
    kind: ScenarioErrorKind | 'other'
    message: string
  }>()
  const [drafts, setDrafts] = useState<Record<string, DraftState>>({})
  const [drafting, setDrafting] = useState(false)
  const [preloadFailed, setPreloadFailed] = useState(false)
  const [stream, setStream] = useState('')
  const [promptOpen, setPromptOpen] = useState(false)

  // Load the model as soon as the page opens, so the first click doesn't wait on it.
  useEffect(() => {
    warmModel()
      .then(() => setModel('ready'))
      .catch((e) => {
        console.error(e)
        setModel('error')
      })
  }, [])

  // Read the chats up front too, so the prompt can be shown before anything is clicked. A failure
  // here stays quiet; clicking reads them again and reports any error properly.
  useEffect(() => {
    let current = true
    loadScenario(source)
      .then((s) => {
        if (!current) return
        setScenario((prev) => prev ?? s)
        // Let the model read the chats now, while the presenter talks, rather than after the click.
        const started = performance.now()
        primeAnalysis(s)
          .then(() => console.log(`[brief] chats pre-read in ${((performance.now() - started) / 1000).toFixed(1)}s`))
          .catch((e) => console.warn('[brief] could not pre-read chats', e))
      })
      .catch((e) => {
        console.warn('[brief] could not preload chats', e)
        if (current) setPreloadFailed(true)
      })
    return () => {
      current = false
    }
  }, [source])

  // A repeated step updates the current line's detail; a new step starts a new line.
  // The streamed reply goes to the live view, not into the step list.
  const onProgress = ({ stream: text, ...p }: Progress) => {
    if (text !== undefined) setStream(text)
    setSteps((prev) => (prev.at(-1)?.step === p.step ? [...prev.slice(0, -1), p] : [...prev, p]))
  }

  const findConflicts = async () => {
    const started = performance.now()
    setPromptOpen(false)
    setStream('')
    setLoading(true)
    setSteps([])
    setResult(undefined)
    setDrafts({})
    setError(undefined)
    try {
      onProgress({ step: 'Reading your chats' })
      const s = await loadScenario(source)
      console.log('[brief] input', {
        me: s.me,
        count: s.messages.length,
        ...briefInput(s),
      })
      const conversations = new Set(s.messages.map((m) => m.conversation)).size
      onProgress({
        step: 'Reading your chats',
        detail: `${s.messages.length} messages from ${conversations} conversations`,
      })
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
          : {
              kind: 'other',
              message: e instanceof Error ? e.message : String(e),
            },
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
      set({
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      })
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
  const items = brief ? [...brief.items].sort((a, b) => URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency]) : []

  return (
    <main className="brief">
      <ModelChip state={model} />

      {steps.length === 0 && !result && !error && <Intro source={source} />}
      {steps.length === 0 && !scenario && !preloadFailed && (
        <p className="prompt-pending">Reading your chats to prepare the prompt…</p>
      )}
      {scenario && <PeopleStrip scenario={scenario} source={source} />}
      {scenario && (
        <PromptView
          prompt={analysisRequest(scenario)}
          title="🔍 What we're asking the model"
          // Before the first run this is narration: the instructions only, not the chats.
          dataLabel={steps.length ? `Your chats, sent with it (${scenario.messages.length} messages)` : undefined}
          open={promptOpen}
          onToggle={setPromptOpen}
        />
      )}

      <button type="button" className="generate" onClick={findConflicts} disabled={loading || drafting}>
        {brief ? 'Start over' : 'Find conflicts'}
      </button>

      {steps.length > 0 && <StatusLog steps={steps} running={loading} />}
      {loading && scenario && <LiveView scenario={scenario} stream={stream} />}
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
            <button type="button" className="generate" onClick={() => runDrafts(brief, items)} disabled={drafting}>
              ✍️ Draft all replies
            </button>
          )}

          <div className="cards">
            {items.map((item, i) => (
              <PersonCard
                key={`${item.person}-${i}`}
                item={item}
                messages={messages}
                real={scenario?.sources}
                draft={drafts[item.person]}
                draftPrompt={scenario ? draftRequest(scenario, brief, item) : undefined}
              sendTarget={source === 'live' && scenario ? replyTargetFor(scenario, item.person) : undefined}
                onDraft={() => runDrafts(brief, [item])}
                busy={drafting}
              />
            ))}
          </div>
          {brief.skipped.length > 0 && <p className="skipped">Skipped: {brief.skipped.join(' · ')}</p>}
        </>
      )}
    </main>
  )
}
