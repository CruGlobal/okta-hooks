import { handler } from './events'
import { SNS } from 'aws-sdk'
import rollbar from '../../config/rollbar'

jest.mock('../../config/rollbar')

const created = require('../../tests/fixtures/alb/event-user-lifecycle-create.json')
const deleted = require('../../tests/fixtures/alb/event-user-lifecycle-delete.json')

describe('events hook', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should forward event to SNS', async () => {
    SNS._publishPromiseMock.mockResolvedValue({})
    const response = await handler(created)
    expect(response).toStrictEqual({
      statusCode: 204,
      statusDescription: '204 No Content',
      isBase64Encoded: false,
      headers: {
        'Content-Type': 'application/json; charset=utf-8'
      }
    })
    const event = JSON.parse(created.body).data.events[0]
    expect(SNS._publishMock).toHaveBeenCalledWith({
      TargetArn: 'sns_okta_target_arn',
      Message: JSON.stringify(event),
      MessageAttributes: {
        eventType: {
          DataType: 'String',
          StringValue: 'user.lifecycle.create'
        }
      }
    })
  })

  it('should respond with 500 on an error', async () => {
    SNS._publishPromiseMock.mockRejectedValue(new Error('Ohh noes!!'))
    const response = await handler(deleted)
    expect(response).toStrictEqual({
      statusCode: 500,
      statusDescription: '500 Internal Server Error',
      isBase64Encoded: false,
      headers: {
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: '{}'
    })
    expect(rollbar.error).toHaveBeenCalledWith('events hook Error', expect.any(Error), { lambdaEvent: deleted })
    const event = JSON.parse(deleted.body).data.events[0]
    expect(SNS._publishMock).toHaveBeenCalledWith({
      TargetArn: 'sns_okta_target_arn',
      Message: JSON.stringify(event),
      MessageAttributes: {
        eventType: {
          DataType: 'String',
          StringValue: 'user.lifecycle.delete.initiated'
        }
      }
    })
  })
})
