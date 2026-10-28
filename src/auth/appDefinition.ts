import type { TargetDriveAccessRequest } from '@homebase-id/js-lib/auth'
import { DrivePermissionType } from '@homebase-id/js-lib/core'
import { AppPermissionType } from '@homebase-id/js-lib/network'

// Built-in drive owned by the Chat app. Alias + type + slugs mirror
// odin-core WellKnownAppDrives / BuiltinDrives; an existing drive keeps its slug,
// but the registration request still has to state one.
const ChatDrive: TargetDriveAccessRequest = {
  alias: '9ff813aff2d61e2f9b9db189e72d1a11',
  type: '66ea8355ae4155c39b5a719166b510e3',
  name: 'Chat Drive',
  description: 'Read your chats to build the morning brief, and send the replies you approve',
  // Write: a sent reply is a new message file on this drive, as the chat app writes it.
  permissions: [DrivePermissionType.Read, DrivePermissionType.Write],
  driveSlug: 'chat',
  driveTypeSlug: 'chat',
}

export const appDefinition = {
  id: '805891e9-64c9-4bdd-ad05-54c686c1c84a',
  name: 'Morning Brief',
  /** `/apps/<slug>/` on every identity. Immutable once registered. */
  slug: 'morning-brief',
  drives: [ChatDrive],
  // What the chat app's own sends rely on: delivering the message to the other people in the
  // conversation, and the "You have a new message" notification that goes with it.
  permissionKeys: [AppPermissionType.SendDataToOtherIdentitiesOnMyBehalf, AppPermissionType.SendPushNotifications],
}
