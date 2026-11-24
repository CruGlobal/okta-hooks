import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { MockInstance } from 'vitest'
import { REFRESH_MARKER_KEY } from '@/models/restricted-domains.js'
import {
  REFRESH_MARKER_KEY as SCRIPT_MARKER_KEY,
  nextScheduledRun,
  seedRefreshMarker
} from '../../scripts/seed-refresh-marker.mjs'
import { mockDynamoDBSend, ScanCommand, GetCommand, PutCommand } from '../mocks/aws-sdk-v3.js'

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
    PutCommand: mock.PutCommand,
    GetCommand: mock.GetCommand
  }
})

type Item = Record<string, unknown>
type Command = { _type: string, input: Record<string, unknown> }

const TABLE = 'okta-hooks-prod-restricted-domains'
// 5 minutes after the 03:00 UTC run, 175 minutes before the 06:00 UTC run.
const SAFE_NOW = new Date('2026-11-24T03:05:00.000Z')
// Next scheduled run 06:00 UTC, 25 minutes away.
const TOO_CLOSE_NOW = new Date('2026-11-24T05:35:00.000Z')
// The 03:00 UTC run started 2 minutes ago and may still be scanning.
const JUST_AFTER_NOW = new Date('2026-11-24T03:02:00.000Z')

const client = { send: mockDynamoDBSend, config: { region: async () => 'us-east-1' } }

// A fake table: Scan pages of these counts, and the marker item, if any.
let scanPages: number[]
let marker: Item | undefined
// What a Get after the Put returns. Defaults to what was put.
let readBack: ((put: Item) => Item | undefined) | undefined

const puts = () => vi.mocked(PutCommand).mock.calls.map(([input]) => input)
const output = (spy: MockInstance) => spy.mock.calls.map((args) => args.join(' ')).join('\n')

