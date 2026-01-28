import pkg from '@okta/okta-sdk-nodejs'
const { Client } = pkg
import { v4 as uuid } from 'uuid'
import GRClientPkg from 'global-registry-nodejs-client'
const { GRClient } = GRClientPkg

const okta = new Client({ cacheMiddleware: null })
const grClient = new GRClient({
  baseUrl: process.env.GLOBAL_REGISTRY_URL,
  accessToken: process.env.GLOBAL_REGISTRY_TOKEN
})

const groupId = process.env.OKTA_MISSING_GROUP_ID
if (!groupId) {
  console.error('OKTA_MISSING_GROUP_ID is not set')
  process.exit(1)
}

let processed = 0
let fixed = 0
let failed = 0

const users = await okta.groupApi.listGroupUsers({ groupId })
await users.each(async (user) => {
  processed++
  try {
    const profile = user.profile

    if (typeof profile.theKeyGuid === 'undefined') {
      profile.theKeyGuid = uuid().toLowerCase()
    }

    const result = await grClient.Entity.post(
      {
        person: {
          client_integration_id: profile.theKeyGuid,
          key_username: profile.login,
          first_name: profile.firstName,
          last_name: profile.lastName,
          email_address: {
            client_integration_id: profile.theKeyGuid,
            email: profile.login
          },
          authentication: {
            client_integration_id: profile.theKeyGuid,
            key_guid: profile.theKeyGuid
          },
          account_number: null
        }
      },
      {
        full_response: true,
        require_mdm: true,
        fields: 'master_person:relationship'
      }
    )

    profile.thekeyGrPersonId = result?.entity?.person?.id
    profile.grMasterPersonId = result?.entity?.person?.['master_person:relationship']?.master_person

    await okta.userApi.updateUser({ userId: user.id, user })
    fixed++
    console.log(`[${processed}] FIXED ${profile.login}`)
  } catch (error) {
    failed++
    console.error(`[${processed}] FAILED ${user.profile.login}: ${error.message}`)
  }
  return true
})

console.log(`\nDone. ${fixed} fixed, ${failed} failed, ${processed} total.`)
