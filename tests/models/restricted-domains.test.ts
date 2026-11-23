import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import RestrictedDomains, {
  RestrictedDomainsSyncError,
  normalizeDomain,
  REFRESH_MARKER_KEY
} from '@/models/restricted-domains.js'
import {
  mockDynamoDBSend,
  DynamoDBClient,
  BatchGetCommand,
  ScanCommand,
  BatchWriteCommand,
  PutCommand
} from '../mocks/aws-sdk-v3.js'

// The registration bundle must not carry pg, so the model must never load the
// MMD pool module. The job hands the pool in through the constructor.
const mmd = vi.hoisted(() => ({ poolModuleLoaded: false, query: vi.fn() }))

vi.mock('@/config/db.js', () => {
  mmd.poolModuleLoaded = true
  return { default: { query: mmd.query } }
})

vi.mock('@aws-sdk/client-dynamodb', async () => {
  const mock = await import('../mocks/aws-sdk-v3.js')
  return { DynamoDBClient: mock.DynamoDBClient }
})

vi.mock('@aws-sdk/lib-dynamodb', async () => {
  const mock = await import('../mocks/aws-sdk-v3.js')
  return {
    DynamoDBDocumentClient: mock.DynamoDBDocumentClient,
    BatchGetCommand: mock.BatchGetCommand,
    ScanCommand: mock.ScanCommand,
    BatchWriteCommand: mock.BatchWriteCommand,
    PutCommand: mock.PutCommand
  }
})

// The clients are built once at module scope. Capture their configs before
// beforeEach clears the mock's call history.
const dynamoDbClientConfigs = vi.mocked(DynamoDBClient).mock.calls.map(([config]) => config)

// The sign-up lookup gives up fast. The refresh keeps the SDK defaults.
const LOOKUP_CLIENT_CONFIG = {
  maxAttempts: 2,
  requestHandler: { connectionTimeout: 500, requestTimeout: 600, throwOnRequestTimeout: true }
}
const REFRESH_CLIENT_CONFIG = {}

// The config of the DynamoDBClient behind each send, in call order.
const sendClientConfigs = () =>
  mockDynamoDBSend.mock.contexts.map((documentClient) => (documentClient as { client: { config: unknown } }).client.config)

const TABLE = 'restricted_domains_dynamodb'
const MARKER = '#refresh'
// No lower(): normalizeDomain does all case folding, so Postgres collation and
// JavaScript cannot disagree.
const MMD_QUERY = 'SELECT DISTINCT domain FROM "Domains" WHERE is_idm_self_service_prevention = true'

const put = (domain: string) => ({ PutRequest: { Item: { DomainName: domain } } })
const del = (domain: string) => ({ DeleteRequest: { Key: { DomainName: domain } } })
const domains = (count: number, prefix = 'filler') =>
  Array.from({ length: count }, (_, i) => `${prefix}-${i}.org`)

type BatchWriteInput = { RequestItems: Record<string, unknown[]> }
type BatchWriteReply = (input: BatchWriteInput) => unknown

const mockMmd = (rows: (string | null)[]) =>
  mmd.query.mockResolvedValue({ rows: rows.map((domain) => ({ domain })) })

// Routes DocumentClient.send by command. scanPages are the table's contents,
// one array per Scan page; every page but the last carries a LastEvaluatedKey.
const mockTable = (scanPages: string[][], batchWriteReply: BatchWriteReply = () => ({})) => {
  let page = 0
  mockDynamoDBSend.mockImplementation(async (command: { _type: string, input: unknown }) => {
    switch (command._type) {
      case 'ScanCommand': {
        const current = page++
        return {
          Items: scanPages[current].map((DomainName) => ({ DomainName })),
          LastEvaluatedKey: current < scanPages.length - 1 ? { DomainName: scanPages[current].at(-1) } : undefined
        }
      }
      case 'BatchWriteCommand':
        return batchWriteReply(command.input as BatchWriteInput)
      case 'PutCommand':
        return {}
      default:
        throw new Error(`unexpected command ${command._type}`)
    }
  })
}

const batchWrites = () =>
  vi.mocked(BatchWriteCommand).mock.calls.map(([input]) => (input as BatchWriteInput).RequestItems[TABLE])

// The input of each refresh marker Put, in call order.
const markerPuts = () => vi.mocked(PutCommand).mock.calls.map(([input]) => input)

// The type of each command sent, in call order.
const sentCommands = () => mockDynamoDBSend.mock.calls.map(([command]) => (command as { _type: string })._type)

const sync = (options?: { allowLargeDelete?: boolean }) =>
  new RestrictedDomains({ query: mmd.query } as never).syncDomainsFromMmd(options)

type DomainKey = { DomainName: string }
type BatchGetInput = { RequestItems: Record<string, { Keys: DomainKey[], ProjectionExpression: string }> }
// Picks the domains DynamoDB leaves unprocessed on a call (counted from 0).
type LeaveUnprocessed = (requested: string[], call: number) => string[]

const keys = (...domainNames: string[]) => domainNames.map((DomainName) => ({ DomainName }))

