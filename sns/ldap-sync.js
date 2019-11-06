import rollbar from '../config/rollbar'

export const handler = async lambdaEvent => {
  try {

  } catch (error) {
    await rollbar.error('ldap-sync error', error, { lambdaEvent })
    throw error
  }
}
