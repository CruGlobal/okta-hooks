import type { ScheduledEvent } from 'aws-lambda'
import rollbar from '../../config/rollbar.js'
import RestrictedDomains from '../../models/restricted-domains.js'
import redactError from '../../utils/redact-error.js'

export const handler = async (lambdaEvent: ScheduledEvent): Promise<void> => {
  try {
    await new RestrictedDomains().syncDomainsFromGoogle()
  } catch (error) {
    // Strip credentials before anything serialises this error: the rethrow below
    // reaches the Lambda runtime's log line, which the Datadog extension ships.
    await rollbar.error('import-restricted-domains Error', redactError(error) as Error, { lambdaEvent })
    throw error
  }
}
