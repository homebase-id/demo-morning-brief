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

export interface ChatConversation {
  /** Explicit title (group chats); empty for a 1:1. */
  title: string
  /** Every recipient other than me. */
  others: string[]
}

export interface ChatMessage {
  id: string
  conversationId: string
  /** Undefined when the conversation file couldn't be found or read. */
  conversation?: ChatConversation
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

const activeFiles = (client: DotYouClient, fileType: number, maxRecords: number, uniqueIds?: string[]) =>
  queryBatch(
    client,
    {
      targetDrive: ChatDrive,
      fileType: [fileType],
      // Active files only (odin-core FileState: 0 = deleted, 1 = active). chat-kmp deletes a
      // message by soft-deleting the file, and the tombstone keeps its old text in the header,
      // so without this filter deleted messages come back.
      fileState: [1],
      // 0 = none, 1 = archived; 2 is chat-kmp's soft-delete (ARCHIVAL_STATUS_DELETED).
      archivalStatus: [0, 1],
      clientUniqueIdAtLeastOne: uniqueIds,
    },
    { maxRecords, includeMetadataHeader: true, ordering: 'newestFirst', sorting: 'userDate' },
    // js-lib sends short queries as GETs; a changing param means the browser can never answer
    // from its cache with chats as they were before an edit.
    { axiosConfig: { params: { fresh: Date.now() } } },
  ).then((r) =>
    // Drop only what's explicitly deleted, so a state sent as a number can't empty the list.
    r.searchResults.filter((f): f is HomebaseFile => !['deleted', 0].includes(f.fileState as string | number)),
  )

const normalizeId = (id: string) => id.replace(/-/g, '').toLowerCase()

/** The conversation files for these conversation ids (a conversation's uniqueId is its id). */
const readConversations = async (client: DotYouClient, identity: string, ids: string[]) => {
  const conversations = new Map<string, ChatConversation>()
  if (!ids.length) return conversations
  const files = await activeFiles(client, ConversationFileType, ids.length, ids)
  await Promise.all(
    files.map(async (file) => {
      const id = file.fileMetadata.appData.uniqueId
      if (!id) return
      const c = await readContent<ConversationContent>(client, file)
      conversations.set(normalizeId(id), {
        title: c?.title?.trim() ?? '',
        others: (c?.recipients ?? []).filter((r): r is string => !!r && r !== identity),
      })
    }),
  )
  return conversations
}

/** Messages from the last `days` days across every conversation, newest first, at most `max`. */
export const getRecentChatMessages = async (
  client: DotYouClient,
  identity: string,
  { days = 7, max = 60 } = {},
): Promise<ChatMessage[]> => {
  const since = Date.now() - days * 24 * 60 * 60 * 1000
  // Newest first, so the first `max` recent ones are all here; older ones are dropped below.
  const files = (await activeFiles(client, MessageFileType, max * 2)).filter(
    (f) => (f.fileMetadata.appData.userDate || f.fileMetadata.created) >= since,
  )

  const conversationIds = [...new Set(files.map((f) => f.fileMetadata.appData.groupId).filter((g): g is string => !!g))]
  const conversations = await readConversations(client, identity, conversationIds)

  const messages = await Promise.all(
    files.map(async (file): Promise<ChatMessage> => {
      const { appData, senderOdinId, created } = file.fileMetadata
      const conversationId = appData.groupId ?? ''
      return {
        id: file.fileId,
        conversationId,
        conversation: conversations.get(normalizeId(conversationId)),
        sender: senderOdinId && senderOdinId !== identity ? senderOdinId : undefined,
        sentAt: appData.userDate || created,
        text: messageText(await readContent<MessageContent>(client, file)),
        dataType: appData.dataType ?? 0,
      }
    }),
  )
  return messages.sort((a, b) => b.sentAt - a.sentAt)
}
