import OktaEvent from './okta-event.js'

interface OktaRequestData {
  data: {
    events: unknown[]
  }
}

class OktaRequest {
  events: OktaEvent[]

  constructor(json: string) {
    const { data } = JSON.parse(json) as OktaRequestData
    this.events = data.events.map((event) => new OktaEvent(event as string))
  }
}

export default OktaRequest
