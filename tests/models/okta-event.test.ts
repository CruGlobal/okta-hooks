import { describe, it, expect } from 'vitest'
import OktaEvent from '@/models/okta-event.js'

describe('OktaEvent', () => {
  describe('changedAttributes', () => {
    it('should return empty array when no changedAttributes', () => {
      const event = new OktaEvent({
        eventType: 'user.account.update_profile',
        target: [{ id: 'user123', type: 'User' }]
      })
      expect(event.changedAttributes).toEqual([])
    })

    it('should parse changedAttributes from debugContext', () => {
      const event = new OktaEvent({
        eventType: 'user.account.update_profile',
        target: [{ id: 'user123', type: 'User' }],
        debugContext: {
          debugData: {
            changedAttributes: 'firstName,lastName,email'
          }
        }
      })
      expect(event.changedAttributes).toEqual(['firstName', 'lastName', 'email'])
    })
  })

  describe('constructor', () => {
    it('should parse JSON string', () => {
      const eventData = {
        eventType: 'user.lifecycle.create',
        target: [{ id: 'user456', type: 'User' }],
        actor: { id: 'actor789', type: 'SystemPrincipal' }
      }
      const event = new OktaEvent(JSON.stringify(eventData))
      expect(event.eventType).toBe('user.lifecycle.create')
      expect(event.userId).toBe('user456')
      expect(event.actorId).toBe('actor789')
    })
  })

  describe('toSNSMessage', () => {
    it('should return SNS message format', () => {
      const event = new OktaEvent({
        eventType: 'user.lifecycle.create',
        target: [{ id: 'user123', type: 'User' }]
      })
      const snsMessage = event.toSNSMessage()
      expect(snsMessage).toEqual({
        Message: JSON.stringify({
          eventType: 'user.lifecycle.create',
          target: [{ id: 'user123', type: 'User' }]
        }),
        MessageAttributes: {
          eventType: {
            DataType: 'String',
            StringValue: 'user.lifecycle.create'
          }
        }
      })
    })
  })
})
