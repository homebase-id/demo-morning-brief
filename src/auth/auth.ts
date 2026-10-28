import {
  createEccPair,
  finalizeAuthentication,
  getExtendAppRegistrationParams,
  getRegistrationParams,
  hasValidToken,
  logout as logoutYouAuth,
  retrieveEccKey,
  retrieveIdentity,
  saveEccKey,
  saveIdentity,
  throwAwayTheECCKey,
} from '@homebase-id/js-lib/auth'
import { ApiType, DotYouClient } from '@homebase-id/js-lib/core'
import { base64ToUint8Array, stringifyToQueryParams } from '@homebase-id/js-lib/helpers'
import { appDefinition } from './appDefinition'

const APP_SHARED_SECRET = 'APSS'
// localStorage key AND the v1 header name.
const APP_AUTH_TOKEN = 'BX0900'

export const FINALIZE_PATH = '/auth/finalize'

export const getIdentity = (): string | undefined => retrieveIdentity() || undefined

export const getDotYouClient = (): DotYouClient => {
  const token = localStorage.getItem(APP_AUTH_TOKEN)
  const secret = localStorage.getItem(APP_SHARED_SECRET)
  return new DotYouClient({
    api: ApiType.App,
    hostIdentity: retrieveIdentity() ?? '',
    sharedSecret: secret ? base64ToUint8Array(secret) : undefined,
    // /api/apps/v1 reads BX0900; /api/v2 only reads the Bearer header.
    headers: token ? { [APP_AUTH_TOKEN]: token, Authorization: `Bearer ${token}` } : {},
  })
}

export const hasCredentials = () => !!localStorage.getItem(APP_SHARED_SECRET)

/** true / false, or null when the identity couldn't be reached. */
export const verifyToken = async (): Promise<boolean | null> =>
  hasCredentials() ? hasValidToken(getDotYouClient()) : false

/** Sends the browser to the identity's YouAuth consent screen. */
export const login = async (odinId: string) => {
  const identity = odinId.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  const eccKey = await createEccPair()
  await saveEccKey(eccKey)

  const params = await getRegistrationParams(
    `${window.location.origin}${FINALIZE_PATH}`,
    appDefinition.name,
    appDefinition.id,
    appDefinition.slug,
    appDefinition.permissionKeys,
    undefined, // circle permission keys
    appDefinition.drives,
    undefined, // circle drives
    undefined, // circles
    eccKey.publicKey,
    window.location.host,
  )

  window.location.href = `https://${identity}/api/owner/v1/youauth/authorize?${stringifyToQueryParams(params)}`
}

/** Completes the round-trip using the params YouAuth redirected back with. */
export const finalizeLogin = async (identity: string, publicKey: string, salt: string) => {
  const privateKey = await retrieveEccKey()
  if (!privateKey) throw new Error('Login key missing; start the login again.')

  const { clientAuthToken, sharedSecret } = await finalizeAuthentication(identity, privateKey, publicKey, salt)

  saveIdentity(identity)
  localStorage.setItem(APP_SHARED_SECRET, sharedSecret)
  localStorage.setItem(APP_AUTH_TOKEN, clientAuthToken)
  try {
    throwAwayTheECCKey()
  } catch {
    // already gone
  }
}

export const logout = async () => {
  try {
    await logoutYouAuth(getDotYouClient())
  } catch (e) {
    console.warn('[auth] server logout failed; clearing locally anyway', e)
  }
  localStorage.removeItem(APP_SHARED_SECRET)
  localStorage.removeItem(APP_AUTH_TOKEN)
}

/**
 * The owner console page that adds this app's current permissions (e.g. sending, added after the
 * app was first registered) to an existing registration, then returns here.
 */
export const extendPermissionsUrl = (): string => {
  const params = getExtendAppRegistrationParams(
    appDefinition.id,
    appDefinition.drives,
    undefined,
    appDefinition.permissionKeys,
    undefined,
    window.location.origin + '/',
  )
  return `https://${retrieveIdentity()}/owner/appupdate?${stringifyToQueryParams(params)}`
}