// Serves BatchGets from a table holding `listed`, the way DynamoDB does. The
// table also holds the refresh marker unless `marker` is false. Each reply
// returns the processed keys that are in the table. Keys it leaves unprocessed
// come back under UnprocessedKeys and never in Responses.
const mockLookupTable = (
  listed: string[],
  { leaveUnprocessed = () => [], marker = true }: { leaveUnprocessed?: LeaveUnprocessed, marker?: boolean } = {}
) => {
  const table = new Set(marker ? [MARKER, ...listed] : listed)
  let call = 0
  mockDynamoDBSend.mockImplementation(async (command: { _type: string, input: unknown }) => {
    if (command._type !== 'BatchGetCommand') {
      throw new Error(`unexpected command ${command._type}`)
    }
    const request = (command.input as BatchGetInput).RequestItems[TABLE]
    const requested = request.Keys.map(({ DomainName }) => DomainName)
    const unprocessed = leaveUnprocessed(requested, call++)
    const processed = requested.filter((domain) => !unprocessed.includes(domain))
    return {
      Responses: { [TABLE]: keys(...processed.filter((domain) => table.has(domain))) },
      UnprocessedKeys: unprocessed.length > 0 ? { [TABLE]: { ...request, Keys: keys(...unprocessed) } } : {}
    }
  })
}

// The domains in each BatchGet, in call order.
const batchGetKeys = () =>
  vi.mocked(BatchGetCommand).mock.calls.map(([input]) =>
    (input as BatchGetInput).RequestItems[TABLE].Keys.map(({ DomainName }) => DomainName))

