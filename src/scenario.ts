import { GetProfileCard } from '@homebase-id/js-lib/public'
import { getDotYouClient, getIdentity, hasCredentials } from './auth/auth'
import { getRecentChatMessages, type ChatMessage } from './brief/chat'
import type { DataSource } from './config'
import lotr from './fixtures/scenario-lotr.json'

export interface Person {
  name: string
  id: string
}

export interface BriefMessage {
  id: string
  channel: 'chat'
  conversation: string
  from: Person
  /** ISO 8601 with offset. */
  sentAt: string
  text: string
}

export interface Scenario {
  me: Person
  /** YYYY-MM-DD, local. */
  today: string
  messages: BriefMessage[]
  /** Live only: short id (m1) → the real chat file, for the "source" links. Never sent to the model. */
  sources?: Record<string, { fileId: string; conversationId: string }>
}

export type ScenarioErrorKind = 'not-signed-in' | 'no-chats' | 'read-failed'

/** A failure with a message fit to show as-is. */
export class ScenarioError extends Error {
  readonly kind: ScenarioErrorKind

  constructor(kind: ScenarioErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

const DAYS = 7
const MAX_MESSAGES = 60
const NAME_TIMEOUT_MS = 3000

const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** ISO with the local offset, matching the fixture (`2026-10-25T21:14:00-05:00`). */
const localIso = (ms: number) => {
  const d = new Date(ms)
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')
  const mm = String(Math.abs(off) % 60).padStart(2, '0')
  const time = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
  return `${localDate(d)}T${time}${sign}${hh}:${mm}`
}

/** "frodo.dotyou.cloud" → "Frodo": the fallback when the profile can't be fetched in time. */
const nameFromDomain = (odinId: string) => {
  const label = odinId.split('.')[0] ?? odinId
  return label.charAt(0).toUpperCase() + label.slice(1)
}

const names = new Map<string, Promise<string>>()

/** Display name from the identity's public profile card; never fails, never takes > 3s. */
export const displayName = (odinId: string): Promise<string> => {
  let name = names.get(odinId)
  if (!name) {
    const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), NAME_TIMEOUT_MS))
    name = Promise.race([GetProfileCard(odinId).catch(() => undefined), timeout]).then(
      (card) => card?.name?.trim() || nameFromDomain(odinId),
    )
    names.set(odinId, name)
  }
  return name
}

/** The other person's name for a 1:1, the title for a group. */
const conversationName = async (m: ChatMessage, myName: string): Promise<string> => {
  const c = m.conversation
  if (c?.title) return c.title
  if (c?.others.length) return (await Promise.all(c.others.map(displayName))).join(', ')
  if (c) return `${myName} (note to self)`
  return m.sender ? displayName(m.sender) : 'Unknown conversation'
}

const status = (e: unknown) => (e as { response?: { status?: number } })?.response?.status

const liveScenario = async (): Promise<Scenario> => {
  const identity = getIdentity()
  if (!identity || !hasCredentials()) throw new ScenarioError('not-signed-in', 'You are not signed in to Homebase.')

  let chats: ChatMessage[]
  try {
    chats = await getRecentChatMessages(getDotYouClient(), identity, { days: DAYS, max: MAX_MESSAGES * 2 })
  } catch (e) {
    console.error('[scenario] chat read failed', e)
    const code = status(e)
    if (code === 401 || code === 403)
      throw new ScenarioError('not-signed-in', 'Your Homebase sign-in has expired or lacks chat access. Please sign in again.')
    throw new ScenarioError('read-failed', `Couldn't read your chats from ${identity}.`)
  }

  // Plain text only: typed kinds (polls, locations, call events) and status messages have a
  // non-zero dataType; empty text means nothing to read.
  const usable = chats.filter((m) => m.dataType === 0 && m.text.trim()).slice(0, MAX_MESSAGES)
  if (!usable.length) throw new ScenarioError('no-chats', `No chat messages in the last ${DAYS} days.`)

  const me: Person = { name: await displayName(identity), id: identity }

  // Oldest → newest, then short sequential ids the model can cite reliably.
  const ordered = [...usable].reverse()
  const sources: Scenario['sources'] = {}
  const messages = await Promise.all(
    ordered.map(async (m, i): Promise<BriefMessage> => {
      const id = `m${i + 1}`
      sources[id] = { fileId: m.id, conversationId: m.conversationId }
      return {
        id,
        channel: 'chat',
        conversation: await conversationName(m, me.name),
        from: m.sender ? { name: await displayName(m.sender), id: m.sender } : me,
        sentAt: localIso(m.sentAt),
        text: m.text,
      }
    }),
  )

  return { me, today: localDate(new Date()), messages, sources }
}

export const loadScenario = async (source: DataSource): Promise<Scenario> =>
  source === 'mock' ? (lotr as Scenario) : liveScenario()
