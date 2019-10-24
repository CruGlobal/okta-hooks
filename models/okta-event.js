import get from 'lodash/get'

class OktaEvent {
  constructor (event) {
    this.event = typeof event === 'string' ? JSON.parse(event) : event
  }

  get eventType () {
    return this.event.eventType
  }

  get userId () {
    return get(this.event, 'target.0.id')
  }

  toJSON () {
    return JSON.stringify(this.event)
  }

  toSNSMessage () {
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
