import type { ScheduledEvent } from 'aws-lambda'
import rollbar from '../../config/rollbar.js'
import RestrictedDomains from '../../models/restricted-domains.js'

export const handler = async (lambdaEvent: ScheduledEvent): Promise<void> => {
  try {
    await new RestrictedDomains().syncDomainsFromGoogle()
  } catch (error) {
    await rollbar.error('import-restricted-domains Error', error as Error, { lambdaEvent })
    throw error
  }
}
