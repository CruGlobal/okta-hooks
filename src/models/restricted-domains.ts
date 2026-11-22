import { parseOneAddress, ParsedMailbox } from 'email-addresses'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, ScanCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb'
import type { Pool } from 'pg'
import { compact, difference, chunk, uniq } from 'lodash'

type DynamoDbRequestType = 'put' | 'delete'

interface DynamoDbPutRequest {
  PutRequest: { Item: { DomainName: string } }
}

interface DynamoDbDeleteRequest {
  DeleteRequest: { Key: { DomainName: string } }
}

type DynamoDbRequest = DynamoDbPutRequest | DynamoDbDeleteRequest

type MmdQueryable = Pick<Pool, 'query'>

const MMD_RESTRICTED_DOMAINS_QUERY =
  'SELECT DISTINCT lower(domain) AS domain FROM "Domains" WHERE is_idm_self_service_prevention = true'
// DynamoDB's BatchWriteItem maximum.
const BATCH_WRITE_SIZE = 25
const UNPROCESSED_RETRY_WAITS_MS = [200, 400, 800]
// A refresh may delete at most this share of the table, or MIN_DELETE_LIMIT rows,
// whichever is larger. More needs a person: invoke with {"allowLargeDelete": true}.
const MAX_DELETE_PERCENT = 10
const MIN_DELETE_LIMIT = 100

export class RestrictedDomainsSyncError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RestrictedDomainsSyncError'
  }
}

const dynamoDbRequest = (type: DynamoDbRequestType, domain: string): DynamoDbRequest => {
  switch (type) {
    case 'put':
      return {
        PutRequest: { Item: { DomainName: domain } }
      }
    case 'delete':
      return { DeleteRequest: { Key: { DomainName: domain } } }
  }
}

const normalizeDomain = (domain: string): string => domain.trim().toLowerCase()

// Both clients are built once per container.
//
// The sign-up check has to answer or fail well inside Okta's 3 s hook limit:
// each attempt gives up after 600 ms and there is one retry, so a hung or
// unreachable DynamoDB fails in about 1.3 s. A throttled first attempt backs off
// up to 1 s before the retry. Without throwOnRequestTimeout the SDK only logs a
// warning at requestTimeout and keeps waiting.
const lookupClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 500, requestTimeout: 600, throwOnRequestTimeout: true }
  })
)

// The refresh has no one waiting on it, so it keeps the SDK's default retries
// and timeouts. One throttle or slow Scan page should not fail the run.
const refreshClient = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Sends one BatchWrite and returns the requests DynamoDB did not process.
const sendBatch = async (tableName: string, requests: DynamoDbRequest[]): Promise<DynamoDbRequest[]> => {
  const result = await refreshClient.send(
    new BatchWriteCommand({ RequestItems: { [tableName]: requests } })
  )
  return (result.UnprocessedItems?.[tableName] ?? []) as DynamoDbRequest[]
}

const batchWrite = async (requests: DynamoDbRequest[]): Promise<void> => {
  const tableName = process.env.DYNAMODB_RESTRICTED_DOMAINS!
  let unprocessed = await sendBatch(tableName, requests)
  for (const wait of UNPROCESSED_RETRY_WAITS_MS) {
    if (unprocessed.length === 0) {
      return
    }
    await sleep(wait)
    unprocessed = await sendBatch(tableName, unprocessed)
  }
  if (unprocessed.length > 0) {
    throw new Error(
      `DynamoDB left ${unprocessed.length} restricted-domain writes unprocessed after ${UNPROCESSED_RETRY_WAITS_MS.length} retries.`
    )
  }
}

// MMD (`Domains.is_idm_self_service_prevention`) is the source of truth. The
// scheduled job copies it into the DynamoDB table (syncDomainsFromMmd), and the
// registration hook reads only that copy (isRestricted), so an MMD outage never
// changes a sign-up decision. This module must not import the MMD pool
// (src/config/db.ts): registration imports it, and its bundle must not carry pg.
// The job passes the pool to the constructor instead.
class RestrictedDomains {
  private mmd: MmdQueryable

  constructor(mmd: MmdQueryable) {
    this.mmd = mmd
  }

  // Exact match on the lowercased domain; no subdomain or parent matching. Throws
  // on any DynamoDB error, which the registration hook turns into a DENY.
  static async isRestricted(emailAddress: string): Promise<boolean> {
    const parsedAddress = parseOneAddress(emailAddress) as ParsedMailbox | null

    if (!parsedAddress || !parsedAddress.domain) {
      return false
    }

    const result = await lookupClient.send(
      new GetCommand({
        TableName: process.env.DYNAMODB_RESTRICTED_DOMAINS!,
        Key: { DomainName: normalizeDomain(parsedAddress.domain) }
      })
    )
    return result.Item !== undefined
  }

  async allDomains(): Promise<string[]> {
    const domains: string[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const page = await refreshClient.send(
        new ScanCommand({
          TableName: process.env.DYNAMODB_RESTRICTED_DOMAINS!,
          ...(exclusiveStartKey && { ExclusiveStartKey: exclusiveStartKey })
        })
      )
      domains.push(...(page.Items ?? []).map((item) => item.DomainName as string))
      exclusiveStartKey = page.LastEvaluatedKey
    } while (exclusiveStartKey)
    return domains
  }

  async mmdDomains(): Promise<string[]> {
    const result = await this.mmd.query<{ domain: string | null }>(MMD_RESTRICTED_DOMAINS_QUERY)
    return uniq(compact(result.rows.map((row) => row.domain && normalizeDomain(row.domain))))
  }

  // Makes the table match MMD, writing only the difference. Writes nothing and
  // throws when MMD fails, returns no domains, or the run would delete more than
  // the shrink limit (unless allowLargeDelete). Fails the run if a write is left
  // unprocessed.
  async syncDomainsFromMmd(
    { allowLargeDelete = false }: { allowLargeDelete?: boolean } = {}
  ): Promise<{ added: number; removed: number }> {
    const [mmdDomains, currentDomains] = await Promise.all([this.mmdDomains(), this.allDomains()])

    if (mmdDomains.length === 0) {
      throw new RestrictedDomainsSyncError(
        `Restricted domains refresh refused by the zero-rows guard: MMD returned 0 restricted domains and the table holds ${currentDomains.length}. Nothing was written.`
      )
    }

    const added = difference(mmdDomains, currentDomains)
    const removed = difference(currentDomains, mmdDomains)
    const deleteLimit = Math.max(Math.ceil((currentDomains.length * MAX_DELETE_PERCENT) / 100), MIN_DELETE_LIMIT)
    if (removed.length > deleteLimit && !allowLargeDelete) {
      throw new RestrictedDomainsSyncError(
        `Restricted domains refresh refused by the shrink guard: it would delete ${removed.length} of ${currentDomains.length} domains, over the limit of ${deleteLimit}. Nothing was written. To allow it, invoke the job once with {"allowLargeDelete": true}.`
      )
    }

    // Puts go first, so a run that fails part way has removed nothing until every
    // new domain is in.
    const requests = [
      ...added.map((domain) => dynamoDbRequest('put', domain)),
      ...removed.map((domain) => dynamoDbRequest('delete', domain))
    ]
    for (const batch of chunk(requests, BATCH_WRITE_SIZE)) {
      await batchWrite(batch)
    }
    return { added: added.length, removed: removed.length }
  }
}

export default RestrictedDomains
