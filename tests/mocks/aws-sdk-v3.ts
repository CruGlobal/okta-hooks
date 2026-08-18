import { vi } from 'vitest'

// SNS Client mock
export const mockSNSSend = vi.fn()
export const SNSClient = vi.fn().mockImplementation(() => ({
  send: mockSNSSend
}))

// Command mocks (these are just markers to identify which command was called)
export const PublishCommand = vi.fn().mockImplementation((input) => ({ _type: 'PublishCommand', input }))
