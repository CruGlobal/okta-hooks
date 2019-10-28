import rollbar from '../config/rollbar'
import RestrictedDomains from '../models/restricted-domains'

export const handler = async (lambdaEvent) => {
  try {
    await new RestrictedDomains().syncDomainsFromGoogle()
  } catch (error) {
    await rollbar.error('import-restricted-domains Error', error, { lambdaEvent })
    throw error
  }
}
