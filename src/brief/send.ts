import {
  PriorityOptions,
  ScheduleOptions,
  SendContents,
  uploadFile,
  type DotYouClient,
  type UploadFileMetadata,
  type UploadInstructionSet,
} from '@homebase-id/js-lib/core'
import { sameName } from '../brief'
import type { Scenario } from '../scenario'
import { ChatDrive, ChatAppId, MessageFileType } from './chat'

/** chat-kmp ChatDeliveryStatus.Sent */
const DELIVERY_STATUS_SENT = 20
/** chat-kmp ChatProtocol.MessageVersionNumberOne: `message` is markdown. */
const MESSAGE_VERSION = 1

export interface ReplyTarget {
  conversationId: string
  /** Everyone in the conversation but me. */
  recipients: string[]
  /** The conversation as shown in the brief: the person, or the group's title. */
  conversationName: string
}

/** Where a reply to this person goes: the conversation of their latest message, to all its members. */
export const replyTargetFor = (scenario: Scenario, person: string): ReplyTarget | undefined => {
  const latest = [...scenario.messages].reverse().find((m) => sameName(m.from.name, person))
  const source = latest && scenario.sources?.[latest.id]
  if (!latest || !source) return undefined
  const others = scenario.conversations?.[source.conversationId]?.others ?? []
  return {
    conversationId: source.conversationId,
    recipients: others.length ? others : [latest.from.id],
    conversationName: latest.conversation,
  }
}

/** Sending needs a permission this registration doesn't have yet; the owner can grant it. */
export class SendPermissionError extends Error {}

/**
 * Sends a chat message the way chat-kmp does (ChatMessageSenderService.sendNewMessage): an
 * encrypted message file on my chat drive in the conversation, delivered to its members with the
 * chat app's "new message" notification, so it shows up in the chat apps like any other message.
 * Short text only: it rides in the header (chat-kmp moves long text to a payload).
 */
export const sendChatMessage = async (client: DotYouClient, target: ReplyTarget, text: string): Promise<void> => {
  const uniqueId = crypto.randomUUID()

  const instructions: UploadInstructionSet = {
    storageOptions: { drive: ChatDrive },
    transitOptions: {
      recipients: target.recipients,
      schedule: ScheduleOptions.SendLater,
      priority: PriorityOptions.Medium,
      sendContents: SendContents.All,
      useAppNotification: true,
      appNotificationOptions: {
        appId: ChatAppId,
        typeId: target.conversationId,
        tagId: uniqueId,
        silent: false,
        unEncryptedMessage:
          target.recipients.length > 1 ? 'You have a new message in a group chat' : 'You have a new message',
      },
    },
  }

  const metadata: UploadFileMetadata = {
    allowDistribution: true,
    isEncrypted: true,
    appData: {
      uniqueId,
      groupId: target.conversationId,
      fileType: MessageFileType,
      dataType: 0,
      userDate: Date.now(),
      content: JSON.stringify({
        message: text,
        deliveryStatus: DELIVERY_STATUS_SENT,
        isEdited: false,
        version: MESSAGE_VERSION,
      }),
    },
  }

  try {
    const result = await uploadFile(client, instructions, metadata, undefined, undefined, true)
    console.log('[send] sent', { uniqueId, target, result })
  } catch (e) {
    const status = (e as { response?: { status?: number } })?.response?.status
    console.error('[send] failed', status, e)
    if (status === 401 || status === 403)
      throw new SendPermissionError('Morning Brief isn’t allowed to send yet.', { cause: e })
    throw new Error('The message could not be sent.', { cause: e })
  }
}
