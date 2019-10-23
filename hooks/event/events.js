import { SNS } from 'aws-sdk'
import HookResponse from '../../models/hook-response'
import OktaRequest from '../../models/okta-request'

export const handler = async (lambdaEvent) => {
  const sns = new SNS({ apiVersion: '2010-03-31' })
  const request = new OktaRequest(lambdaEvent['body'])
  await Promise.all(request.events.map(event => {
    return sns.publish({ TargetArn: process.env.SNS_OKTA_EVENTS_ARN, ...event.toSNSMessage() }).promise()
  }))
  return new HookResponse({ statusCode: 204 }).toALBResponse()
}
