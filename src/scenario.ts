import { getDotYouClient, getIdentity } from './auth/auth'
import { getLatestChatMessages } from './brief/chat'
import { MOCK_MODE } from './config'
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
}

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

const liveScenario = async (): Promise<Scenario> => {
  const identity = getIdentity() ?? ''
  const me: Person = { name: identity, id: identity }
  const chats = await getLatestChatMessages(getDotYouClient(), identity)

  // Oldest first, like the fixture; short ids so the model can cite them reliably.
  const messages = chats
    .filter((m) => m.text.trim())
    .reverse()
    .map((m, i): BriefMessage => ({
      id: `c${i + 1}`,
      channel: 'chat',
      conversation: m.conversationTitle,
      from: m.sender ? { name: m.sender, id: m.sender } : me,
      sentAt: localIso(m.sentAt),
      text: m.text,
    }))

  return { me, today: localDate(new Date()), messages }
}

export const loadScenario = async (): Promise<Scenario> =>
  MOCK_MODE ? (lotr as Scenario) : liveScenario()
