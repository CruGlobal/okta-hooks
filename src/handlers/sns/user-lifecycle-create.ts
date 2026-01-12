import type { SNSEvent } from 'aws-lambda'
import { Client } from '@okta/okta-sdk-nodejs'
import OktaEvent from '../../models/okta-event.js'
import rollbar from '../../config/rollbar.js'
import GUID from '../../models/guid.js'
import GlobalRegistry from '../../models/global-registry.js'

export const handler = async (lambdaEvent: SNSEvent): Promise<void> => {
  const okta = new Client({ cacheMiddleware: null })
  const globalRegistry = new GlobalRegistry(
    process.env.GLOBAL_REGISTRY_TOKEN!,
    process.env.GLOBAL_REGISTRY_URL!
  )
  try {
    const request = new OktaEvent(lambdaEvent.Records[0].Sns.Message)
    const user = await okta.userApi.getUser({ userId: request.userId! }) as any
    if (typeof user.profile?.theKeyGuid === 'undefined') {
      user.profile.theKeyGuid = GUID.create()
    }
    await globalRegistry.createOrUpdateProfile(user.profile)
    await user.update()
  } catch (error) {
    await rollbar.error('user.lifecycle.create Error', error as Error, { lambdaEvent })
    throw error
  }
}
