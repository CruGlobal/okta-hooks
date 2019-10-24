import { SNS } from 'aws-sdk'
import HookResponse from '../../models/hook-response'
import OktaRequest from '../../models/okta-request'
import rollbar from '../../config/rollbar'

export const handler = async (lambdaEvent) => {
  try {
    const sns = new SNS({ apiVersion: '2010-03-31', region: 'us-east-1' })
    const request = new OktaRequest(lambdaEvent['body'])
    await Promise.all(request.events.map(event => {
      return sns.publish({ TargetArn: process.env.SNS_OKTA_EVENTS_ARN, ...event.toSNSMessage() }).promise()
    }))
    return new HookResponse({ statusCode: 204 }).toALBResponse()
  } catch (error) {
    rollbar.error('events hook Error', error, { lambdaEvent })
    // Return 500 to okta to allow it to retry
    return new HookResponse({ statusCode: 500 }).toALBResponse()
  }
}
