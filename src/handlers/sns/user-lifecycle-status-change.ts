import type { SNSEvent } from 'aws-lambda'
import { Client } from '@okta/okta-sdk-nodejs'
import OktaEvent from '../../models/okta-event.js'
import rollbar from '../../config/rollbar.js'
import GlobalRegistry from '../../models/global-registry.js'
import type { OktaUserProfile } from '../../types/okta.js'
import redactError from '../../utils/redact-error.js'

// Okta E0000007 (resource not found). Okta Workflows deactivates spam sign-ups and
// deletes them 1-4 seconds later, so the user can be gone before this runs.
const isOktaUserNotFound = (error: unknown): boolean =>
  (error as { errorCode?: string } | null)?.errorCode === 'E0000007'

export const handler = async (lambdaEvent: SNSEvent): Promise<void> => {
  const okta = new Client({ cacheMiddleware: null })
  const globalRegistry = new GlobalRegistry(
    process.env.GLOBAL_REGISTRY_TOKEN!,
    process.env.GLOBAL_REGISTRY_URL!,
    okta
  )
  try {
    const event = new OktaEvent(lambdaEvent.Records[0].Sns.Message)
    const user = await okta.userApi.getUser({ userId: event.userId! }).catch((error: unknown) => {
      if (isOktaUserNotFound(error)) return undefined
      throw error
    })
    if (!user) {
      console.log(`Okta user ${event.userId} no longer exists, nothing to sync: event=${event.eventType} actor=${event.actorId}`)
      return
    }
    switch (user.status) {
      case 'ACTIVE':
        if (await globalRegistry.createOrUpdateProfile(user.profile as OktaUserProfile)) {
          await okta.userApi.updateUser({ userId: event.userId!, user })
        }
        break
      case 'DEPROVISIONED':
        await globalRegistry.deleteProfile(user.profile as OktaUserProfile)
        break
    }
  } catch (error) {
    // Strip credentials before anything serialises this error: the rethrow below
    // reaches the Lambda runtime's log line, which the Datadog extension ships.
    await rollbar.error('status-change Error', redactError(error) as Error, { lambdaEvent })
    throw error
  }
}
