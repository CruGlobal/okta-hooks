import pkg from '@okta/okta-sdk-nodejs'
const { Client } = pkg
import { v4 as uuid } from 'uuid'
import GRClientPkg from 'global-registry-nodejs-client'
const { GRClient } = GRClientPkg

const userId = process.argv[2]
if (!userId) {
  console.error('Usage: node test-create-local.mjs <userId or email>')
  process.exit(1)
}

const okta = new Client({ cacheMiddleware: null })
const grClient = new GRClient({
  baseUrl: process.env.GLOBAL_REGISTRY_URL,
  accessToken: process.env.GLOBAL_REGISTRY_TOKEN
})

try {
  const user = await okta.userApi.getUser({ userId })
  console.log('=== BEFORE ===')
  console.log('User:', user.profile.login, `(${user.id})`)
  console.log('theKeyGuid:', user.profile.theKeyGuid ?? '(missing)')
  console.log('thekeyGrPersonId:', user.profile.thekeyGrPersonId ?? '(missing)')
  console.log('grMasterPersonId:', user.profile.grMasterPersonId ?? '(missing)')

  // Generate GUID if missing (same logic as user-lifecycle-create handler)
  if (typeof user.profile.theKeyGuid === 'undefined') {
    user.profile.theKeyGuid = uuid().toLowerCase()
    console.log('\nGenerated theKeyGuid:', user.profile.theKeyGuid)
  }

  // Create/update Global Registry profile
  console.log('Creating/updating Global Registry profile...')
  const result = await grClient.Entity.post(
    {
      person: {
        client_integration_id: user.profile.theKeyGuid,
        key_username: user.profile.login,
        first_name: user.profile.firstName,
        last_name: user.profile.lastName,
        email_address: {
          client_integration_id: user.profile.theKeyGuid,
          email: user.profile.login
        },
        authentication: {
          client_integration_id: user.profile.theKeyGuid,
          key_guid: user.profile.theKeyGuid
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

  const personId = result?.entity?.person?.id
  const masterPersonId = result?.entity?.person?.['master_person:relationship']?.master_person
  console.log('GR person ID:', personId)
  console.log('GR master person ID:', masterPersonId)

  // Update Okta profile
  user.profile.thekeyGrPersonId = personId
  user.profile.grMasterPersonId = masterPersonId
  console.log('\nUpdating Okta user profile...')
  await okta.userApi.updateUser({ userId: user.id, user })

  // Verify
  const updated = await okta.userApi.getUser({ userId })
  console.log('\n=== AFTER ===')
  console.log('theKeyGuid:', updated.profile.theKeyGuid ?? '(missing)')
  console.log('thekeyGrPersonId:', updated.profile.thekeyGrPersonId ?? '(missing)')
  console.log('grMasterPersonId:', updated.profile.grMasterPersonId ?? '(missing)')

  const fixed = updated.profile.theKeyGuid && updated.profile.thekeyGrPersonId && updated.profile.grMasterPersonId
  console.log('\nResult:', fixed ? 'FIXED' : 'NOT FIXED')
} catch (error) {
  console.error('Error:', error.message)
  console.error(error)
  process.exit(1)
}
