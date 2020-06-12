import { Client } from '@okta/okta-sdk-nodejs'
import rollbar from '../config/rollbar'
import { SNS } from 'aws-sdk'

export const handler = async (lambdaEvent) => {
  const okta = new Client()
  const sns = new SNS({ apiVersion: '2010-03-31', region: 'us-east-1' })
  try {
    const users = await okta.listGroupUsers(process.env.OKTA_MISSING_GROUP_ID, { limit: 100 })

    await Promise.allSettled(users.map(user => {
      return sns.publish({
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
      }).promise()
    }))
  } catch (error) {
    await rollbar.error('sync-missing-okta-users Error', error, { lambdaEvent })
    throw error
  }
}
