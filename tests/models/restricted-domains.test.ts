import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import RestrictedDomains, { RestrictedDomainsSyncError } from '@/models/restricted-domains.js'
import {
  mockDynamoDBSend,
  DynamoDBClient,
  GetCommand,
  ScanCommand,
  BatchWriteCommand
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
    GetCommand: mock.GetCommand,
    ScanCommand: mock.ScanCommand,
    BatchWriteCommand: mock.BatchWriteCommand
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
const MMD_QUERY = 'SELECT DISTINCT lower(domain) AS domain FROM "Domains" WHERE is_idm_self_service_prevention = true'

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
      default:
        throw new Error(`unexpected command ${command._type}`)
    }
  })
}

const batchWrites = () =>
  vi.mocked(BatchWriteCommand).mock.calls.map(([input]) => (input as BatchWriteInput).RequestItems[TABLE])

const sync = (options?: { allowLargeDelete?: boolean }) =>
  new RestrictedDomains({ query: mmd.query } as never).syncDomainsFromMmd(options)

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

    it('is true when the lowercased domain is in the table', async () => {
      mockDynamoDBSend.mockResolvedValue({ Item: { DomainName: 'blocked.org' } })
      const result = await RestrictedDomains.isRestricted('a@Blocked.ORG')
      expect(result).toBe(true)
      expect(GetCommand).toHaveBeenCalledWith({ TableName: TABLE, Key: { DomainName: 'blocked.org' } })
      expect(mockDynamoDBSend).toHaveBeenCalledTimes(1)
    })

    it('reads through the lookup client, which gives up fast', async () => {
      mockDynamoDBSend.mockResolvedValue({ Item: undefined })
      await RestrictedDomains.isRestricted('a@open.org')
      expect(sendClientConfigs()).toEqual([LOOKUP_CLIENT_CONFIG])
    })

    it('is false when the domain is not in the table', async () => {
      mockDynamoDBSend.mockResolvedValue({ Item: undefined })
      const result = await RestrictedDomains.isRestricted('a@open.org')
      expect(result).toBe(false)
    })

    it('is false for an invalid email address without reading DynamoDB', async () => {
      const result = await RestrictedDomains.isRestricted('not-an-email')
      expect(result).toBe(false)
      expect(mockDynamoDBSend).not.toHaveBeenCalled()
    })

    it('propagates DynamoDB errors (the registration hook denies)', async () => {
      mockDynamoDBSend.mockRejectedValue(new Error('ProvisionedThroughputExceededException'))
      await expect(RestrictedDomains.isRestricted('a@blocked.org'))
        .rejects.toThrow('ProvisionedThroughputExceededException')
    })

    it('never queries MMD or the flag service', async () => {
      mockDynamoDBSend.mockResolvedValue({ Item: undefined })
      await RestrictedDomains.isRestricted('a@open.org')
      expect(mmd.query).not.toHaveBeenCalled()
      expect(mmd.poolModuleLoaded).toBe(false)
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  describe('syncDomainsFromMmd()', () => {
    it('puts new MMD domains, deletes ones MMD dropped, and reports the counts', async () => {
      const filler = domains(2000)
      mockMmd([' Example.org ', 'b.org', null, '', ...filler])
      mockTable([['b.org', 'old.org', ...filler]])
      await expect(sync()).resolves.toEqual({ added: 1, removed: 1 })
      expect(mmd.query).toHaveBeenCalledWith(MMD_QUERY)
      expect(batchWrites()).toEqual([[put('example.org'), del('old.org')]])
    })

    it('scans and writes through the refresh client, not the lookup client', async () => {
      // A single throttle or slow Scan page should not fail a 15-minute refresh.
      mockMmd(['a.org', 'b.org'])
      mockTable([['b.org', 'old.org']])
      await expect(sync()).resolves.toEqual({ added: 1, removed: 1 })
      // One Scan, then one BatchWrite.
      expect(sendClientConfigs()).toEqual([REFRESH_CLIENT_CONFIG, REFRESH_CLIENT_CONFIG])
    })

    it('writes one item for MMD values that differ only by case or whitespace', async () => {
      mockMmd(['example.org', ' Example.org ', 'EXAMPLE.ORG'])
      mockTable([[]])
      await expect(sync()).resolves.toEqual({ added: 1, removed: 0 })
      expect(batchWrites()).toEqual([[put('example.org')]])
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
        // 1 send + 3 retries of the first chunk. The second chunk is never sent.
        expect(batchWrites().map((batch) => batch.length)).toEqual([25, 25, 25, 25])
        expect(waits()).toEqual([200, 400, 800])
      })
    })

    describe('guards (write nothing and throw)', () => {
      it('rejects with the MMD error when the query fails', async () => {
        mmd.query.mockRejectedValue(new Error('connection refused'))
        mockTable([['a.org']])
        await expect(sync()).rejects.toThrow('connection refused')
        expect(BatchWriteCommand).not.toHaveBeenCalled()
      })

      it('rejects with the DynamoDB error when the Scan fails', async () => {
        mockMmd(['a.org'])
        mockDynamoDBSend.mockRejectedValue(new Error('ResourceNotFoundException'))
        await expect(sync()).rejects.toThrow('ResourceNotFoundException')
        expect(BatchWriteCommand).not.toHaveBeenCalled()
      })

      it('refuses when MMD returns no rows', async () => {
        mockMmd([])
        mockTable([domains(2165)])
        const run = sync()
        await expect(run).rejects.toBeInstanceOf(RestrictedDomainsSyncError)
        await expect(run).rejects.toThrow(/zero-rows guard.*0 restricted domains.*2165/)
        expect(BatchWriteCommand).not.toHaveBeenCalled()
      })

      it('refuses when MMD returns only null or empty domains', async () => {
        mockMmd([null, '', '  '])
        mockTable([['a.org']])
        await expect(sync()).rejects.toBeInstanceOf(RestrictedDomainsSyncError)
        expect(BatchWriteCommand).not.toHaveBeenCalled()
      })

      it('still refuses an empty MMD answer when allowLargeDelete is set', async () => {
        mockMmd([])
        mockTable([['a.org']])
        await expect(sync({ allowLargeDelete: true })).rejects.toBeInstanceOf(RestrictedDomainsSyncError)
        expect(BatchWriteCommand).not.toHaveBeenCalled()
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
      })

      it('writes nothing and rejects when there are no adds (2,165 rows, 300 deletes, limit 217)', async () => {
        const table = domains(2165)
        mockMmd(table.slice(300))
        mockTable([table])
        const run = sync()
        await expect(run).rejects.toBeInstanceOf(RestrictedDomainsSyncError)
        await expect(run).rejects.toThrow(/shrink guard.*300 of 2165.*limit of 217.*Applied 0 adds.*skipped all 300 deletes.*allowLargeDelete/)
        expect(BatchWriteCommand).not.toHaveBeenCalled()
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
      })

      it('writes the adds and the large delete when the event sets allowLargeDelete', async () => {
        const table = domains(2165)
        mockMmd([...table.slice(300), 'new-a.org'])
        mockTable([table])
        await expect(sync({ allowLargeDelete: true })).resolves.toEqual({ added: 1, removed: 300 })
        expect(batchWrites().flat()).toEqual([put('new-a.org'), ...table.slice(0, 300).map(del)])
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
      })
    })
  })
})
