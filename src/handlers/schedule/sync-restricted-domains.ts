import type { ScheduledEvent } from 'aws-lambda'
import pool from '../../config/db.js'
import rollbar from '../../config/rollbar.js'
import RestrictedDomains from '../../models/restricted-domains.js'
import redactError from '../../utils/redact-error.js'

export const handler = async (lambdaEvent: ScheduledEvent): Promise<void> => {
  try {
    // A deliberate large removal is a one-off manual invoke with the event
    // {"allowLargeDelete": true}. The schedule never sets it.
    const allowLargeDelete = (lambdaEvent as { allowLargeDelete?: unknown })?.allowLargeDelete === true
    const result = await new RestrictedDomains(pool).syncDomainsFromMmd({ allowLargeDelete })
    console.log('Restricted domains refreshed from MMD', result)
  } catch (error) {
    // Strip credentials before anything serialises this error: the rethrow below
    // reaches the Lambda runtime's log line, which the Datadog extension ships.
    await rollbar.error('import-restricted-domains Error', redactError(error) as Error, { lambdaEvent })
    throw error
  }
}
