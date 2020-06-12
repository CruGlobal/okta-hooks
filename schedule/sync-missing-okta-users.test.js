import { handler } from './sync-missing-okta-users'
import { Client, mockListGroupUsers } from '@okta/okta-sdk-nodejs'
import { SNS } from 'aws-sdk'
import rollbar from '../config/rollbar'

jest.mock('../config/rollbar')

describe('sync-missing-okta-users handler', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should do nothing if no missing users in group', async () => {
    mockListGroupUsers.mockResolvedValue([])
    await handler({})
    expect(Client).toHaveBeenCalled()
    expect(mockListGroupUsers).toHaveBeenCalledWith(process.env.OKTA_MISSING_GROUP_ID, { limit: 100 })
    expect(SNS._publishMock).not.toHaveBeenCalled()
  })

  it('should publish `user.account.update_profile` for each user', async () => {
    mockListGroupUsers.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    SNS._publishPromiseMock
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce({})
      .mockResolvedValueOnce({})
    await handler({})
    expect(Client).toHaveBeenCalled()
    expect(mockListGroupUsers).toHaveBeenCalledWith(process.env.OKTA_MISSING_GROUP_ID, { limit: 100 })
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

  it('should send error to rollbar', async () => {
    mockListGroupUsers.mockRejectedValue(new Error('Ohh noes!!'))
    await expect(handler({})).rejects.toThrow('Ohh noes!!')
    expect(rollbar.error).toHaveBeenCalled()
  })
})
