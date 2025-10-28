import { Client } from '@okta/okta-sdk-nodejs'
import rollbar from '../config/rollbar'
import { SNS } from 'aws-sdk'

export const handler = async (lambdaEvent) => {
  const okta = new Client({ cacheMiddleware: null })
  const sns = new SNS({ apiVersion: '2010-03-31', region: 'us-east-1' })
  try {
    const processed = []
    (await okta.groupApi.listGroupUsers({groupId: process.env.OKTA_MISSING_GROUP_ID, limit: 25 })).each(user => {
      if (processed.length >= 100) {
        return false
      }
      processed.push(sns.publish({
        TargetArn: process.env.SNS_OKTA_EVENTS_ARN,
        Message: JSON.stringify({
          eventType: 'user.account.update_profile',
          target: [{ id: user.id }],
          debugContext: { debugData: { changedAttributes: 'Notes' } }
        }),
        MessageAttributes: {
          eventType: {
            DataType: 'String',
            StringValue: 'user.account.update_profile'
          }
        }
      }).promise())
    })

    await Promise.allSettled(processed)
  } catch (error) {
    await rollbar.error('sync-missing-okta-users Error', error, { lambdaEvent })
    throw error
  }
}
