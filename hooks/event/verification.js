import HookResponse from '../../models/hook-response'

export const handler = async (lambdaEvent) => {
  return new HookResponse({
    statusCode: 200,
    body: { verification: lambdaEvent['headers']['x-okta-verification-challenge'] }
  }).toALBResponse()
}
