import { Client } from '@okta/okta-sdk-nodejs'
import rollbar from '../../../config/rollbar'
import OktaEvent from '../../../models/okta-event'

export const handler = async (lambdaEvent) => {
  const okta = new Client()
  try {
    const request = new OktaEvent(lambdaEvent.Records[0].Sns.Message)
    if (request.changedAttributes.includes('login')) {
      const user = await okta.getUser(request.userId)
      // If login changed, nd it doesn't match email, set email to the value of login
      if (user.profile.login !== user.profile.email) {
        user.profile.email = user.profile.login
        await user.update()
      }
    }
  } catch (error) {
    await rollbar.error('user.account.update_profile Error', error, { lambdaEvent })
    throw error
  }
}
