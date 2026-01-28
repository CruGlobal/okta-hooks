import pkg from '@okta/okta-sdk-nodejs'
const { Client } = pkg

const groupId = process.argv[2] || process.env.OKTA_MISSING_GROUP_ID
if (!groupId) {
  console.error('Usage: node count-group-members.mjs [groupId]')
  console.error('Or set OKTA_MISSING_GROUP_ID environment variable')
  process.exit(1)
}

const okta = new Client({ cacheMiddleware: null })

try {
  const group = await okta.groupApi.getGroup({ groupId })
  console.log('Group:', group.profile.name)
  console.log('Description:', group.profile.description || '(none)')

  let count = 0
  const users = await okta.groupApi.listGroupUsers({ groupId })
  await users.each(() => {
    count++
    return true
  })

  console.log('Member count:', count)
} catch (error) {
  console.error('Error:', error.message)
  process.exit(1)
}
