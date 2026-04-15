import type { SNSEvent } from 'aws-lambda'
import { Client } from '@okta/okta-sdk-nodejs'
import OktaEvent from '../../models/okta-event.js'
import rollbar from '../../config/rollbar.js'
import GUID from '../../models/guid.js'
import GlobalRegistry from '../../models/global-registry.js'
import type { OktaUserProfile } from '../../types/okta.js'

export const handler = async (lambdaEvent: SNSEvent): Promise<void> => {
  const okta = new Client({ cacheMiddleware: null })
  const globalRegistry = new GlobalRegistry(
    process.env.GLOBAL_REGISTRY_TOKEN!,
    process.env.GLOBAL_REGISTRY_URL!
  )
  try {
    const request = new OktaEvent(lambdaEvent.Records[0].Sns.Message)
    const user = await okta.userApi.getUser({ userId: request.userId! })
    if (user.status === 'DEPROVISIONED') {
      const missingGroupId = process.env.OKTA_MISSING_GROUP_ID
      if (!missingGroupId) {
        throw new Error('OKTA_MISSING_GROUP_ID is not set')
      }
      await okta.groupApi.unassignUserFromGroup({
        groupId: missingGroupId,
        userId: request.userId!
      })
      return
    }
    if (typeof user.profile === 'undefined') {
      throw new Error(`Okta user ${request.userId} has no profile`)
    }
    if (typeof user.profile.theKeyGuid === 'undefined') {
      user.profile.theKeyGuid = GUID.create()
      await okta.userApi.updateUser({ userId: request.userId!, user })
    }
    if (await globalRegistry.createOrUpdateProfile(user.profile as OktaUserProfile)) {
      await okta.userApi.updateUser({ userId: request.userId!, user })
    }
  } catch (error) {
    await rollbar.error('user.lifecycle.create Error', error as Error, { lambdaEvent })
    throw error
  }
}
