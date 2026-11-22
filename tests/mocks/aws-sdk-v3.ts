import { vi } from 'vitest'

// SNS Client mock
export const mockSNSSend = vi.fn()
export const SNSClient = vi.fn().mockImplementation(function () {
  return { send: mockSNSSend }
})

// DynamoDB DocumentClient mock. Every document client shares one send mock. Each
// keeps the client it wraps, so a test can read the config behind a call from
// mockDynamoDBSend.mock.contexts.
export const mockDynamoDBSend = vi.fn()
export const DynamoDBClient = vi.fn().mockImplementation(function (this: { config: unknown }, config: unknown) {
  this.config = config
})
export const DynamoDBDocumentClient = {
  from: vi.fn().mockImplementation((client: unknown) => ({
    client,
    send: mockDynamoDBSend
  }))
}

// Command mocks (these are just markers to identify which command was called)
export const PublishCommand = vi.fn().mockImplementation(function (input) { return { _type: 'PublishCommand', input } })
export const GetCommand = vi.fn().mockImplementation(function (input) { return { _type: 'GetCommand', input } })
export const ScanCommand = vi.fn().mockImplementation(function (input) { return { _type: 'ScanCommand', input } })
export const BatchWriteCommand = vi.fn().mockImplementation(function (input) { return { _type: 'BatchWriteCommand', input } })
