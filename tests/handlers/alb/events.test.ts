import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handler } from '@/handlers/alb/events.js'
import rollbar from '@/config/rollbar.js'
import { mockSNSSend, PublishCommand } from '../../mocks/aws-sdk-v3.js'

import created from '../../fixtures/alb/event-user-lifecycle-create.json'
import deleted from '../../fixtures/alb/event-user-lifecycle-delete.json'
import updated from '../../fixtures/alb/event-user-update-profile.json'

vi.mock('@/config/rollbar.js')
vi.mock('@aws-sdk/client-sns', async () => {
  const mock = await import('../../mocks/aws-sdk-v3.js')
  return { SNSClient: mock.SNSClient, PublishCommand: mock.PublishCommand }
})

describe('events hook', () => {
  const originalBlockList = process.env.OKTA_ACTOR_ID_BLOCK_LIST

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.OKTA_ACTOR_ID_BLOCK_LIST = originalBlockList
  })

  it('should forward event to SNS', async () => {
    mockSNSSend.mockResolvedValue({})
    const response = await handler(created as any)
    expect(response).toStrictEqual({
      statusCode: 204,
      statusDescription: '204 No Content',
      isBase64Encoded: false,
      headers: {
        'Content-Type': 'application/json; charset=utf-8'
      }
    })
    const event = JSON.parse(created.body).data.events[0]
    expect(PublishCommand).toHaveBeenCalledWith({
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

  it('should skip events from bad actors', async () => {
    mockSNSSend.mockResolvedValue({})
    const response = await handler(updated as any)
    expect(response).toStrictEqual({
      statusCode: 204,
      statusDescription: '204 No Content',
      isBase64Encoded: false,
      headers: {
        'Content-Type': 'application/json; charset=utf-8'
      }
    })
    expect(mockSNSSend).not.toBeCalled()
  })

  it('should respond with 500 on an error', async () => {
    mockSNSSend.mockRejectedValue(new Error('Ohh noes!!'))
    const response = await handler(deleted as any)
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
    expect(PublishCommand).toHaveBeenCalledWith({
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

  it('should handle undefined block list', async () => {
    delete process.env.OKTA_ACTOR_ID_BLOCK_LIST
    mockSNSSend.mockResolvedValue({})
    const response = await handler(created as any)
    expect(response).toStrictEqual({
      statusCode: 204,
      statusDescription: '204 No Content',
      isBase64Encoded: false,
      headers: {
        'Content-Type': 'application/json; charset=utf-8'
      }
    })
    expect(mockSNSSend).toHaveBeenCalled()
  })

  it('should handle null body gracefully', async () => {
    mockSNSSend.mockResolvedValue({})
    const eventWithNullBody = { ...created, body: null }
    const response = await handler(eventWithNullBody as any)
    expect(response).toStrictEqual({
      statusCode: 500,
      statusDescription: '500 Internal Server Error',
      isBase64Encoded: false,
      headers: {
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: '{}'
    })
    expect(rollbar.error).toHaveBeenCalled()
  })
})
