export const COMMAND_USER_PROFILE_UPDATE = 'com.okta.user.profile.update'
export const COMMAND_ACTION_UPDATE = 'com.okta.action.update'

const STATUS_DESCRIPTIONS = {
  200: '200 OK',
  204: '204 No Content'
}

const DEFAULT_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8'
}

class HookResponse {
  constructor (statusCode = 200, headers = {}) {
    this.statusCode = statusCode
    this.headers = { ...DEFAULT_HEADERS, ...headers }
    this.commands = []
  }

  addCommand (type, value) {
    this.commands.push({ type, value })
  }

  get body () {
    return {
      ...(this.commands.length ? { commands: this.commands } : {})
    }
  }

  toALBResponse () {
    return {
      statusCode: this.statusCode,
      statusDescription: STATUS_DESCRIPTIONS[this.statusCode],
      isBase64Encoded: false,
      headers: this.headers,
      ...(this.statusCode === 204 ? {} : { body: JSON.stringify(this.body) })
    }
  }
}

export default HookResponse
