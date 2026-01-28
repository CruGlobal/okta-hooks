import pkg from '@okta/okta-sdk-nodejs'
const { Client } = pkg
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns'

const userId = process.argv[2]
if (!userId) {
  console.error('Usage: node test-create-event.mjs <userId or email>')
  process.exit(1)
}

const snsArn = process.env.SNS_OKTA_EVENTS_ARN
if (!snsArn) {
  console.error('SNS_OKTA_EVENTS_ARN is not set')
  process.exit(1)
}

const okta = new Client({ cacheMiddleware: null })
const sns = new SNSClient({ region: 'us-east-1' })

try {
  // Look up user
  const user = await okta.userApi.getUser({ userId })
  console.log('=== BEFORE ===')
  console.log('User:', user.profile.login)
  console.log('theKeyGuid:', user.profile.theKeyGuid ?? '(missing)')
  console.log('thekeyGrPersonId:', user.profile.thekeyGrPersonId ?? '(missing)')
  console.log('grMasterPersonId:', user.profile.grMasterPersonId ?? '(missing)')

  // Publish user.lifecycle.create event
  console.log('\nPublishing user.lifecycle.create event to SNS...')
  await sns.send(
    new PublishCommand({
      TargetArn: snsArn,
      Message: JSON.stringify({
        eventType: 'user.lifecycle.create',
        target: [{ id: user.id }]
      }),
      MessageAttributes: {
        eventType: {
          DataType: 'String',
          StringValue: 'user.lifecycle.create'
        }
      }
    })
  )
  console.log('Published. Waiting 15 seconds for Lambda to process...')

  await new Promise(resolve => setTimeout(resolve, 15000))

  // Re-check user
  const updated = await okta.userApi.getUser({ userId })
  console.log('\n=== AFTER ===')
  console.log('User:', updated.profile.login)
  console.log('theKeyGuid:', updated.profile.theKeyGuid ?? '(missing)')
  console.log('thekeyGrPersonId:', updated.profile.thekeyGrPersonId ?? '(missing)')
  console.log('grMasterPersonId:', updated.profile.grMasterPersonId ?? '(missing)')

  // Summary
  const fixed = updated.profile.theKeyGuid && updated.profile.thekeyGrPersonId && updated.profile.grMasterPersonId
  console.log('\nResult:', fixed ? 'FIXED' : 'NOT FIXED')
} catch (error) {
  console.error('Error:', error.message)
  process.exit(1)
}
