import type { ScheduledEvent } from 'aws-lambda'
import { Client } from '@okta/okta-sdk-nodejs'
import rollbar from '../../config/rollbar.js'
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns'

export const handler = async (lambdaEvent: ScheduledEvent): Promise<void> => {
  const okta = new Client({ cacheMiddleware: null })
  const sns = new SNSClient({ region: 'us-east-1' })
  try {
    const processed: Promise<unknown>[] = []
    const users = await okta.groupApi.listGroupUsers({
      groupId: process.env.OKTA_MISSING_GROUP_ID!,
      limit: 25
    })
    await users.each((user) => {
      if (processed.length >= 100) {
        return false
      }
      processed.push(
        sns.send(
          new PublishCommand({
            TargetArn: process.env.SNS_OKTA_EVENTS_ARN!,
            Message: JSON.stringify({
              eventType: 'user.lifecycle.create',
              target: [{ id: user.id }]
            }),
            MessageAttributes: {
              eventType: {
                DataType: 'String',
                StringValue: 'user.lifecycle.create'
              }
            }
          })
        )
      )
      return true
    })

    await Promise.allSettled(processed)
  } catch (error) {
    await rollbar.error('sync-missing-okta-users Error', error as Error, { lambdaEvent })
    throw error
  }
}
