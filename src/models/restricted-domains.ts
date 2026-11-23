import { parseOneAddress, ParsedMailbox } from 'email-addresses'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, BatchGetCommand, ScanCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb'
import type { Pool } from 'pg'
import { difference, chunk, uniq } from 'lodash'

type DynamoDbRequestType = 'put' | 'delete'

interface DynamoDbPutRequest {
  PutRequest: { Item: { DomainName: string } }
}

interface DynamoDbDeleteRequest {
  DeleteRequest: { Key: { DomainName: string } }
}

type DynamoDbRequest = DynamoDbPutRequest | DynamoDbDeleteRequest

type DomainKey = { DomainName: string }

type MmdQueryable = Pick<Pool, 'query'>

// No lower(): normalizeDomain does all case folding, so Postgres collation and
// JavaScript's toLowerCase cannot disagree (Turkish İ, for example).
const MMD_RESTRICTED_DOMAINS_QUERY =
  'SELECT DISTINCT domain FROM "Domains" WHERE is_idm_self_service_prevention = true'
// DynamoDB's BatchWriteItem maximum.
const BATCH_WRITE_SIZE = 25
const UNPROCESSED_RETRY_WAITS_MS = [200, 400, 800]
// DynamoDB's BatchGetItem maximum.
const BATCH_GET_SIZE = 100
// Waits before the sign-up check resends keys DynamoDB left unprocessed. Kept
// short: the whole check has to fit inside the hook's 1.5 s lookup timeout.
const UNPROCESSED_KEYS_RETRY_WAITS_MS = [50, 100]
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

// Format characters (Unicode category Cf): zero-width spaces and joiners, word
// joiners, byte order marks, direction marks. They are invisible, so they ride
// along when a domain is pasted into MMD.
const FORMAT_CHARACTERS = /\p{Cf}/gu
// One label: letters and digits in any script, so IDNs pass. Hyphens are allowed
// inside but not at either end. Combining marks (\p{M}) are allowed after the
// first character, because scripts such as Devanagari need them. 1 to 63
// characters.
const DOMAIN_LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}-]{0,61}[\p{L}\p{M}\p{N}])?$/u
const MAX_DOMAIN_LENGTH = 253
const MAX_SKIPPED_VALUES_LOGGED = 50

// Turns an MMD value or an email's domain into a table key, or null when it is
// not a domain. The refresh and the sign-up lookup both use it, so the key a
// lookup reads is always the key the refresh wrote. Removes format characters
// anywhere, composes to NFC (so the NFD and NFC forms of an IDN match), trims,
// strips one trailing dot and lowercases. Then it needs at least two
// dot-separated labels and at most 253 characters.
export const normalizeDomain = (value: string): string | null => {
  const domain = value.replace(FORMAT_CHARACTERS, '').normalize('NFC').trim().replace(/\.$/, '').toLowerCase()
  const labels = domain.split('.')
  if (domain.length > MAX_DOMAIN_LENGTH || labels.length < 2 || !labels.every((label) => DOMAIN_LABEL.test(label))) {
    return null
  }
  return domain
}

// The keys a sign-up check looks up for a normalized domain: the domain and
// each parent domain, longest first, down to two labels. fr.staff.example.org
// gives fr.staff.example.org, staff.example.org and example.org. The top-level
// domain alone ("org", "uk") is never looked up: normalizeDomain needs two
// labels, and the refresh stores only its output, so the table can never hold a
// one-label key. Country domains need no special case. A listed agape.org.uk
// blocks mail.agape.org.uk, and a listed org.uk would block every domain under
// it, as any other two-label key would.
const candidateDomains = (domain: string): string[] => {
  const labels = domain.split('.')
  return labels.slice(0, -1).map((_, i) => labels.slice(i).join('.'))
}

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

// Sends one BatchGet of at most 100 keys. Says whether any key is in the table,
// and returns the keys DynamoDB did not process.
const sendBatchGet = async (
  tableName: string,
  keys: DomainKey[]
): Promise<{ found: boolean; unprocessed: DomainKey[] }> => {
  const result = await lookupClient.send(
    new BatchGetCommand({ RequestItems: { [tableName]: { Keys: keys, ProjectionExpression: 'DomainName' } } })
  )
  return {
    found: (result.Responses?.[tableName] ?? []).length > 0,
    unprocessed: (result.UnprocessedKeys?.[tableName]?.Keys ?? []) as DomainKey[]
  }
}

