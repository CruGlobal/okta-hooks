import OktaEvent from './okta-event'

class OktaRequest {
  constructor (json) {
    const { data } = JSON.parse(json)
    this.events = data.events.map(event => new OktaEvent(event))
  }
}

export default OktaRequest
