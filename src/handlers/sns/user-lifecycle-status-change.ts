import type { SNSEvent } from 'aws-lambda'
import { Client } from '@okta/okta-sdk-nodejs'
import OktaEvent from '../../models/okta-event.js'
import rollbar from '../../config/rollbar.js'
import GlobalRegistry from '../../models/global-registry.js'

export const handler = async (lambdaEvent: SNSEvent): Promise<void> => {
  const okta = new Client({ cacheMiddleware: null })
  const globalRegistry = new GlobalRegistry(
    process.env.GLOBAL_REGISTRY_TOKEN!,
    process.env.GLOBAL_REGISTRY_URL!
  )
  try {
    const event = new OktaEvent(lambdaEvent.Records[0].Sns.Message)
    const user = await okta.userApi.getUser({ userId: event.userId! }) as any
    switch (user.status) {
      case 'ACTIVE':
        if (await globalRegistry.createOrUpdateProfile(user.profile)) {
          await okta.userApi.updateUser({ userId: event.userId!, user })
        }
        break
      case 'DEPROVISIONED':
        await globalRegistry.deleteProfile(user.profile)
        break
    }
  } catch (error) {
    await rollbar.error('status-change Error', error as Error, { lambdaEvent })
    throw error
  }
}
