import 'dotenv/config'
import pkg from '@okta/okta-sdk-nodejs'
const { Client } = pkg

const email = process.argv[2]
if (!email) {
  console.error('Usage: node lookup-user.mjs <email>')
  process.exit(1)
}

const okta = new Client({ cacheMiddleware: null })

try {
  const user = await okta.userApi.getUser({ userId: email })
  console.log('=== USER INFO ===')
  console.log('User ID:', user.id)
  console.log('Status:', user.status)
  console.log('Created:', user.created)
  console.log('Last Login:', user.lastLogin)
  console.log('\nProfile:')
  console.log(JSON.stringify(user.profile, null, 2))

  // Fetch recent system logs for this user
  console.log('\n=== SYSTEM LOGS (last 7 days) ===')
  const logs = await okta.systemLogApi.listLogEvents({
    filter: `target.id eq "${user.id}"`,
    since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    limit: 50
  })

  const logEntries = []
  await logs.each(log => {
    logEntries.push(log)
    return true
  })

  // Find and show the user.lifecycle.create event in detail
  const createEvent = logEntries.find(l => l.eventType === 'user.lifecycle.create')
  if (createEvent) {
    console.log('\n=== user.lifecycle.create EVENT DETAILS ===')
    console.log('Published:', createEvent.published)
    console.log('Event Type:', createEvent.eventType)
    console.log('Actor:', JSON.stringify(createEvent.actor, null, 2))
    console.log('Target:', JSON.stringify(createEvent.target, null, 2))
    console.log('Outcome:', JSON.stringify(createEvent.outcome, null, 2))
    console.log('UUID:', createEvent.uuid)
  } else {
    console.log('No user.lifecycle.create event found')
  }

  console.log('\n=== ALL EVENTS SUMMARY ===')
  logEntries.slice(0, 10).forEach(log => {
    console.log(`[${log.published}] ${log.eventType} - ${log.outcome?.result} (Actor: ${log.actor?.displayName || log.actor?.alternateId})`)
  })
} catch (error) {
  console.error('Error:', error.message)
  process.exit(1)
}
