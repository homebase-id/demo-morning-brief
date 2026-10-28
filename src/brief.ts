import { OLLAMA_MODEL, OLLAMA_URL } from './config'
import type { BriefMessage, Scenario } from './scenario'

export type Urgency = 'today' | 'soon' | 'fyi'

export interface ConflictEvent {
  person: string
  what: string
  where?: string
  time: string
  sourceIds: string[]
}

export interface Conflict {
  when: string
  summary: string
  events: ConflictEvent[]
  suggestion: string
}

export interface BriefItem {
  person: string
  urgency: Urgency
  headline: string
  needs: string
  openPromises: string[]
  howIKnow: string
  sourceIds: string[]
}

/** Step 1: conflicts and what each person needs. Replies are drafted separately, on demand. */
export interface Brief {
  conflicts: Conflict[]
  items: BriefItem[]
  skipped: string[]
}

export type AskResult<T> = { ok: true; value: T } | { ok: false; error: string; raw: string }

/** One line of progress: a new `step`, or a `detail` update to the current one. */
export type Progress = { step: string; detail?: string }
type OnProgress = (p: Progress) => void

// --- schemas ---

const str = { type: 'string' }
const strArr = { type: 'array', items: str }

const BRIEF_SCHEMA = {
  type: 'object',
  required: ['conflicts', 'items', 'skipped'],
  properties: {
    conflicts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['when', 'summary', 'events', 'suggestion'],
        properties: {
          when: str,
          summary: str,
          suggestion: str,
          events: {
            type: 'array',
            items: {
              type: 'object',
              required: ['person', 'what', 'time', 'sourceIds'],
              properties: { person: str, what: str, where: str, time: str, sourceIds: strArr },
            },
          },
        },
      },
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['person', 'urgency', 'headline', 'needs', 'openPromises', 'howIKnow', 'sourceIds'],
        properties: {
          person: str,
          urgency: { type: 'string', enum: ['today', 'soon', 'fyi'] },
          headline: str,
          needs: str,
          openPromises: strArr,
          howIKnow: str,
          sourceIds: strArr,
        },
      },
    },
    skipped: strArr,
  },
}

const DRAFT_SCHEMA = {
  type: 'object',
  required: ['draftReply'],
  properties: { draftReply: str },
}

// --- prompts ---

/** "2026-10-28" → "Wednesday, October 28, 2026", read as a local date. */
export const formatToday = (today: string) => {
  const [y, m, d] = today.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

/** Everyone other than me who sent a message: each must get exactly one item. */
export const peopleToCover = ({ me, messages }: Scenario): string[] => [
  ...new Set(messages.filter((m) => m.from.id !== me.id).map((m) => m.from.name)),
]

const analysisPrompt = (scenario: Scenario) => {
  const { me, today } = scenario
  const people = peopleToCover(scenario)
  return `You are a private morning-briefing assistant for ${me.name} (${me.id}). Today is ${formatToday(today)}. Times are local. You receive recent chat messages from several
conversations; messages sent by ${me.name} show what they agreed to and promised.
1. List every event or commitment ${me.name} agreed to (who, what, where, when); resolve
   relative days like 'Friday' against today.
2. Find CONFLICTS: commitments that overlap or are too close to attend both, considering places
   and realistic travel time. Compare across ALL conversations.
   For each conflict DECIDE which commitment ${me.name} keeps, and say so in the suggestion.
3. Find open PROMISES ${me.name} made ('I'll bring…', 'I'll send…').
4. Per person: what they need and urgency: 'today' (deadline today/overdue), 'soon' (7 days), 'fyi'.
   "items" must contain exactly one entry for EACH of these people, using these exact names:
   ${people.map((p) => JSON.stringify(p)).join(', ')}.
5. Cite the message ids each point relies on.
Never invent facts. Respond with JSON only, matching the schema.`
}

const draftPrompt = ({ me, today }: Scenario, person: string) =>
  `You write chat replies for ${me.name} (${me.id}). Today is ${formatToday(today)}. Times are local.
Write ${me.name}'s next message to ${person}: short and warm, first person, 1–3 casual sentences,
as a chat message. No greeting like "Dear", no sign-off, no signature.
- Answer what ${person} needs, and mention ${me.name}'s open promises to them where relevant.
- Follow the conflict decisions EXACTLY: if ${person}'s plan is the one kept, confirm it; if it
  is the one dropped, apologise and offer a concrete alternative. Never accept a commitment a
  decision says to drop.
- Never invent facts.
Respond with JSON only, matching the schema.`

// --- validation: hand checks of the schemas, returning the first problem found ---

const isStr = (v: unknown): v is string => typeof v === 'string'
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr)
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const checkFields = (o: unknown, path: string, strings: string[], arrays: string[] = []): string | null => {
  if (!isObj(o)) return `${path} is not an object`
  for (const k of strings) if (!isStr(o[k])) return `${path}.${k} must be a string`
  for (const k of arrays) if (!isStrArr(o[k])) return `${path}.${k} must be an array of strings`
  return null
}

