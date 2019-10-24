import merge from 'lodash/merge'
import isEmpty from 'lodash/isEmpty'

export const COMMAND_USER_PROFILE_UPDATE = 'com.okta.user.profile.update'
export const COMMAND_ACTION_UPDATE = 'com.okta.action.update'
export const COMMAND_USER_UPDATE = 'com.okta.user.update'

const STATUS_DESCRIPTIONS = {
  200: '200 OK',
  204: '204 No Content',
  500: '500 Internal Server Error'
}

const DEFAULT_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8'
}

class HookResponse {
  constructor (options = {}) {
    const { statusCode = 200, headers = {}, body = {} } = options
    this.statusCode = statusCode
    this.headers = { ...DEFAULT_HEADERS, ...headers }
    this.body = body
    this.commands = []
  }

  addCommand (type, value) {
    this.commands.push({ type, value })
  }

  buildBody () {
    return merge({}, {
      ...(this.commands.length ? { commands: this.commands } : {})
    }, this.body)
  }

  toALBResponse () {
    return {
      statusCode: this.statusCode,
      statusDescription: STATUS_DESCRIPTIONS[this.statusCode],
      isBase64Encoded: false,
      headers: this.headers,
      ...(this.statusCode === 204 ? {} : { body: JSON.stringify(this.buildBody()) })
    }
  }
}

export default HookResponse
