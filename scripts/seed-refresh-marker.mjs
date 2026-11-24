// One-time rollout helper for the restricted-domains refresh marker (PR #135).
// See "Rollout: seed the refresh marker" in CLAUDE.md for when to run it.
//
//   cru app impersonate -n okta-hooks -e <staging|production> -- node scripts/seed-refresh-marker.mjs --env <stage|prod> [--write]
//
// Dry run by default. With --write it puts the marker only when none exists.
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'

// Must equal REFRESH_MARKER_KEY in src/models/restricted-domains.ts (a test pins it).
export const REFRESH_MARKER_KEY = '#refresh'
export const SEEDED_BY = 'scripts/seed-refresh-marker.mjs'
// Fewer domain rows than this means the table looks empty or wrong (stage and prod hold ~2,165).
export const MIN_DOMAIN_ROWS = 1000
// --write needs at least this long before the next scheduled refresh.
export const MIN_MINUTES_BEFORE_NEXT_RUN = 30
// The refresh runs on cron(0 0/3 * * ? *): every 3 hours at :00 UTC.
const SCHEDULE_EVERY_HOURS = 3
const ENVIRONMENTS = ['stage', 'prod']

const USAGE =
  'Usage: cru app impersonate -n okta-hooks -e <staging|production> -- node scripts/seed-refresh-marker.mjs --env <stage|prod> [--write]'

export const tableName = (env) => `okta-hooks-${env}-restricted-domains`

// The first scheduled refresh strictly after now.
export const nextScheduledRun = (now) => {
  const next = new Date(now)
  next.setUTCMinutes(0, 0, 0)
  do {
    next.setUTCHours(next.getUTCHours() + 1)
  } while (next.getUTCHours() % SCHEDULE_EVERY_HOURS !== 0)
  return next
}

const clientRegion = async (client) => {
  const region = client.config?.region
  return typeof region === 'function' ? await region() : region
}

const countDomainRows = async (client, table) => {
  let count = 0
  let startKey
  do {
    const page = await client.send(
      new ScanCommand({
        TableName: table,
        Select: 'COUNT',
        FilterExpression: 'DomainName <> :m',
        ExpressionAttributeValues: { ':m': REFRESH_MARKER_KEY },
        ExclusiveStartKey: startKey
      })
    )
    count += page.Count ?? 0
    startKey = page.LastEvaluatedKey
  } while (startKey)
  return count
}

const readMarker = async (client, table) => {
  const result = await client.send(
    new GetCommand({ TableName: table, Key: { DomainName: REFRESH_MARKER_KEY }, ConsistentRead: true })
  )
  return result.Item
}

const sameItem = (a, b) =>
  !!a && !!b && Object.keys(b).length === Object.keys(a).length && Object.keys(b).every((key) => a[key] === b[key])

// Returns the process exit code: 0 for done or nothing to do, 1 for refused or failed.
export const seedRefreshMarker = async (args, now, client) => {
  let options
  try {
    options = parseArgs({
      args,
      options: { env: { type: 'string' }, write: { type: 'boolean', default: false } },
      strict: true,
      allowPositionals: false
    }).values
  } catch (error) {
    console.error(error.message)
    console.error(USAGE)
    return 1
  }
  if (!ENVIRONMENTS.includes(options.env)) {
    console.error(`--env must be one of: ${ENVIRONMENTS.join(', ')}`)
    console.error(USAGE)
    return 1
  }

  const table = tableName(options.env)
  const nextRun = nextScheduledRun(now)
  const minutesUntilNextRun = (nextRun.getTime() - now.getTime()) / 60_000

  console.log(`Mode:                 ${options.write ? 'WRITE' : 'dry run'}`)
  console.log(`Table:                ${table}`)
  console.log(`Region:               ${await clientRegion(client)}`)
  console.log(`Now (UTC):            ${now.toISOString()}`)
  console.log(`Next scheduled run:   ${nextRun.toISOString()} (${Math.floor(minutesUntilNextRun)} minutes away)`)

  const domainCount = await countDomainRows(client, table)
  console.log(`Domain rows:          ${domainCount}`)
  if (domainCount < MIN_DOMAIN_ROWS) {
    console.error(`Aborting: fewer than ${MIN_DOMAIN_ROWS} domain rows. The table looks empty or wrong.`)
    return 1
  }

  const existing = await readMarker(client, table)
  if (existing) {
    console.log(`Marker:               ${JSON.stringify(existing)}`)
    console.log('Marker already present; nothing to do.')
    return 0
  }
  console.log('Marker:               none')

  const item = {
    DomainName: REFRESH_MARKER_KEY,
    LastSuccessAt: now.toISOString(),
    DomainCount: domainCount,
    SeededBy: SEEDED_BY
  }
  const tooClose = minutesUntilNextRun < MIN_MINUTES_BEFORE_NEXT_RUN
  const tooCloseReason =
    `the next scheduled refresh (${nextRun.toISOString()}) is ${Math.floor(minutesUntilNextRun)} minutes away, ` +
    `under ${MIN_MINUTES_BEFORE_NEXT_RUN}. The old refresh code deletes the marker, and the new code must be ` +
    'deployed and run before that refresh. Wait until just after it finishes.'

  if (!options.write) {
    console.log(`Dry run: with --write this would put ${JSON.stringify(item)}`)
    if (tooClose) {
      console.log(`--write would be refused right now: ${tooCloseReason}`)
    }
    return 0
  }

  if (tooClose) {
    console.error(`Refusing to write: ${tooCloseReason}`)
    return 1
  }

  try {
    await client.send(
      new PutCommand({ TableName: table, Item: item, ConditionExpression: 'attribute_not_exists(DomainName)' })
    )
  } catch (error) {
    if (error?.name !== 'ConditionalCheckFailedException') {
      throw error
    }
    console.log('A marker appeared meanwhile; nothing written.')
    console.log(`Marker:               ${JSON.stringify(await readMarker(client, table))}`)
    return 0
  }

  const written = await readMarker(client, table)
  console.log(`Read back:            ${JSON.stringify(written)}`)
  if (!sameItem(written, item)) {
    console.error(`Read-back does not match what was written: ${JSON.stringify(item)}`)
    return 1
  }
  console.log('Marker written.')
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const baseClient = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-east-1' })
  try {
    process.exitCode = await seedRefreshMarker(process.argv.slice(2), new Date(), DynamoDBDocumentClient.from(baseClient))
  } catch (error) {
    console.error(`Failed: ${error?.name ?? 'Error'}: ${error?.message ?? error}`)
    process.exitCode = 1
  } finally {
    baseClient.destroy()
  }
}
