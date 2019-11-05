import Response, { SCHEMA_LIST } from './response'

class GroupsResponse extends Response {
  constructor () {
    super({ schema: SCHEMA_LIST })
  }

  buildBody () {
    return {
      ...super.buildBody(),
      totalResults: 0
    }
  }
}

export default GroupsResponse
