import type { ALBEvent, ALBResult } from 'aws-lambda'
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns'
import HookResponse from '../../models/hook-response.js'
import OktaRequest from '../../models/okta-request.js'
import rollbar from '../../config/rollbar.js'
import { includes } from 'lodash'

export const handler = async (lambdaEvent: ALBEvent): Promise<ALBResult> => {
  try {
    const sns = new SNSClient({ region: 'us-east-1' })
    const blockList = (process.env.OKTA_ACTOR_ID_BLOCK_LIST ?? '').split(',')
    const request = new OktaRequest(lambdaEvent.body ?? '')
    await Promise.all(
      request.events.map((event) => {
        // If the actor is blocked (IE, event was initiated by okta-hooks), we ignore it
        if (includes(blockList, event.actorId)) {
          return Promise.resolve()
        }
        return sns.send(
          new PublishCommand({
            TargetArn: process.env.SNS_OKTA_EVENTS_ARN!,
            ...event.toSNSMessage()
          })
        )
      })
    )
    return new HookResponse({ statusCode: 204 }).toALBResponse()
  } catch (error) {
    await rollbar.error('events hook Error', error as Error, { lambdaEvent })
    // Return 500 to okta to allow it to retry
    return new HookResponse({ statusCode: 500 }).toALBResponse()
  }
}
