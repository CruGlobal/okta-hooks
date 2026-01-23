import type { ALBEvent, ALBResult } from 'aws-lambda'
import HookResponse from '../../models/hook-response.js'

export const handler = async (lambdaEvent: ALBEvent): Promise<ALBResult> => {
  return new HookResponse({
    statusCode: 200,
    body: { verification: lambdaEvent.headers?.['x-okta-verification-challenge'] }
  }).toALBResponse()
}
