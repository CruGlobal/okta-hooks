import pkg from '@okta/okta-sdk-nodejs'
const { Client } = pkg
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns'

const groupId = process.env.OKTA_MISSING_GROUP_ID
const snsArn = process.env.SNS_OKTA_EVENTS_ARN
if (!groupId || !snsArn) {
  console.error('Required env vars: OKTA_MISSING_GROUP_ID, SNS_OKTA_EVENTS_ARN')
  process.exit(1)
}

const okta = new Client({ cacheMiddleware: null })
const sns = new SNSClient({ region: 'us-east-1' })

const processed = []
const users = await okta.groupApi.listGroupUsers({ groupId, limit: 25 })
await users.each((user) => {
  if (processed.length >= 100) {
    return false
  }
  console.log(`[${processed.length + 1}] Publishing event for ${user.profile.login} (${user.id})`)
  processed.push(
    sns.send(
      new PublishCommand({
        TargetArn: snsArn,
        Message: JSON.stringify({
          eventType: 'user.account.update_profile',
          target: [{ id: user.id }],
          debugContext: { debugData: { changedAttributes: 'Notes' } }
        }),
        MessageAttributes: {
          eventType: {
            DataType: 'String',
            StringValue: 'user.account.update_profile'
          }
        }
      })
    )
  )
  return true
})

const results = await Promise.allSettled(processed)
const succeeded = results.filter(r => r.status === 'fulfilled').length
const failed = results.filter(r => r.status === 'rejected').length
console.log(`\nDone. ${succeeded} succeeded, ${failed} failed out of ${processed.length} total.`)
if (failed > 0) {
  results.filter(r => r.status === 'rejected').forEach((r, i) => {
    console.error(`  Failed ${i + 1}:`, r.reason?.message)
  })
}
