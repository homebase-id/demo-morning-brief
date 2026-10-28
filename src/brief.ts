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
  /** The person whose plan is kept; every other event in the conflict is dropped. */
  keep: string
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

/** One line of progress: a new `step`, or a `detail` update to the current one. `stream` is the
 * model's reply so far, while it is being written. */
export type Progress = { step: string; detail?: string; stream?: string }
type OnProgress = (p: Progress) => void

// --- schemas ---

const str = { type: 'string' }

/** A string the model must stop writing by `max` characters: a runaway cap, not a style rule. */
const text = (max: number) => ({ type: 'string', maxLength: max })
const list = (items: object, max: number) => ({ type: 'array', items, maxItems: max })
const ids = list({ type: 'string', maxLength: 6 }, 3)

/**
 * The analysis schema, built per scenario so it bounds the answer: one card per person, named
 * exactly, and a ceiling on every list and string. Ollama enforces this token by token, so the
 * answer cannot run long, which keeps the brief near 30s and never cut off.
 */
const briefSchema = (scenario: Scenario) => {
  const people = peopleToCover(scenario)
  // An enum needs at least one value; with nobody to cover, any name is allowed and no cards are.
  const anyone = (names: string[]) => (names.length ? { type: 'string', enum: names } : text(40))
  return {
    type: 'object',
    required: ['conflicts', 'items', 'skipped'],
    properties: {
      conflicts: list(
        {
          type: 'object',
          required: ['when', 'summary', 'events', 'suggestion', 'keep'],
          properties: {
            when: text(40),
            summary: text(160),
            suggestion: text(160),
            keep: anyone(people),
            events: list(
              {
                type: 'object',
                required: ['person', 'what', 'time', 'sourceIds'],
                properties: {
                  person: anyone([...people, scenario.me.name]),
                  what: text(70),
                  where: text(50),
                  time: text(40),
                  sourceIds: ids,
                },
              },
              2,
            ),
          },
        },
        2,
      ),
      items: {
        ...list(
          {
            type: 'object',
            required: ['person', 'urgency', 'headline', 'needs', 'openPromises', 'howIKnow', 'sourceIds'],
            properties: {
              person: anyone(people),
              urgency: { type: 'string', enum: ['today', 'soon', 'fyi'] },
              headline: text(100),
              needs: text(120),
              openPromises: list(text(80), 2),
              howIKnow: text(100),
              sourceIds: ids,
            },
          },
          people.length,
        ),
        minItems: people.length,
      },
      skipped: list(text(80), 2),
    },
  }
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
   and realistic travel time. Compare across ALL conversations. List each clash ONCE, even
   though it spans several conversations.
   For each conflict DECIDE which commitment ${me.name} keeps: set "keep" to the person whose
   plan is kept (exactly as written in that conflict's events), and explain it in the suggestion.
3. Find open PROMISES ${me.name} made ('I'll bring…', 'I'll send…').
4. Per person: what they need and urgency: 'today' (deadline today/overdue), 'soon' (7 days), 'fyi'.
   "items" must contain exactly one entry for EACH of these people, using these exact names:
   ${people.map((p) => JSON.stringify(p)).join(', ')}.
5. Cite the message ids each point relies on.
Keep every text field short: one plain sentence, under 20 words. Write compact JSON with no
indentation or line breaks.
Never invent facts. Respond with JSON only, matching the schema.`
}

const draftPrompt = ({ me, today }: Scenario, person: string, decisions: string[]) =>
  `You write chat replies for ${me.name} (${me.id}). Today is ${formatToday(today)}. Times are local.
Write ${me.name}'s next message to ${person}: short and warm, first person, 1–3 casual sentences,
as a chat message. No greeting like "Dear", no sign-off, no signature.
${decisions.length ? `${decisions.map((d) => `DECISION (must follow): ${d}`).join('\n')}\n` : ''}- Answer what ${person} needs, and mention ${me.name}'s open promises to them where relevant.
- Never invent facts.
Respond with JSON only, matching the schema.`

/**
 * What each conflict decided for this person, spelled out in plain words by code rather than left
 * for the model to infer from the suggestion text.
 */
export const decisionsFor = ({ me }: Scenario, brief: Brief, person: string): string[] =>
  brief.conflicts.flatMap((c) => {
    const theirs = c.events.filter((e) => sameName(e.person, person))
    if (!theirs.length || !c.keep) return []
    const kept = sameName(c.keep, person)
    const others = c.events.filter((e) => !sameName(e.person, person))
    const describe = (e: ConflictEvent) => `${e.what}${e.where ? ` at ${e.where}` : ''} (${e.time})`
    return theirs.map((e) =>
      kept
        ? `${me.name} IS going to ${describe(e)} with ${person}. Confirm it warmly.`
        : `${me.name} is NOT going to ${describe(e)} with ${person}, because it clashes with ${others
            .map((o) => `${describe(o)} with ${o.person}`)
            .join(' and ')}. Apologise to ${person}, say why briefly, and offer a concrete alternative time. ` +
          `Do NOT say ${me.name} will be there.`,
    )
  })

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
    const err = checkFields(c, `conflicts[${i}]`, ['when', 'summary', 'suggestion', 'keep'])
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

/**
 * Fixes what can be fixed in code rather than spending another model call on it (the demo has
 * ~30s): unknown message ids are dropped, duplicate conflicts merged, and a `keep` that names
 * nobody in its conflict is cleared, leaving that conflict undecided. A missing person is only
 * logged.
 */
const repairBrief = (brief: Brief, scenario: Scenario): Brief => {
  const ids = new Set(scenario.messages.map((m) => m.id))
  const known = (sourceIds: string[]) => sourceIds.filter((id) => ids.has(id))

  const conflicts = dedupeConflicts(brief.conflicts).map((c) => ({
    ...c,
    keep: c.events.some((e) => sameName(e.person, c.keep)) ? c.keep : '',
    events: c.events.map((e) => ({ ...e, sourceIds: known(e.sourceIds) })),
  }))
  const items = brief.items.map((i) => ({ ...i, sourceIds: known(i.sourceIds) }))

  const missing = peopleToCover(scenario).filter((p) => !items.some((i) => sameName(i.person, p)))
  if (missing.length) console.warn('[brief] no card for', missing)
  return { ...brief, conflicts, items }
}

// --- Ollama ---

const MAX_REPLY_TOKENS = 2000

/** Shared by the warm-up and every request: Ollama reloads the model when num_ctx changes. */
const CONTEXT_TOKENS = 8192

const REQUEST_OPTIONS = { temperature: 0.2, num_predict: MAX_REPLY_TOKENS, num_ctx: CONTEXT_TOKENS }

/** -1 keeps the model in memory indefinitely, so a demo never waits on a reload. */
const KEEP_ALIVE = -1

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

/** Loads the model into memory (no prompt = load only) and pins it there. */
export const warmModel = async (): Promise<void> => {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, keep_alive: KEEP_ALIVE, options: { num_ctx: CONTEXT_TOKENS } }),
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
  writingStep: string,
): Promise<string> => {
  const request = {
    model: OLLAMA_MODEL,
    stream: true,
    think: false,
    keep_alive: KEEP_ALIVE,
    // num_predict caps a runaway reply (an uncapped repetition loop once ran 10 minutes).
    // num_ctx leaves room for the corrective retry conversation.
    options: REQUEST_OPTIONS,
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
      onProgress({ step: writingStep, detail: `${chunks} tokens · ${seconds()}s`, stream: content })
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
  /** Progress label while the reply streams in. */
  writingStep: string
  /** 2 = one retry with the problem explained. */
  attempts: number
}): Promise<AskResult<T>> => {
  const messages: ChatMessage[] = [
    { role: 'system', content: opts.system },
    { role: 'user', content: opts.user },
  ]

  let raw = ''
  let problem = ''
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    raw = await callOllama(messages, opts.schema, opts.onProgress, opts.label, opts.writingStep)
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
    if (attempt < opts.attempts) {
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

/** What step 1 sends: instructions, the chats, and the answer schema. Also what the page displays. */
export const analysisRequest = (scenario: Scenario) => ({
  system: analysisPrompt(scenario),
  user: JSON.stringify(briefInput(scenario)),
  schema: briefSchema(scenario),
})

/** Step 1: find conflicts, needs and open promises across every conversation. */
export const analyzeChats = async (scenario: Scenario, onProgress: OnProgress = () => {}) => {
  const result = await ask<Brief>({
    label: 'brief',
    ...analysisRequest(scenario),
    // Only an unusable answer (broken or cut-off JSON) is worth a second call; the rest is repaired.
    check: validateBrief,
    onProgress,
    writingStep: 'Analyzing your chats',
    // One pass: the schema bounds the answer, and a second pass would double the demo's wait.
    attempts: 1,
  })
  return result.ok ? { ...result, value: repairBrief(result.value, scenario) } : result
}

/**
 * Has Ollama read the analysis input ahead of time: the same request, capped at one token. When
 * the real request comes with an identical input, Ollama reuses that reading (its prefix cache),
 * so the click goes straight to writing.
 */
export const primeAnalysis = async (scenario: Scenario): Promise<void> => {
  const { system, user, schema } = analysisRequest(scenario)
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      think: false,
      keep_alive: KEEP_ALIVE,
      options: { ...REQUEST_OPTIONS, num_predict: 1 },
      format: schema,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  })
  if (!res.ok) throw new Error(`Ollama error (${res.status})`)
}

/** Same people on both sides: the model sometimes reports one clash once from each conversation. */
const sameParticipants = (a: Conflict, b: Conflict) =>
  a.events.every((x) => b.events.some((y) => sameName(x.person, y.person))) &&
  b.events.every((y) => a.events.some((x) => sameName(x.person, y.person)))

const dedupeConflicts = (conflicts: Conflict[]): Conflict[] =>
  conflicts.filter((c, i) => !conflicts.slice(0, i).some((earlier) => sameParticipants(earlier, c)))

/** Every message in the conversations this person has written in. */
const conversationsWith = (scenario: Scenario, person: string): BriefMessage[] => {
  const convos = new Set(scenario.messages.filter((m) => sameName(m.from.name, person)).map((m) => m.conversation))
  return scenario.messages.filter((m) => convos.has(m.conversation))
}

/** What a draft sends: instructions, that person's context, and the answer schema. Also displayed. */
export const draftRequest = (scenario: Scenario, brief: Brief, item: BriefItem) => ({
  system: draftPrompt(scenario, item.person, decisionsFor(scenario, brief, item.person)),
  user: JSON.stringify({
    today: scenario.today,
    person: item,
    messages: conversationsWith(scenario, item.person),
  }),
  schema: DRAFT_SCHEMA,
})

/** Step 2, on demand: draft one reply, bound by the conflict decisions from step 1. */
export const draftReply = async (
  scenario: Scenario,
  brief: Brief,
  item: BriefItem,
  onProgress: OnProgress = () => {},
): Promise<AskResult<string>> => {
  const result = await ask<{ draftReply: string }>({
    label: `draft:${item.person}`,
    ...draftRequest(scenario, brief, item),
    check: (v) => (isObj(v) && isStr(v.draftReply) && v.draftReply.trim() ? null : 'draftReply must be a non-empty string'),
    onProgress,
    writingStep: 'Drafting reply',
    attempts: 2,
  })
  return result.ok ? { ok: true, value: result.value.draftReply.trim() } : result
}