export const validateBrief = (v: unknown): string | null => {
  if (!isObj(v)) return 'response is not an object'
  if (!Array.isArray(v.conflicts)) return 'conflicts must be an array'
  if (!Array.isArray(v.items)) return 'items must be an array'
  if (!isStrArr(v.skipped)) return 'skipped must be an array of strings'

  for (const [i, c] of v.conflicts.entries()) {
    const err = checkFields(c, `conflicts[${i}]`, ['when', 'summary', 'suggestion'])
    if (err) return err
    const events = (c as Record<string, unknown>).events
    if (!Array.isArray(events)) return `conflicts[${i}].events must be an array`
    for (const [j, e] of events.entries()) {
      const p = `conflicts[${i}].events[${j}]`
      const err = checkFields(e, p, ['person', 'what', 'time'], ['sourceIds'])
      if (err) return err
      const where = (e as Record<string, unknown>).where
      if (where !== undefined && !isStr(where)) return `${p}.where must be a string`
    }
  }

  for (const [i, item] of v.items.entries()) {
    const err = checkFields(
      item,
      `items[${i}]`,
      ['person', 'urgency', 'headline', 'needs', 'howIKnow'],
      ['openPromises', 'sourceIds'],
    )
    if (err) return err
    const urgency = (item as Record<string, unknown>).urgency as string
    if (!['today', 'soon', 'fyi'].includes(urgency)) return `items[${i}].urgency "${urgency}" is not today|soon|fyi`
  }
  return null
}

export const sameName = (a: string, b: string) => {
  const x = a.trim().toLowerCase()
  const y = b.trim().toLowerCase()
  return !!x && !!y && (x.includes(y) || y.includes(x))
}

/** Checks the brief against the messages: everyone covered, and only real message ids cited. */
const checkCoverage = (brief: Brief, scenario: Scenario): string | null => {
  const missing = peopleToCover(scenario).filter((p) => !brief.items.some((i) => sameName(i.person, p)))
  if (missing.length) return `"items" is missing an entry for ${missing.map((p) => JSON.stringify(p)).join(', ')}`

  const ids = new Set(scenario.messages.map((m) => m.id))
  const cited = [
    ...brief.items.flatMap((i) => i.sourceIds),
    ...brief.conflicts.flatMap((c) => c.events.flatMap((e) => e.sourceIds)),
  ]
  const unknown = [...new Set(cited.filter((id) => !ids.has(id)))]
  if (unknown.length) return `sourceIds cite messages that do not exist: ${unknown.join(', ')}`
  return null
}

// --- Ollama ---

const MAX_REPLY_TOKENS = 2000

/** -1 keeps the model in memory indefinitely, so a demo never waits on a reload. */
const KEEP_ALIVE = -1

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

/** Loads the model into memory (no prompt = load only) and pins it there. */
export const warmModel = async (): Promise<void> => {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, keep_alive: KEEP_ALIVE }),
  })
  if (!res.ok) throw new Error(`Ollama error (${res.status}): ${(await res.json().catch(() => null))?.error ?? res.statusText}`)
}

/**
 * Streams the reply so progress can be shown while the model writes. The schema-constrained
 * JSON arrives in pieces; it is only parsed once complete.
 */