// Whether any of these domains (at most 100) is a key in the table. A hit
// decides at once, even when DynamoDB left other keys unprocessed. With no hit,
// only the unprocessed keys are sent again, after 50 ms and then 100 ms. Keys
// still unprocessed after that make it throw. A key DynamoDB did not read is
// never taken as "not listed".
const anyListed = async (tableName: string, domains: string[]): Promise<boolean> => {
  let keys: DomainKey[] = domains.map((DomainName) => ({ DomainName }))
  for (let retry = 0; ; retry++) {
    const { found, unprocessed } = await sendBatchGet(tableName, keys)
    if (found || unprocessed.length === 0) {
      return found
    }
    if (retry === UNPROCESSED_KEYS_RETRY_WAITS_MS.length) {
      throw new Error(
        `DynamoDB left ${unprocessed.length} restricted-domain lookups unprocessed after ${UNPROCESSED_KEYS_RETRY_WAITS_MS.length} retries.`
      )
    }
    await sleep(UNPROCESSED_KEYS_RETRY_WAITS_MS[retry])
    keys = unprocessed
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

  // Restricted when the email's normalized domain, or any parent domain of it,
  // is a key in the table. A listed root domain blocks itself and all its
  // sub-domains: cru.org blocks mail.cru.org and fr.mail.cru.org. A listed
  // sub-domain blocks itself and its own sub-domains, but not its root or the
  // root's other sub-domains: staff.example.org blocks fr.staff.example.org, but
  // not example.org or students.example.org. Keys match exactly, so notcru.org
  // and cru.org.example.com never match cru.org. (Rule from May Workman's "MMD
  // development notes", approved by Jon Watson 2026-11-23.)
  //
  // Every candidate goes in one BatchGet. BatchGetItem takes at most 100 keys,
  // and a 253-character domain can have 126 candidates, so a longer list is
  // split into requests of 100 sent in parallel. A hit in any request decides,
  // even if another request failed. With no hit, any failure throws, and the
  // registration hook turns that into a DENY. An address with no domain, or one
  // normalizeDomain rejects, is not restricted and is never looked up: the
  // refresh never stores such a key.
  //
  // Timing: one BatchGet normally takes a few ms. UnprocessedKeys retries add
  // at most 150 ms of waiting and two more requests. Each request is bounded by
  // the lookup client (about 1.3 s when DynamoDB hangs), and the hook's 1.5 s
  // lookup timeout (CHECK_TIMEOUT_MS) caps the whole check, retries included.
  // So a slow DynamoDB still gets the "try again" DENY in time.
  static async isRestricted(emailAddress: string): Promise<boolean> {
    const parsedAddress = parseOneAddress(emailAddress) as ParsedMailbox | null
    const domain = parsedAddress?.domain ? normalizeDomain(parsedAddress.domain) : null

    if (!domain) {
      return false
    }

    const tableName = process.env.DYNAMODB_RESTRICTED_DOMAINS!
    const lookups = await Promise.allSettled(
      chunk(candidateDomains(domain), BATCH_GET_SIZE).map((domains) => anyListed(tableName, domains))
    )
    if (lookups.some((lookup) => lookup.status === 'fulfilled' && lookup.value)) {
      return true
    }
    const failed = lookups.find((lookup): lookup is PromiseRejectedResult => lookup.status === 'rejected')
    if (failed) {
      throw failed.reason
    }
    return false
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

  // MMD's values cleaned by normalizeDomain, without duplicates. A row that is
  // not a domain (null, a note, a test row) is skipped and never stored. One
  // warning per run lists the skipped values so the MMD owner can fix them.
  async mmdDomains(): Promise<string[]> {
    const result = await this.mmd.query<{ domain: string | null }>(MMD_RESTRICTED_DOMAINS_QUERY)
    const domains: string[] = []
    const skipped: (string | null)[] = []
    for (const { domain } of result.rows) {
      const normalized = normalizeDomain(domain ?? '')
      if (normalized) {
        domains.push(normalized)
      } else {
        skipped.push(domain)
      }
    }
    if (skipped.length > 0) {
      console.warn(JSON.stringify({
        event: 'restricted_domains_skipped_invalid',
        count: skipped.length,
        values: skipped.slice(0, MAX_SKIPPED_VALUES_LOGGED)
      }))
    }
    return uniq(domains)
  }

  // Makes the table match MMD, writing only the difference. Writes nothing and
  // throws when MMD fails or returns no domains. When the run would delete more
  // than the shrink limit (and allowLargeDelete is not set), it writes the adds,
  // skips every delete, then throws. Fails the run if a write is left
  // unprocessed.
  async syncDomainsFromMmd(
    { allowLargeDelete = false }: { allowLargeDelete?: boolean } = {}
  ): Promise<{ added: number; removed: number }> {
    const [mmdDomains, currentDomains] = await Promise.all([this.mmdDomains(), this.allDomains()])

    if (mmdDomains.length === 0) {
      throw new RestrictedDomainsSyncError(
        `Restricted domains refresh refused by the zero-rows guard: MMD returned 0 valid restricted domains and the table holds ${currentDomains.length}. Nothing was written.`
      )
    }

    const added = difference(mmdDomains, currentDomains)
    const removed = difference(currentDomains, mmdDomains)
    const deleteLimit = Math.max(Math.ceil((currentDomains.length * MAX_DELETE_PERCENT) / 100), MIN_DELETE_LIMIT)
    // Adds only grow the restricted set, so they are safe to apply even when the
    // shrink guard holds back the deletes.
    const shrinkGuardTripped = removed.length > deleteLimit && !allowLargeDelete

    // added and removed never share a domain, so write order is not a safety
    // property. On a shrink trip only the puts run. A run that fails part way
    // leaves its remaining adds and removes for the next run.
    const requests = [
      ...added.map((domain) => dynamoDbRequest('put', domain)),
      ...(shrinkGuardTripped ? [] : removed.map((domain) => dynamoDbRequest('delete', domain)))
    ]
    for (const batch of chunk(requests, BATCH_WRITE_SIZE)) {
      await batchWrite(batch)
    }

    if (shrinkGuardTripped) {
      throw new RestrictedDomainsSyncError(
        `Restricted domains refresh stopped by the shrink guard: it would delete ${removed.length} of ${currentDomains.length} domains, over the limit of ${deleteLimit}. Applied ${added.length} adds and skipped all ${removed.length} deletes. To apply the deletes, invoke the job once with {"allowLargeDelete": true}.`
      )
    }
    return { added: added.length, removed: removed.length }
  }
}

export default RestrictedDomains
