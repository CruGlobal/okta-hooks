import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handler } from '@/handlers/schedule/sync-missing-okta-users.js'
import { Client, mockListGroupUsers, setUsers } from '../../mocks/okta-sdk-nodejs.js'
import { mockSNSSend, PublishCommand } from '../../mocks/aws-sdk-v3.js'
import rollbar from '@/config/rollbar.js'

vi.mock('@/config/rollbar.js')
vi.mock('@okta/okta-sdk-nodejs', async () => {
  const mock = await import('../../mocks/okta-sdk-nodejs.js')
  return {
    Client: mock.Client,
    mockListGroupUsers: mock.mockListGroupUsers,
    setUsers: mock.setUsers
  }
})
vi.mock('@aws-sdk/client-sns', async () => {
  const mock = await import('../../mocks/aws-sdk-v3.js')
  return { SNSClient: mock.SNSClient, PublishCommand: mock.PublishCommand }
})

describe('sync-missing-okta-users handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should do nothing if no missing users in group', async () => {
    setUsers([])
    await handler({} as any)
    expect(Client).toHaveBeenCalled()
    expect(mockListGroupUsers).toHaveBeenCalledWith({ groupId: process.env.OKTA_MISSING_GROUP_ID, limit: 25 })
    expect(mockSNSSend).not.toHaveBeenCalled()
  })

  it('should publish `user.lifecycle.create` for each user', async () => {
    setUsers([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    mockSNSSend
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce({})
      .mockResolvedValueOnce({})
    await handler({} as any)
    expect(Client).toHaveBeenCalled()
    expect(mockListGroupUsers).toHaveBeenCalledWith({ groupId: process.env.OKTA_MISSING_GROUP_ID, limit: 25 })
    expect(mockSNSSend).toHaveBeenCalledTimes(3)
    expect(PublishCommand).toHaveBeenCalledWith({
      TargetArn: 'sns_okta_target_arn',
      Message: '{"eventType":"user.lifecycle.create","target":[{"id":"a"}]}',
      MessageAttributes: {
        eventType: {
          DataType: 'String',
          StringValue: 'user.lifecycle.create'
        }
      }
    })
  })

  it('should only publish a max of 100 users', async () => {
    const users = []
    for (let i = 0; i < 150; i++) {
      users.push({ id: `${i}` })
    }
    setUsers(users)
    mockSNSSend.mockResolvedValue({})
    await handler({} as any)
    expect(mockListGroupUsers).toHaveBeenCalledWith({ groupId: process.env.OKTA_MISSING_GROUP_ID, limit: 25 })
    expect(mockSNSSend).toHaveBeenCalledTimes(100)
  })

  it('should send error to rollbar', async () => {
    mockListGroupUsers.mockImplementation(() => ({
      each: vi.fn().mockRejectedValue(new Error('Ohh noes!!'))
    }))
    await expect(handler({} as any)).rejects.toThrow('Ohh noes!!')
    expect(rollbar.error).toHaveBeenCalled()
  })
})
