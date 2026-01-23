import { vi } from 'vitest'

// SNS Client mock
export const mockSNSSend = vi.fn()
export const SNSClient = vi.fn().mockImplementation(() => ({
  send: mockSNSSend
}))

// DynamoDB DocumentClient mock
export const mockDynamoDBSend = vi.fn()
export const DynamoDBClient = vi.fn()
export const DynamoDBDocumentClient = {
  from: vi.fn().mockImplementation(() => ({
    send: mockDynamoDBSend
  }))
}

// Command mocks (these are just markers to identify which command was called)
export const PublishCommand = vi.fn().mockImplementation((input) => ({ _type: 'PublishCommand', input }))
export const GetCommand = vi.fn().mockImplementation((input) => ({ _type: 'GetCommand', input }))
export const ScanCommand = vi.fn().mockImplementation((input) => ({ _type: 'ScanCommand', input }))
export const BatchWriteCommand = vi.fn().mockImplementation((input) => ({ _type: 'BatchWriteCommand', input }))
