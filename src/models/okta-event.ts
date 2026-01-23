import { get } from 'lodash'
import type { MessageAttributeValue } from '@aws-sdk/client-sns'

interface OktaEventTarget {
  id: string
  type: string
  alternateId?: string
  displayName?: string
}

interface OktaEventActor {
  id: string
  type: string
  alternateId?: string
  displayName?: string
}

interface OktaEventData {
  eventType: string
  target?: OktaEventTarget[]
  actor?: OktaEventActor
  debugContext?: {
    debugData?: {
      changedAttributes?: string
    }
  }
}

interface SNSMessage {
  Message: string
  MessageAttributes: Record<string, MessageAttributeValue>
}

class OktaEvent {
  private event: OktaEventData

  constructor(event: string | OktaEventData) {
    this.event = typeof event === 'string' ? JSON.parse(event) : event
  }

  get eventType(): string {
    return this.event.eventType
  }

  get userId(): string | undefined {
    return get(this.event, 'target.0.id')
  }

  get actorId(): string | undefined {
    return get(this.event, 'actor.id')
  }

  get changedAttributes(): string[] {
    const attrs = get(this.event, 'debugContext.debugData.changedAttributes')
    return attrs ? attrs.split(',') : []
  }

  toJSON(): string {
    return JSON.stringify(this.event)
  }

  toSNSMessage(): SNSMessage {
    return {
      Message: this.toJSON(),
      MessageAttributes: {
        eventType: {
          DataType: 'String',
          StringValue: this.eventType
        }
      }
    }
  }
}

export default OktaEvent
