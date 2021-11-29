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

  get actorId () {
    return get(this.event, 'actor.id')
  }

  get changedAttributes () {
    const attrs = get(this.event, 'debugContext.debugData.changedAttributes')
    return attrs ? attrs.split(',') : /* istanbul ignore next */ []
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
