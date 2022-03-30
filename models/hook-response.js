import merge from 'lodash/merge'

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

const DEFAULTS_ERROR = {
  locationType: 'body',
  location: 'data.userProfile.login',
  domain: 'end-user'
}

class HookResponse {
  constructor (options = {}) {
    const { statusCode = 200, headers = {}, body = {} } = options
    this.statusCode = statusCode
    this.headers = { ...DEFAULT_HEADERS, ...headers }
    this.body = body
    this.commands = []
    this.errors = []
  }

  addCommand (type, value) {
    this.commands.push({ type, value })
  }

  addError ({ errorSummary, reason, ...others }) {
    this.errors.push({ ...DEFAULTS_ERROR, errorSummary, reason, ...others })
  }

  buildBody () {
    return merge({}, {
      ...(this.commands.length ? { commands: this.commands } : {}),
      ...(this.errors.length
        ? {
            error: {
              errorSummary: 'Errors were found in the user profile',
              errorCauses: this.errors
            }
          }
        : {})
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