describe('seed-refresh-marker script', () => {
  let log: MockInstance
  let error: MockInstance

  beforeEach(() => {
    vi.clearAllMocks()
    mockDynamoDBSend.mockReset()
    scanPages = [2165]
    marker = undefined
    readBack = undefined
    mockDynamoDBSend.mockImplementation(async (command: Command) => {
      switch (command._type) {
        case 'ScanCommand': {
          const page = (command.input.ExclusiveStartKey as { page?: number } | undefined)?.page ?? 0
          return {
            Count: scanPages[page],
            LastEvaluatedKey: page + 1 < scanPages.length ? { page: page + 1 } : undefined
          }
        }
        case 'GetCommand':
          return { Item: marker }
        case 'PutCommand': {
          if (marker) {
            throw Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' })
          }
          const item = command.input.Item as Item
          marker = readBack ? readBack(item) : item
          return {}
        }
      }
      throw new Error(`Unexpected command ${command._type}`)
    })
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
    error = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    log.mockRestore()
    error.mockRestore()
  })

  it('uses the same marker key as the model', () => {
    expect(SCRIPT_MARKER_KEY).toBe(REFRESH_MARKER_KEY)
  })

  it.each([
    ['2026-11-24T03:05:00.000Z', '2026-11-24T06:00:00.000Z'],
    ['2026-11-24T05:59:59.999Z', '2026-11-24T06:00:00.000Z'],
    ['2026-11-24T06:00:00.000Z', '2026-11-24T09:00:00.000Z'],
    ['2026-11-24T22:10:00.000Z', '2026-11-25T00:00:00.000Z']
  ])('finds the next scheduled refresh after %s', (now, next) => {
    expect(nextScheduledRun(new Date(now)).toISOString()).toBe(next)
  })

  it('dry run counts domain rows, reads the marker and writes nothing', async () => {
    expect(await seedRefreshMarker(['--env', 'prod'], SAFE_NOW, client)).toBe(0)

    expect(vi.mocked(ScanCommand).mock.calls.map(([input]) => input)).toEqual([
      {
        TableName: TABLE,
        Select: 'COUNT',
        FilterExpression: 'DomainName <> :m',
        ExpressionAttributeValues: { ':m': '#refresh' },
        ExclusiveStartKey: undefined
      }
    ])
    expect(vi.mocked(GetCommand).mock.calls.map(([input]) => input)).toEqual([
      { TableName: TABLE, Key: { DomainName: '#refresh' }, ConsistentRead: true }
    ])
    expect(puts()).toEqual([])
    const printed = output(log)
    expect(printed).toContain(TABLE)
    expect(printed).toContain('us-east-1')
    expect(printed).toContain('2026-11-24T03:05:00.000Z')
    expect(printed).toContain('2026-11-24T06:00:00.000Z (175 minutes away)')
    expect(printed).toContain('Dry run')
  })

  it('uses the stage table for --env stage', async () => {
    expect(await seedRefreshMarker(['--env', 'stage'], SAFE_NOW, client)).toBe(0)
    expect(vi.mocked(ScanCommand).mock.calls[0][0]).toMatchObject({ TableName: 'okta-hooks-stage-restricted-domains' })
  })

  it('--write puts the exact item only if no marker exists, then reads it back', async () => {
    expect(await seedRefreshMarker(['--env', 'prod', '--write'], SAFE_NOW, client)).toBe(0)

    expect(puts()).toEqual([
      {
        TableName: TABLE,
        Item: {
          DomainName: '#refresh',
          LastSuccessAt: '2026-11-24T03:05:00.000Z',
          DomainCount: 2165,
          SeededBy: 'scripts/seed-refresh-marker.mjs'
        },
        ConditionExpression: 'attribute_not_exists(DomainName)'
      }
    ])
    // One Get before the Put, one consistent read-back after it.
    expect(vi.mocked(GetCommand).mock.calls).toHaveLength(2)
    expect(vi.mocked(GetCommand).mock.calls[1][0]).toEqual({
      TableName: TABLE,
      Key: { DomainName: '#refresh' },
      ConsistentRead: true
    })
    expect(output(log)).toContain('Marker written.')
  })

  it('sums every Scan page into DomainCount', async () => {
    scanPages = [600, 0, 700]
    expect(await seedRefreshMarker(['--env', 'prod', '--write'], SAFE_NOW, client)).toBe(0)

    expect(vi.mocked(ScanCommand).mock.calls.map(([input]) => input.ExclusiveStartKey)).toEqual([
      undefined,
      { page: 1 },
      { page: 2 }
    ])
    expect(puts()[0].Item.DomainCount).toBe(1300)
  })

  it('--write refuses when the next scheduled refresh is under 60 minutes away', async () => {
    expect(await seedRefreshMarker(['--env', 'prod', '--write'], TOO_CLOSE_NOW, client)).toBe(1)

    expect(puts()).toEqual([])
    expect(output(error)).toContain('Refusing to write')
    expect(output(error)).toContain('25 minutes away, under 60')
  })

  it.each([
    ['refuses just under 60 minutes before the next run', '2026-11-24T05:00:00.001Z', 1],
    ['allows exactly 60 minutes before the next run', '2026-11-24T05:00:00.000Z', 0]
  ])('--write %s', async (_label, now, code) => {
    expect(await seedRefreshMarker(['--env', 'prod', '--write'], new Date(now), client)).toBe(code)
    expect(puts()).toHaveLength(code === 0 ? 1 : 0)
  })

  it('--write refuses in the first 5 minutes after a scheduled run', async () => {
    expect(await seedRefreshMarker(['--env', 'prod', '--write'], JUST_AFTER_NOW, client)).toBe(1)

    expect(puts()).toEqual([])
    expect(output(error)).toContain('Refusing to write')
    expect(output(error)).toContain('2026-11-24T03:00:00.000Z started 2 minutes ago, under 5')
  })

  it.each([
    ['refuses at the scheduled run itself', '2026-11-24T03:00:00.000Z', 1],
    ['refuses just under 5 minutes after the run', '2026-11-24T03:04:59.999Z', 1],
    ['allows exactly 5 minutes after the run', '2026-11-24T03:05:00.000Z', 0],
    ['does not treat a non-scheduled hour as a run', '2026-11-24T04:01:00.000Z', 0]
  ])('--write %s', async (_label, now, code) => {
    expect(await seedRefreshMarker(['--env', 'prod', '--write'], new Date(now), client)).toBe(code)
    expect(puts()).toHaveLength(code === 0 ? 1 : 0)
  })

  it.each([
    ['under 60 minutes before the next run', TOO_CLOSE_NOW],
    ['in the first 5 minutes after a run', JUST_AFTER_NOW]
  ])('dry run %s still writes nothing and says --write would be refused', async (_label, now) => {
    expect(await seedRefreshMarker(['--env', 'prod'], now, client)).toBe(0)
    expect(puts()).toEqual([])
    expect(output(log)).toContain('--write would be refused right now')
  })

  it('prints the last scheduled run and how long ago it started', async () => {
    await seedRefreshMarker(['--env', 'prod'], SAFE_NOW, client)
    expect(output(log)).toContain('2026-11-24T03:00:00.000Z (5 minutes ago)')
  })

  it.each([[[]], [['--write']]])('aborts under 1,000 domain rows (extra args %j)', async (extra) => {
    scanPages = [999]
    expect(await seedRefreshMarker(['--env', 'prod', ...extra], SAFE_NOW, client)).toBe(1)

    expect(vi.mocked(GetCommand)).not.toHaveBeenCalled()
    expect(puts()).toEqual([])
    expect(output(error)).toContain('fewer than 1000 domain rows')
  })

  it('does nothing when a marker already exists', async () => {
    marker = { DomainName: '#refresh', LastSuccessAt: '2026-11-24T03:00:41.000Z', DomainCount: 2165 }
    expect(await seedRefreshMarker(['--env', 'prod', '--write'], SAFE_NOW, client)).toBe(0)

    expect(puts()).toEqual([])
    expect(output(log)).toContain('already present; nothing to do')
    expect(output(log)).toContain('2026-11-24T03:00:41.000Z')
  })

  it('treats a failed condition as a marker that appeared meanwhile', async () => {
    const real = { DomainName: '#refresh', LastSuccessAt: '2026-11-24T03:06:00.000Z', DomainCount: 2165 }
    let gets = 0
    mockDynamoDBSend.mockImplementation(async (command: Command) => {
      switch (command._type) {
        case 'ScanCommand':
          return { Count: 2165 }
        case 'GetCommand':
          gets++
          return { Item: gets === 1 ? undefined : real }
        case 'PutCommand':
          throw Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' })
      }
    })

    expect(await seedRefreshMarker(['--env', 'prod', '--write'], SAFE_NOW, client)).toBe(0)
    expect(output(log)).toContain('A marker appeared meanwhile')
    expect(output(log)).toContain('2026-11-24T03:06:00.000Z')
  })

  it.each([
    ['a different value', (item: Item) => ({ ...item, LastSuccessAt: '2026-11-24T03:00:00.000Z' })],
    ['an extra attribute', (item: Item) => ({ ...item, Other: 'x' })],
    ['no item', () => undefined]
  ])('exits 1 when the read-back has %s', async (_label, mangle) => {
    readBack = mangle
    expect(await seedRefreshMarker(['--env', 'prod', '--write'], SAFE_NOW, client)).toBe(1)
    expect(output(error)).toContain('Read-back does not match')
  })

  it('rethrows any other write error', async () => {
    mockDynamoDBSend.mockImplementation(async (command: Command) => {
      switch (command._type) {
        case 'ScanCommand':
          return { Count: 2165 }
        case 'GetCommand':
          return {}
        case 'PutCommand':
          throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' })
      }
    })
    await expect(seedRefreshMarker(['--env', 'prod', '--write'], SAFE_NOW, client)).rejects.toThrow('denied')
  })

  it.each([
    ['no --env', ['--write']],
    ['an unknown --env', ['--env', 'production']],
    ['--table', ['--env', 'prod', '--table', 'other-table']],
    ['a positional argument', ['--env', 'prod', 'write']]
  ])('exits 1 with %s and calls nothing', async (_label, args) => {
    expect(await seedRefreshMarker(args, SAFE_NOW, client)).toBe(1)
    expect(mockDynamoDBSend).not.toHaveBeenCalled()
    expect(output(error)).toContain('Usage:')
  })
})
