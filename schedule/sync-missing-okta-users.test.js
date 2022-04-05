import { handler } from './sync-missing-okta-users'
import { Client, mockListGroupUsers, setUsers } from '@okta/okta-sdk-nodejs'
import { SNS } from 'aws-sdk'
import rollbar from '../config/rollbar'

jest.mock('../config/rollbar')

describe('sync-missing-okta-users handler', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should do nothing if no missing users in group', async () => {
    setUsers([])
    await handler({})
    expect(Client).toHaveBeenCalled()
    expect(mockListGroupUsers).toHaveBeenCalledWith(process.env.OKTA_MISSING_GROUP_ID, { limit: 25 })
    expect(SNS._publishMock).not.toHaveBeenCalled()
  })

  it('should publish `user.account.update_profile` for each user', async () => {
    setUsers([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    SNS._publishPromiseMock
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce({})
      .mockResolvedValueOnce({})
    await handler({})
    expect(Client).toHaveBeenCalled()
    expect(mockListGroupUsers).toHaveBeenCalledWith(process.env.OKTA_MISSING_GROUP_ID, { limit: 25 })
    expect(SNS._publishMock).toHaveBeenCalledTimes(3)
    expect(SNS._publishMock.mock.calls[0][0]).toEqual({
      TargetArn: 'sns_okta_target_arn',
      Message: '{"eventType":"user.account.update_profile","target":[{"id":"a"}],"debugContext":{"debugData":{"changedAttributes":"Notes"}}}',
      MessageAttributes: {
        eventType: {
          DataType: 'String',
          StringValue: 'user.account.update_profile'
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
    SNS._publishPromiseMock.mockResolvedValue({})
    await handler({})
    expect(mockListGroupUsers).toHaveBeenCalledWith(process.env.OKTA_MISSING_GROUP_ID, { limit: 25 })
    expect(SNS._publishMock).toHaveBeenCalledTimes(100)
  })

  it('should send error to rollbar', async () => {
    mockListGroupUsers.mockImplementation(() => ({
      each: jest.fn().mockRejectedValue(new Error('Ohh noes!!'))
    }))
    await expect(handler({})).rejects.toThrow('Ohh noes!!')
    expect(rollbar.error).toHaveBeenCalled()
  })
})