const callOllama = async (
  messages: ChatMessage[],
  schema: object,
  onProgress: OnProgress,
  label: string,
): Promise<string> => {
  const request = {
    model: OLLAMA_MODEL,
    stream: true,
    think: false,
    keep_alive: KEEP_ALIVE,
    // num_predict caps a runaway reply (an uncapped repetition loop once ran 10 minutes).
    // num_ctx leaves room for the corrective retry conversation.
    options: { temperature: 0.2, num_predict: MAX_REPLY_TOKENS, num_ctx: 8192 },
    format: schema,
    messages,
  }
  console.log(`[${label}] request`, request)

  const started = performance.now()
  const seconds = () => ((performance.now() - started) / 1000).toFixed(0)
  onProgress({ step: `Waiting for ${OLLAMA_MODEL}` })

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => null)
    console.log(`[${label}] response`, res.status, body)
    throw new Error(`Ollama error (${res.status}): ${body?.error ?? res.statusText}`)
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffered = ''
  let content = ''
  let chunks = 0
  let final: unknown
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffered += value
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const chunk = JSON.parse(line)
      if (chunk.error) throw new Error(`Ollama error: ${chunk.error}`)
      content += chunk.message?.content ?? ''
      chunks++
      if (chunk.done) final = chunk
      onProgress({ step: 'Writing', detail: `${chunks} tokens · ${seconds()}s` })
    }
  }
  console.log(`[${label}] response`, { ...(final as object), message: { role: 'assistant', content } })
  return content
}

/**
 * Asks the model for schema-shaped JSON. If the reply is invalid, asks once more, telling the
 * model what was wrong; after that, gives up with the raw text.
 */
const ask = async <T>(opts: {
  label: string
  system: string
  user: string
  schema: object
  check: (parsed: unknown) => string | null
  onProgress: OnProgress
}): Promise<AskResult<T>> => {
  const messages: ChatMessage[] = [
    { role: 'system', content: opts.system },
    { role: 'user', content: opts.user },
  ]

  let raw = ''
  let problem = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    raw = await callOllama(messages, opts.schema, opts.onProgress, opts.label)
    opts.onProgress({ step: 'Checking' })

    let parsed: unknown
    let isJson = true
    try {
      parsed = JSON.parse(raw)
      problem = opts.check(parsed) ?? ''
    } catch {
      isJson = false
      problem = 'the reply was not valid JSON (or was cut off)'
    }
    if (!problem) return { ok: true, value: parsed as T }

    console.warn(`[${opts.label}] attempt ${attempt}: ${problem}`)
    if (attempt === 1) {
      opts.onProgress({ step: 'Asking again', detail: problem })
      // A fixable JSON reply goes back with the correction; garbage (a cut-off or looping reply)
      // is dropped and the question simply asked again.
      if (isJson) {
        messages.push(
          { role: 'assistant', content: raw },
          { role: 'user', content: `That reply has a problem: ${problem}. Return the complete, corrected JSON.` },
        )
      }
    }
  }
  return { ok: false, error: `Invalid reply: ${problem}`, raw }
}

// --- the two steps ---

/** Exactly what step 1 sends the model as the user message (`me` rides in the system prompt). */
export const briefInput = ({ today, messages }: Scenario) => ({ today, messages })

/** Step 1: find conflicts, needs and open promises across every conversation. */
export const analyzeChats = (scenario: Scenario, onProgress: OnProgress = () => {}) =>
  ask<Brief>({
    label: 'brief',
    system: analysisPrompt(scenario),
    user: JSON.stringify(briefInput(scenario)),
    schema: BRIEF_SCHEMA,
    check: (v) => validateBrief(v) ?? checkCoverage(v as Brief, scenario),
    onProgress,
  })

/** Every message in the conversations this person has written in. */
const conversationsWith = (scenario: Scenario, person: string): BriefMessage[] => {
  const convos = new Set(scenario.messages.filter((m) => sameName(m.from.name, person)).map((m) => m.conversation))
  return scenario.messages.filter((m) => convos.has(m.conversation))
}

/** Step 2, on demand: draft one reply, bound by the conflict decisions from step 1. */
export const draftReply = async (
  scenario: Scenario,
  brief: Brief,
  item: BriefItem,
  onProgress: OnProgress = () => {},
): Promise<AskResult<string>> => {
  const result = await ask<{ draftReply: string }>({
    label: `draft:${item.person}`,
    system: draftPrompt(scenario, item.person),
    user: JSON.stringify({
      today: scenario.today,
      person: item,
      conflictDecisions: brief.conflicts.map((c) => ({ when: c.when, summary: c.summary, decision: c.suggestion })),
      messages: conversationsWith(scenario, item.person),
    }),
    schema: DRAFT_SCHEMA,
    check: (v) => (isObj(v) && isStr(v.draftReply) && v.draftReply.trim() ? null : 'draftReply must be a non-empty string'),
    onProgress,
  })
  return result.ok ? { ok: true, value: result.value.draftReply.trim() } : result
}
