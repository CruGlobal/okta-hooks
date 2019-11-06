import rollbar from '../config/rollbar'
import GUID from '../models/guid'
import eDirectory from '../models/edirectory'

export const handler = async lambdaEvent => {
  try {
    const guid = lambdaEvent.Records[0].Sns.Message
    if (!GUID.test(guid)) {
      return
    }
    const ldapUser = new eDirectory(process.env.LDAP_URL, 'cn=admin,dc=mygcx,dc=org', process.env.LDAP_PASSWORD).fetchUser(guid)
  } catch (error) {
    await rollbar.error('ldap-sync error', error, { lambdaEvent })
    throw error
  }
}