describe('RestrictedDomains', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDynamoDBSend.mockReset()
    mmd.query.mockReset()
  })

  describe('DynamoDB clients', () => {
    it('builds a lookup client that gives up on a hung request and a refresh client with SDK defaults', () => {
      expect(dynamoDbClientConfigs).toHaveLength(2)
      expect(dynamoDbClientConfigs).toContainEqual(LOOKUP_CLIENT_CONFIG)
      expect(dynamoDbClientConfigs).toContainEqual(REFRESH_CLIENT_CONFIG)
    })
  })

  // Real MMD rows carry zero-width spaces, trailing dots and notes typed into the
  // domain column. The refresh and the lookup both go through normalizeDomain.
  describe('normalizeDomain(value)', () => {
    // A 253-character name made of 63-character labels.
    const longest = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`

    it.each([
      ['a zero-width space at the start', '​dimension-x.ch', 'dimension-x.ch'],
      ['a zero-width space in the middle', 'dimension​-x.eu', 'dimension-x.eu'],
      ['a zero-width space at the end', 'dimension-x.ch​', 'dimension-x.ch'],
      ['a byte order mark (U+FEFF)', '﻿example.org', 'example.org'],
      ['a word joiner (U+2060)', 'exam⁠ple.org', 'example.org'],
      ['zero-width joiners (U+200C, U+200D)', '‌example.org‍', 'example.org'],
      ['direction marks (U+200E, U+200F)', '‎example.org‏', 'example.org'],
      ['surrounding whitespace', ' \texample.org \n', 'example.org'],
      ['one trailing dot', 'mateus28.com.', 'mateus28.com'],
      ['uppercase', 'Example.ORG', 'example.org'],
      ['all of them at once', ' ​MATEUS28.COM. ', 'mateus28.com'],
      ['an IDN', 'café.fr', 'café.fr'],
      ['an uppercase IDN', 'CAFÉ.FR', 'café.fr'],
      // u + combining diaeresis (NFD) and the precomposed ü (NFC) give one key.
      ['an IDN in NFD form', 'bücher.de', 'bücher.de'],
      ['an IDN in NFC form', 'bücher.de', 'bücher.de'],
      ['a punycode IDN', 'xn--caf-dma.fr', 'xn--caf-dma.fr'],
      // Ends in a vowel sign, a combining mark (category Mc).
      ['a Devanagari IDN', 'हिन्दी.भारत', 'हिन्दी.भारत'],
      ['hyphens and digits inside labels', 'a-1.b2-c.co.uk', 'a-1.b2-c.co.uk'],
      ['a 63-character label', `${'a'.repeat(63)}.org`, `${'a'.repeat(63)}.org`],
      ['a 253-character name', longest, longest]
    ])('cleans %s', (_, value, expected) => {
      expect(normalizeDomain(value)).toBe(expected)
    })

    it.each([
      ['a double dot', 'msubridges..com'],
      ['two trailing dots (only one is stripped)', 'mateus28.com..'],
      ['a leading dot', '.example.org'],
      ['a note', 'no more will be added'],
      ['a note after a domain', 'christfortunisians.com (or christfortunisians.tn if you can find that we (ccci) owns it)'],
      ['a test row starting with a hyphen', '-test ric'],
      ['a test row with spaces', 'ric domain test 1'],
      ['a label starting with a hyphen', '-bad.org'],
      ['a label ending with a hyphen', 'bad-.org'],
      ['a hyphen-led label after the first', 'example.-org'],
      ['a single label', 'localhost'],
      ['an underscore', 'exa_mple.org'],
      ['an email address', 'a@example.org'],
      ['a 64-character label', `${'a'.repeat(64)}.org`],
      ['a 254-character name', `${longest}d`],
      ['an empty string', ''],
      ['only whitespace', '   '],
      ['only a zero-width space', '​'],
      ['only a dot', '.']
    ])('rejects %s', (_, value) => {
      expect(normalizeDomain(value)).toBeNull()
    })

    it('rejects the refresh marker key, so it can never be a domain key', () => {
      expect(REFRESH_MARKER_KEY).toBe(MARKER)
      expect(normalizeDomain(MARKER)).toBeNull()
    })
  })

  describe('static isRestricted(emailAddress)', () => {
    let mockFetch: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      // Deployed Lambdas have CRU_FLAGS_URL injected by terraform. Set it here so
      // any call to the pipeline v2 flag service would surface as a fetch.
      vi.stubEnv('CRU_FLAGS_URL', 'https://flags.example.com/okta-hooks')
      mockFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in tests'))
    })

    afterEach(() => {
      vi.unstubAllEnvs()
      mockFetch.mockRestore()
    })

    // The approved rule (May Workman's MMD development notes, approved by Jon
    // Watson 2026-11-23): blocked when the email's domain, or any parent domain
    // of it, is a key in the table.
    it.each([
      // A listed root domain blocks itself and all its sub-domains.
      ['cru.org', 'cru.org', true],
      ['cru.org', 'mail.cru.org', true],
      ['cru.org', 'fr.mail.cru.org', true],
      // Keys match exactly, never as a suffix or a prefix.
      ['cru.org', 'notcru.org', false],
      ['cru.org', 'cru.org.example.com', false],
      // A listed sub-domain blocks itself and its own sub-domains, but not its
      // root or the root's other sub-domains.
      ['staff.example.org', 'staff.example.org', true],
      ['staff.example.org', 'fr.staff.example.org', true],
      ['staff.example.org', 'example.org', false],
      ['staff.example.org', 'students.example.org', false],
      // Country domains, where the name sits under two labels.
      ['agape.org.uk', 'agape.org.uk', true],
      ['agape.org.uk', 'mail.agape.org.uk', true],
      ['agape.org.uk', 'other.org.uk', false],
      ['ccci.org.za', 'x.ccci.org.za', true],
      // org.uk is a two-label key like any other, so listing it blocks all under it.
      ['org.uk', 'mail.agape.org.uk', true]
    ])('with %s listed, user@%s is restricted: %s', async (listed, domain, expected) => {
      mockLookupTable([listed])
      await expect(RestrictedDomains.isRestricted(`user@${domain}`)).resolves.toBe(expected)
    })

    it('looks up the refresh marker, the domain and each parent down to two labels in one BatchGet', async () => {
      mockLookupTable([])
      await expect(RestrictedDomains.isRestricted('user@fr.staff.example.org')).resolves.toBe(false)
      expect(mockDynamoDBSend).toHaveBeenCalledTimes(1)
      expect(BatchGetCommand).toHaveBeenCalledTimes(1)
      expect(BatchGetCommand).toHaveBeenCalledWith({
        RequestItems: {
          [TABLE]: {
            Keys: keys(MARKER, 'fr.staff.example.org', 'staff.example.org', 'example.org'),
            ProjectionExpression: 'DomainName'
          }
        }
      })
      // The top-level domain alone is never a key, so it is never looked up.
      expect(batchGetKeys().flat()).not.toContain('org')
    })

    // A trailing dot never gets here: the email parser rejects 'user@cru.org.'.
    it.each([
      ['uppercase', 'user@FR.Staff.Example.ORG'],
      ['a zero-width space', 'user@​fr.staff.example.org']
    ])('builds the candidates from the normalized domain (%s)', async (_, email) => {
      mockLookupTable([])
      await RestrictedDomains.isRestricted(email)
      expect(batchGetKeys()).toEqual([[MARKER, 'fr.staff.example.org', 'staff.example.org', 'example.org']])
    })

    it('is true when the lowercased domain is in the table, and looks up only that key and the marker', async () => {
      mockLookupTable(['blocked.org'])
      await expect(RestrictedDomains.isRestricted('a@Blocked.ORG')).resolves.toBe(true)
      expect(batchGetKeys()).toEqual([[MARKER, 'blocked.org']])
    })

    // The refresh writes the marker after every successful run. Without it the
    // table may be empty, so no domain found proves nothing.
    describe('refresh marker', () => {
      it('is false when the marker is there and no domain is listed', async () => {
        mockLookupTable(['other.org'])
        await expect(RestrictedDomains.isRestricted('user@mail.example.org')).resolves.toBe(false)
      })

      it('throws when the marker is missing and no domain is listed', async () => {
        mockLookupTable(['other.org'], { marker: false })
        await expect(RestrictedDomains.isRestricted('user@mail.example.org')).rejects.toThrow(
          'Restricted domains table has no refresh marker (#refresh). It may be empty or never refreshed.'
        )
      })

      it('is true when a domain is listed, even if the marker is missing', async () => {
        mockLookupTable(['example.org'], { marker: false })
        await expect(RestrictedDomains.isRestricted('user@mail.example.org')).resolves.toBe(true)
      })

      it('never counts the marker as a domain hit', async () => {
        // Only the marker is in the table, and the reply finds it.
        mockLookupTable([])
        await expect(RestrictedDomains.isRestricted('user@example.org')).resolves.toBe(false)
        expect(mockDynamoDBSend).toHaveBeenCalledTimes(1)
      })
    })

    it('reads through the lookup client, which gives up fast', async () => {
      mockLookupTable([])
      await RestrictedDomains.isRestricted('a@open.org')
      expect(sendClientConfigs()).toEqual([LOOKUP_CLIENT_CONFIG])
    })

    it('is false when the domain is not in the table', async () => {
      mockLookupTable(['blocked.org'])
      await expect(RestrictedDomains.isRestricted('a@open.org')).resolves.toBe(false)
    })

    it('treats a BatchGet reply without Responses or UnprocessedKeys as finding nothing, not even the marker', async () => {
      mockDynamoDBSend.mockResolvedValue({})
      await expect(RestrictedDomains.isRestricted('a@mail.open.org')).rejects.toThrow('no refresh marker')
      expect(mockDynamoDBSend).toHaveBeenCalledTimes(1)
    })

    it('is false for an invalid email address without reading DynamoDB', async () => {
      const result = await RestrictedDomains.isRestricted('not-an-email')
      expect(result).toBe(false)
      expect(mockDynamoDBSend).not.toHaveBeenCalled()
    })

    it('matches a row the refresh stored from a dirty MMD value', async () => {
      // MMD holds '​dimension-x.ch'; the refresh stores 'dimension-x.ch'.
      mockLookupTable(['dimension-x.ch'])
      await expect(RestrictedDomains.isRestricted('user@Dimension-X.CH')).resolves.toBe(true)
      expect(batchGetKeys()).toEqual([[MARKER, 'dimension-x.ch']])
    })

    it.each([
      ['a single-label domain', 'user@localhost'],
      ['a hyphen-led label', 'user@-bad.org'],
      ['an underscore', 'user@exa_mple.org'],
      ['a domain literal', 'user@[192.0.2.1]']
    ])('is false for %s without reading DynamoDB', async (_, email) => {
      const result = await RestrictedDomains.isRestricted(email)
      expect(result).toBe(false)
      expect(mockDynamoDBSend).not.toHaveBeenCalled()
    })

    it('propagates DynamoDB errors (the registration hook denies)', async () => {
      mockDynamoDBSend.mockRejectedValue(new Error('ProvisionedThroughputExceededException'))
      await expect(RestrictedDomains.isRestricted('a@blocked.org'))
        .rejects.toThrow('ProvisionedThroughputExceededException')
    })

    it('never queries MMD or the flag service', async () => {
      mockLookupTable([])
      await RestrictedDomains.isRestricted('a@open.org')
      expect(mmd.query).not.toHaveBeenCalled()
      expect(mmd.poolModuleLoaded).toBe(false)
      expect(mockFetch).not.toHaveBeenCalled()
    })

    // An unprocessed key was never read, so it is never taken as "not listed",
    // and an unprocessed marker is never taken as "no marker".
    describe('UnprocessedKeys', () => {
      const EMAIL = 'user@fr.staff.example.org'
      const KEYS = [MARKER, 'fr.staff.example.org', 'staff.example.org', 'example.org']
      let setTimeoutSpy: ReturnType<typeof vi.spyOn>

      beforeEach(() => {
        vi.useFakeTimers()
        setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      })

      afterEach(() => {
        setTimeoutSpy.mockRestore()
        vi.useRealTimers()
      })

      const waits = () => setTimeoutSpy.mock.calls.map(([, ms]) => ms)

      it('is true at once when a domain is found, even with other keys unprocessed', async () => {
        mockLookupTable(['example.org'], {
          leaveUnprocessed: (_, call) => (call === 0 ? [MARKER, 'fr.staff.example.org'] : [])
        })
        const run = RestrictedDomains.isRestricted(EMAIL)
        await vi.runAllTimersAsync()
        await expect(run).resolves.toBe(true)
        expect(batchGetKeys()).toEqual([KEYS])
        expect(waits()).toEqual([])
      })

      it('resends only the unprocessed keys after 50 ms, and a hit then is true', async () => {
        mockLookupTable(['example.org'], { leaveUnprocessed: (_, call) => (call === 0 ? ['example.org'] : []) })
        const run = RestrictedDomains.isRestricted(EMAIL)
        await vi.runAllTimersAsync()
        await expect(run).resolves.toBe(true)
        expect(batchGetKeys()).toEqual([KEYS, ['example.org']])
        expect(waits()).toEqual([50])
      })

      it('still resends unprocessed domains when the marker is found, and is false when none is listed', async () => {
        mockLookupTable(['other.org'], {
          leaveUnprocessed: (_, call) => (call === 0 ? ['staff.example.org', 'example.org'] : [])
        })
        const run = RestrictedDomains.isRestricted(EMAIL)
        await vi.runAllTimersAsync()
        await expect(run).resolves.toBe(false)
        expect(batchGetKeys()).toEqual([KEYS, ['staff.example.org', 'example.org']])
        expect(waits()).toEqual([50])
      })

      it('is false when the marker is unprocessed, then read on a retry', async () => {
        mockLookupTable([], { leaveUnprocessed: (_, call) => (call === 0 ? [MARKER] : []) })
        const run = RestrictedDomains.isRestricted(EMAIL)
        await vi.runAllTimersAsync()
        await expect(run).resolves.toBe(false)
        expect(batchGetKeys()).toEqual([KEYS, [MARKER]])
        expect(waits()).toEqual([50])
      })

      it('counts a hit on the second and last retry', async () => {
        mockLookupTable(['example.org'], { leaveUnprocessed: (requested, call) => (call < 2 ? requested : []) })
        const run = RestrictedDomains.isRestricted(EMAIL)
        await vi.runAllTimersAsync()
        await expect(run).resolves.toBe(true)
        expect(BatchGetCommand).toHaveBeenCalledTimes(3)
        expect(waits()).toEqual([50, 100])
      })

      it('throws when keys are still unprocessed after 2 retries', async () => {
        // example.org is listed, but DynamoDB never reads it.
        mockLookupTable(['example.org'], { leaveUnprocessed: (requested) => requested })
        const run = RestrictedDomains.isRestricted(EMAIL)
        const assertion = expect(run).rejects.toThrow('4 restricted-domain lookups unprocessed after 2 retries')
        await vi.runAllTimersAsync()
        await assertion
        expect(batchGetKeys()).toEqual([KEYS, KEYS, KEYS])
        expect(waits()).toEqual([50, 100])
      })

      it('throws the unprocessed error, not the missing-marker error, when only the marker stays unprocessed', async () => {
        mockLookupTable([], { leaveUnprocessed: (requested) => requested.filter((key) => key === MARKER) })
        const run = RestrictedDomains.isRestricted(EMAIL)
        const assertion = expect(run).rejects.toThrow('1 restricted-domain lookups unprocessed after 2 retries')
        await vi.runAllTimersAsync()
        await assertion
        expect(batchGetKeys()).toEqual([KEYS, [MARKER], [MARKER]])
      })
    })

    // BatchGetItem takes at most 100 keys. A 253-character domain made of
    // one-letter labels has 127 labels, so 126 candidates, plus the marker.
    describe('more than 100 candidates', () => {
      const labels = (count: number) => Array.from({ length: count }, () => 'a').join('.')
      const DEEP_DOMAIN = labels(127)
      const DEEP_CANDIDATES = Array.from({ length: 126 }, (_, i) => labels(127 - i))

      it('is the longest domain normalizeDomain accepts', () => {
        expect(DEEP_DOMAIN).toHaveLength(253)
        expect(normalizeDomain(DEEP_DOMAIN)).toBe(DEEP_DOMAIN)
      })

      it('splits them into requests of at most 100 keys that cover every candidate', async () => {
        mockLookupTable([])
        await expect(RestrictedDomains.isRestricted(`user@${DEEP_DOMAIN}`)).resolves.toBe(false)
        expect(batchGetKeys().map((batch) => batch.length)).toEqual([100, 27])
        expect(batchGetKeys().flat()).toEqual([MARKER, ...DEEP_CANDIDATES])
      })

      it('sends the marker exactly once, in the first request only', async () => {
        mockLookupTable([])
        await RestrictedDomains.isRestricted(`user@${DEEP_DOMAIN}`)
        const [first, second] = batchGetKeys()
        expect(first.filter((key) => key === MARKER)).toHaveLength(1)
        expect(second).not.toContain(MARKER)
      })

      it('sends the requests in parallel', async () => {
        let release = () => {}
        const held = new Promise<void>((resolve) => { release = resolve })
        mockDynamoDBSend.mockImplementation(async (command: { input: BatchGetInput }) => {
          await held
          const requested = command.input.RequestItems[TABLE].Keys.map(({ DomainName }) => DomainName)
          return { Responses: { [TABLE]: keys(...requested.filter((key) => key === MARKER)) } }
        })
        const run = RestrictedDomains.isRestricted(`user@${DEEP_DOMAIN}`)
        // Both requests go out before either one answers.
        await vi.waitFor(() => expect(mockDynamoDBSend).toHaveBeenCalledTimes(2))
        release()
        await expect(run).resolves.toBe(false)
      })

      it('is true when the root, in the last request, is listed', async () => {
        mockLookupTable(['a.a'])
        await expect(RestrictedDomains.isRestricted(`user@${DEEP_DOMAIN}`)).resolves.toBe(true)
      })

      it('is true when one request finds a listed domain, even if another fails', async () => {
        mockDynamoDBSend.mockImplementation(async (command: { input: BatchGetInput }) => {
          const requested = command.input.RequestItems[TABLE].Keys.map(({ DomainName }) => DomainName)
          if (!requested.includes('a.a')) {
            throw new Error('ProvisionedThroughputExceededException')
          }
          return { Responses: { [TABLE]: keys('a.a') } }
        })
        await expect(RestrictedDomains.isRestricted(`user@${DEEP_DOMAIN}`)).resolves.toBe(true)
      })

      it('throws when a request fails and no request finds a listed domain', async () => {
        mockDynamoDBSend.mockImplementation(async (command: { input: BatchGetInput }) => {
          const requested = command.input.RequestItems[TABLE].Keys.map(({ DomainName }) => DomainName)
          if (!requested.includes('a.a')) {
            throw new Error('ProvisionedThroughputExceededException')
          }
          return { Responses: { [TABLE]: [] } }
        })
        await expect(RestrictedDomains.isRestricted(`user@${DEEP_DOMAIN}`))
          .rejects.toThrow('ProvisionedThroughputExceededException')
      })
    })
  })

  describe('syncDomainsFromMmd()', () => {
    let warn: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
      warn.mockRestore()
    })

    const skippedLog = (values: (string | null)[], count = values.length) =>
      JSON.stringify({ event: 'restricted_domains_skipped_invalid', count, values })

    it('puts new MMD domains, deletes ones MMD dropped, and reports the counts', async () => {
      const filler = domains(2000)
      mockMmd([' Example.org ', 'b.org', null, '', ...filler])
      mockTable([['b.org', 'old.org', ...filler]])
      await expect(sync()).resolves.toEqual({ added: 1, removed: 1 })
      expect(mmd.query).toHaveBeenCalledWith(MMD_QUERY)
      expect(batchWrites()).toEqual([[put('example.org'), del('old.org')]])
    })

    it('scans and writes through the refresh client, not the lookup client', async () => {
      // A single throttle or slow Scan page should not fail a scheduled refresh.
      mockMmd(['a.org', 'b.org'])
      mockTable([['b.org', 'old.org']])
      await expect(sync()).resolves.toEqual({ added: 1, removed: 1 })
      // One Scan, one BatchWrite, then the refresh marker Put.
      expect(sentCommands()).toEqual(['ScanCommand', 'BatchWriteCommand', 'PutCommand'])
      expect(sendClientConfigs()).toEqual([REFRESH_CLIENT_CONFIG, REFRESH_CLIENT_CONFIG, REFRESH_CLIENT_CONFIG])
    })

    it('writes one item for MMD values that differ only by case or whitespace', async () => {
      mockMmd(['example.org', ' Example.org ', 'EXAMPLE.ORG'])
      mockTable([[]])
      await expect(sync()).resolves.toEqual({ added: 1, removed: 0 })
      expect(batchWrites()).toEqual([[put('example.org')]])
    })

    it('stores cleaned MMD values, skips invalid ones, and logs the skips once', async () => {
      const invalid = ['msubridges..com', 'no more will be added', 'ric domain test 1']
      mockMmd(['​dimension-x.ch', 'mateus28.com.', ...invalid, 'a.org'])
      mockTable([['a.org']])
      await expect(sync()).resolves.toEqual({ added: 2, removed: 0 })
      expect(batchWrites()).toEqual([[put('dimension-x.ch'), put('mateus28.com')]])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(skippedLog(invalid))
    })

    it('counts null and empty rows as skipped', async () => {
      mockMmd(['a.org', null, ''])
      mockTable([['a.org']])
      await expect(sync()).resolves.toEqual({ added: 0, removed: 0 })
      expect(warn).toHaveBeenCalledWith(skippedLog([null, '']))
    })

    it('logs nothing when every MMD value is valid', async () => {
      mockMmd(['a.org', ' B.org. '])
      mockTable([['a.org']])
      await expect(sync()).resolves.toEqual({ added: 1, removed: 0 })
      expect(warn).not.toHaveBeenCalled()
    })

    it('logs the full count but at most 50 values', async () => {
      const invalid = Array.from({ length: 60 }, (_, i) => `test row ${i}`)
      mockMmd(['a.org', ...invalid])
      mockTable([['a.org']])
      await expect(sync()).resolves.toEqual({ added: 0, removed: 0 })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(skippedLog(invalid.slice(0, 50), 60))
    })

    it('writes one item for MMD values that clean up to the same domain', async () => {
      mockMmd(['​dimension-x.ch', 'dimension-x.ch.', 'DIMENSION-X.CH'])
      mockTable([[]])
      await expect(sync()).resolves.toEqual({ added: 1, removed: 0 })
      expect(batchWrites()).toEqual([[put('dimension-x.ch')]])
    })

    it('writes one item for the NFD and NFC forms of an IDN', async () => {
      mockMmd(['BÜCHER.DE', 'bücher.de'])
      mockTable([[]])
      await expect(sync()).resolves.toEqual({ added: 1, removed: 0 })
      expect(batchWrites()).toEqual([[put('bücher.de')]])
    })

    it('replaces dirty keys an earlier refresh stored with their clean versions', async () => {
      // Before normalization the table took MMD values as they were.
      mockMmd(['​dimension-x.ch', '​dimension-x.eu', 'no more will be added', 'a.org'])
      mockTable([['​dimension-x.ch', '​dimension-x.eu', 'no more will be added', 'a.org']])
      await expect(sync()).resolves.toEqual({ added: 2, removed: 3 })
      expect(batchWrites()).toEqual([[
        put('dimension-x.ch'),
        put('dimension-x.eu'),
        del('​dimension-x.ch'),
        del('​dimension-x.eu'),
        del('no more will be added')
      ]])
    })

    it('sends no BatchWrite when nothing changed', async () => {
      mockMmd(['a.org', 'b.org'])
      mockTable([['a.org', 'b.org']])
      await expect(sync()).resolves.toEqual({ added: 0, removed: 0 })
      expect(BatchWriteCommand).not.toHaveBeenCalled()
    })

    it('sends writes in chunks of 25', async () => {
      mockMmd(domains(60, 'new'))
      mockTable([[]])
      await expect(sync()).resolves.toEqual({ added: 60, removed: 0 })
      expect(batchWrites().map((batch) => batch.length)).toEqual([25, 25, 10])
    })

    it('reads every Scan page until LastEvaluatedKey runs out', async () => {
      mockMmd(['a.org', 'b.org', 'c.org'])
      mockTable([['a.org'], ['b.org'], ['c.org']])
      await expect(sync()).resolves.toEqual({ added: 0, removed: 0 })
      expect(vi.mocked(ScanCommand).mock.calls.map(([input]) => input)).toEqual([
        { TableName: TABLE },
        { TableName: TABLE, ExclusiveStartKey: { DomainName: 'a.org' } },
        { TableName: TABLE, ExclusiveStartKey: { DomainName: 'b.org' } }
      ])
      expect(BatchWriteCommand).not.toHaveBeenCalled()
    })

    it('treats a Scan page without Items as empty', async () => {
      mockMmd(['a.org'])
      mockDynamoDBSend.mockResolvedValue({})
      await expect(sync()).resolves.toEqual({ added: 1, removed: 0 })
      expect(batchWrites()).toEqual([[put('a.org')]])
    })

    describe('UnprocessedItems', () => {
      let setTimeoutSpy: ReturnType<typeof vi.spyOn>

      beforeEach(() => {
        vi.useFakeTimers()
        setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      })

      afterEach(() => {
        setTimeoutSpy.mockRestore()
        vi.useRealTimers()
      })

      const waits = () => setTimeoutSpy.mock.calls.map(([, ms]) => ms)

      it('resends unprocessed items after a short wait', async () => {
        mockMmd(['a.org', 'b.org'])
        let call = 0
        mockTable([[]], () => (call++ === 0 ? { UnprocessedItems: { [TABLE]: [put('b.org')] } } : {}))
        const run = sync()
        await vi.runAllTimersAsync()
        await expect(run).resolves.toEqual({ added: 2, removed: 0 })
        expect(batchWrites()).toEqual([[put('a.org'), put('b.org')], [put('b.org')]])
        expect(waits()).toEqual([200])
      })

      it('succeeds when the last retry clears the unprocessed items', async () => {
        mockMmd(['a.org'])
        let call = 0
        mockTable([[]], (input) => (call++ < 3 ? { UnprocessedItems: { [TABLE]: input.RequestItems[TABLE] } } : {}))
        const run = sync()
        await vi.runAllTimersAsync()
        await expect(run).resolves.toEqual({ added: 1, removed: 0 })
        expect(BatchWriteCommand).toHaveBeenCalledTimes(4)
        expect(waits()).toEqual([200, 400, 800])
      })

      it('fails the run when items stay unprocessed after 3 retries, and sends nothing after', async () => {
        mockMmd(domains(30, 'new'))
        mockTable([[]], (input) => ({ UnprocessedItems: { [TABLE]: input.RequestItems[TABLE] } }))
        const run = sync()
        const assertion = expect(run).rejects.toThrow('25 restricted-domain writes unprocessed after 3 retries')
        await vi.runAllTimersAsync()
        await assertion
        // 1 send + 3 retries of the first chunk. The second chunk and the marker
        // are never sent.
        expect(batchWrites().map((batch) => batch.length)).toEqual([25, 25, 25, 25])
        expect(waits()).toEqual([200, 400, 800])
        expect(PutCommand).not.toHaveBeenCalled()
      })
    })

    // A guard writes nothing, not even the refresh marker.
    describe('guards (write nothing and throw)', () => {
      it('rejects with the MMD error when the query fails', async () => {
        mmd.query.mockRejectedValue(new Error('connection refused'))
        mockTable([['a.org']])
        await expect(sync()).rejects.toThrow('connection refused')
        expect(BatchWriteCommand).not.toHaveBeenCalled()
        expect(PutCommand).not.toHaveBeenCalled()
      })

      it('rejects with the DynamoDB error when the Scan fails', async () => {
        mockMmd(['a.org'])
        mockDynamoDBSend.mockRejectedValue(new Error('ResourceNotFoundException'))
        await expect(sync()).rejects.toThrow('ResourceNotFoundException')
        expect(BatchWriteCommand).not.toHaveBeenCalled()
        expect(PutCommand).not.toHaveBeenCalled()
      })

      it('refuses when MMD returns no rows, counting only domains in the table', async () => {
        mockMmd([])
        mockTable([[MARKER, ...domains(2165)]])
        const run = sync()
        await expect(run).rejects.toBeInstanceOf(RestrictedDomainsSyncError)
        await expect(run).rejects.toThrow(/zero-rows guard.*0 valid restricted domains.*2165\./)
        expect(BatchWriteCommand).not.toHaveBeenCalled()
        expect(PutCommand).not.toHaveBeenCalled()
      })

      it('refuses when MMD returns only null or empty domains', async () => {
        mockMmd([null, '', '  '])
        mockTable([['a.org']])
        await expect(sync()).rejects.toBeInstanceOf(RestrictedDomainsSyncError)
        expect(BatchWriteCommand).not.toHaveBeenCalled()
        expect(PutCommand).not.toHaveBeenCalled()
      })

      it('refuses when every MMD value is invalid, and still logs the skips', async () => {
        const invalid = ['no more will be added', 'ric domain test 1', 'msubridges..com']
        mockMmd(invalid)
        mockTable([['a.org']])
        const run = sync()
        await expect(run).rejects.toBeInstanceOf(RestrictedDomainsSyncError)
        await expect(run).rejects.toThrow(/zero-rows guard.*0 valid restricted domains.*1\./)
        expect(BatchWriteCommand).not.toHaveBeenCalled()
        expect(PutCommand).not.toHaveBeenCalled()
        expect(warn).toHaveBeenCalledWith(skippedLog(invalid))
      })

      it('still refuses an empty MMD answer when allowLargeDelete is set', async () => {
        mockMmd([])
        mockTable([['a.org']])
        await expect(sync({ allowLargeDelete: true })).rejects.toBeInstanceOf(RestrictedDomainsSyncError)
        expect(BatchWriteCommand).not.toHaveBeenCalled()
        expect(PutCommand).not.toHaveBeenCalled()
      })
    })

    // A shrink trip still applies the adds: they only grow the restricted set.
    // It skips every delete and fails the run so a person looks.
    describe('shrink guard (adds only, then throw)', () => {
      it('writes the adds, sends no deletes, and rejects (2,165 rows, 300 deletes, limit 217)', async () => {
        const table = domains(2165)
        mockMmd([...table.slice(300), 'new-a.org', 'new-b.org'])
        mockTable([table])
        const run = sync()
        await expect(run).rejects.toBeInstanceOf(RestrictedDomainsSyncError)
        await expect(run).rejects.toThrow(
          /shrink guard.*300 of 2165.*limit of 217.*Applied 2 adds.*skipped all 300 deletes.*allowLargeDelete/
        )
        expect(batchWrites().flat()).toEqual([put('new-a.org'), put('new-b.org')])
        expect(PutCommand).not.toHaveBeenCalled()
      })

      it('writes nothing and rejects when there are no adds (2,165 rows, 300 deletes, limit 217)', async () => {
        const table = domains(2165)
        mockMmd(table.slice(300))
        mockTable([table])
        const run = sync()
        await expect(run).rejects.toBeInstanceOf(RestrictedDomainsSyncError)
        await expect(run).rejects.toThrow(/shrink guard.*300 of 2165.*limit of 217.*Applied 0 adds.*skipped all 300 deletes.*allowLargeDelete/)
        expect(BatchWriteCommand).not.toHaveBeenCalled()
        expect(PutCommand).not.toHaveBeenCalled()
      })

      it('rejects with the write error, not the guard error, when the adds fail', async () => {
        const table = domains(2165)
        mockMmd([...table.slice(300), 'new-a.org'])
        mockTable([table], () => {
          throw new Error('ProvisionedThroughputExceededException')
        })
        const run = sync()
        await expect(run).rejects.toThrow('ProvisionedThroughputExceededException')
        await expect(run).rejects.not.toBeInstanceOf(RestrictedDomainsSyncError)
        expect(batchWrites().flat()).toEqual([put('new-a.org')])
        expect(PutCommand).not.toHaveBeenCalled()
      })

      it('writes the adds, the large delete and the marker when the event sets allowLargeDelete', async () => {
        const table = domains(2165)
        mockMmd([...table.slice(300), 'new-a.org'])
        mockTable([table])
        await expect(sync({ allowLargeDelete: true })).resolves.toEqual({ added: 1, removed: 300 })
        expect(batchWrites().flat()).toEqual([put('new-a.org'), ...table.slice(0, 300).map(del)])
        expect(markerPuts()).toEqual([
          expect.objectContaining({ Item: expect.objectContaining({ DomainName: MARKER, DomainCount: 1866 }) })
        ])
      })

      it('allows exactly the limit (2,165 rows, 217 deletes)', async () => {
        const table = domains(2165)
        mockMmd(table.slice(217))
        mockTable([table])
        await expect(sync()).resolves.toEqual({ added: 0, removed: 217 })
      })

      it('allows 100 deletes from a small table (150 rows, limit 100)', async () => {
        const table = domains(150)
        mockMmd(table.slice(100))
        mockTable([table])
        await expect(sync()).resolves.toEqual({ added: 0, removed: 100 })
      })

      it('refuses 101 deletes from a small table (150 rows, limit 100)', async () => {
        const table = domains(150)
        mockMmd(table.slice(101))
        mockTable([table])
        await expect(sync()).rejects.toThrow(/shrink guard.*101 of 150.*limit of 100/)
        expect(BatchWriteCommand).not.toHaveBeenCalled()
        expect(PutCommand).not.toHaveBeenCalled()
      })
    })

    // The sign-up check denies every sign-up while the marker is missing, so
    // only a run that wrote everything may write it.
    describe('refresh marker', () => {
      const NOW = '2026-11-23T18:00:00.000Z'
      const marker = (domainCount: number) => ({
        TableName: TABLE,
        Item: { DomainName: MARKER, LastSuccessAt: NOW, DomainCount: domainCount }
      })

      beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(new Date(NOW))
      })

      afterEach(() => {
        vi.useRealTimers()
      })

      it('writes the marker last, after a successful run, with LastSuccessAt and DomainCount', async () => {
        // MMD gives 3 domains once cleaned and deduplicated.
        mockMmd(['a.org', ' A.org ', 'b.org', 'c.org'])
        mockTable([[MARKER, 'a.org', 'old.org']])
        await expect(sync()).resolves.toEqual({ added: 2, removed: 1 })
        expect(markerPuts()).toEqual([marker(3)])
        expect(sentCommands()).toEqual(['ScanCommand', 'BatchWriteCommand', 'PutCommand'])
      })

      it('writes the marker on a run with no changes', async () => {
        mockMmd(['a.org', 'b.org'])
        mockTable([[MARKER, 'a.org', 'b.org']])
        await expect(sync()).resolves.toEqual({ added: 0, removed: 0 })
        expect(BatchWriteCommand).not.toHaveBeenCalled()
        expect(markerPuts()).toEqual([marker(2)])
      })

      it('skips the marker in the scan, so it is never diffed, deleted or counted', async () => {
        mockMmd(['a.org', 'b.org'])
        mockTable([[MARKER, 'a.org', 'old.org']])
        await expect(sync()).resolves.toEqual({ added: 1, removed: 1 })
        expect(batchWrites()).toEqual([[put('b.org'), del('old.org')]])
      })

      it('leaves the marker out of the shrink limit (2,160 domains plus the marker, 217 deletes, limit 216)', async () => {
        // Counted as a row, the marker would raise the limit to 217 and let this through.
        const table = domains(2160)
        mockMmd(table.slice(217))
        mockTable([[MARKER, ...table]])
        await expect(sync()).rejects.toThrow(/shrink guard.*217 of 2160.*limit of 216/)
        expect(PutCommand).not.toHaveBeenCalled()
      })

      it('fails the run when the marker write fails', async () => {
        mockMmd(['a.org'])
        mockDynamoDBSend.mockImplementation(async (command: { _type: string }) => {
          if (command._type === 'PutCommand') {
            throw new Error('AccessDeniedException')
          }
          return { Items: [{ DomainName: 'a.org' }] }
        })
        await expect(sync()).rejects.toThrow('AccessDeniedException')
      })
    })
  })
})
