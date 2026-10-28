import {
  getContentFromHeaderOrPayload,
  queryBatch,
  type DotYouClient,
  type HomebaseFile,
  type TargetDrive,
} from '@homebase-id/js-lib/core'

// Chat storage format, as written by chat-kmp (homebase-chat ChatProtocol /
// MessageAppData / ConversationAppDataJson). The web chat app that used to share
// this format is retired, so chat-kmp is the reference.
const ChatDrive: TargetDrive = {
  alias: '9ff813aff2d61e2f9b9db189e72d1a11',
  type: '66ea8355ae4155c39b5a719166b510e3',
}
const MessageFileType = 7878
const ConversationFileType = 8888

/** appData.content of a message file. Long text overflows to the `dflt_key` payload. */
interface MessageContent {
  /** Markdown string when version === 1; older apps wrote a rich-text node array. */
  message?: string | RichTextNode[]
  version?: number
}

/** appData.content of a conversation file; the conversation id is appData.uniqueId. */
interface ConversationContent {
  title?: string
  recipients?: (string | null)[]
}

type RichTextNode = { text?: string; children?: RichTextNode[] }

export interface ChatMessage {
  id: string
  conversationId: string
  conversationTitle: string
  /** Undefined when the identity itself sent it. */
  sender?: string
  sentAt: number
  text: string
  /** Non-zero for typed kinds (poll, location, call event, …) and status messages. */
  dataType: number
}

const richTextToPlain = (nodes: RichTextNode[]): string =>
  nodes
    .map((n) => (n.text ?? '') + (n.children ? richTextToPlain(n.children) : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

const messageText = (content: MessageContent | null): string => {
  const m = content?.message
  if (!m) return ''
  return typeof m === 'string' ? m : richTextToPlain(m)
}

const readContent = <T>(client: DotYouClient, file: HomebaseFile) =>
  getContentFromHeaderOrPayload<T>(client, ChatDrive, file, true).catch((e) => {
    console.warn('[chat] could not read file', file.fileId, e)
    return null
  })

const activeFiles = (client: DotYouClient, fileType: number, maxRecords: number) =>
  queryBatch(
    client,
    {
      targetDrive: ChatDrive,
      fileType: [fileType],
      // 0 = none, 1 = archived; 2 is chat-kmp's soft-delete (ARCHIVAL_STATUS_DELETED).
      archivalStatus: [0, 1],
    },
    { maxRecords, includeMetadataHeader: true, ordering: 'newestFirst', sorting: 'userDate' },
  ).then((r) => r.searchResults)

const conversationTitles = async (client: DotYouClient, identity: string) => {
  const files = await activeFiles(client, ConversationFileType, 500)
  const titles = new Map<string, string>()
  await Promise.all(
    files.map(async (file) => {
      const id = file.fileMetadata.appData.uniqueId
      if (!id) return
      const c = await readContent<ConversationContent>(client, file)
      const others = (c?.recipients ?? []).filter((r): r is string => !!r && r !== identity)
      titles.set(id.replace(/-/g, ''), c?.title?.trim() || others.join(', ') || 'Note to self')
    }),
  )
  return titles
}

/** Most recent messages across every conversation, newest first. */
export const getLatestChatMessages = async (
  client: DotYouClient,
  identity: string,
  maxRecords = 50,
): Promise<ChatMessage[]> => {
  const [files, titles] = await Promise.all([
    activeFiles(client, MessageFileType, maxRecords),
    conversationTitles(client, identity),
  ])

  const messages = await Promise.all(
    files.map(async (file): Promise<ChatMessage> => {
      const { appData, senderOdinId, created } = file.fileMetadata
      const conversationId = appData.groupId ?? ''
      return {
        id: file.fileId,
        conversationId,
        conversationTitle: titles.get(conversationId.replace(/-/g, '')) ?? 'Unknown conversation',
        sender: senderOdinId && senderOdinId !== identity ? senderOdinId : undefined,
        sentAt: appData.userDate || created,
        text: messageText(await readContent<MessageContent>(client, file)),
        dataType: appData.dataType ?? 0,
      }
    }),
  )
  return messages.sort((a, b) => b.sentAt - a.sentAt)
}
