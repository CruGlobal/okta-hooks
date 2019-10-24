import { Client } from '@okta/okta-sdk-nodejs'
import OktaEvent from '../../../models/okta-event'
import rollbar from '../../../config/rollbar'
import GUID from '../../../models/guid'

export const handler = async (lambdaEvent) => {
  const okta = new Client()
  try {
    const request = new OktaEvent(lambdaEvent.Records[0].Sns.Message)
    const user = await okta.getUser(request.userId)
    if (typeof user.profile.theKeyGuid === 'undefined') {
      user.profile.theKeyGuid = GUID.create()
      await user.update()
    }
  } catch (error) {
    rollbar.error('user.lifecycle.create Error', error, { lambdaEvent })
    throw error
  }
}
