import { merge } from 'lodash'
import type { ALBResult } from 'aws-lambda'

export const COMMAND_USER_PROFILE_UPDATE = 'com.okta.user.profile.update' as const
export const COMMAND_ACTION_UPDATE = 'com.okta.action.update' as const
export const COMMAND_USER_UPDATE = 'com.okta.user.update' as const

type CommandType =
  | typeof COMMAND_USER_PROFILE_UPDATE
  | typeof COMMAND_ACTION_UPDATE
  | typeof COMMAND_USER_UPDATE

interface HookCommand {
  type: CommandType
  value: Record<string, unknown>
}

interface HookError {
  locationType: string
  location: string
  domain: string
  errorSummary: string
  reason: string
}

interface HookResponseOptions {
  statusCode?: number
  headers?: Record<string, string>
  body?: Record<string, unknown>
}

const STATUS_DESCRIPTIONS: Record<number, string> = {
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
  private statusCode: number
  private headers: Record<string, string>
  private body: Record<string, unknown>
  private commands: HookCommand[]
  private errors: HookError[]

  constructor(options: HookResponseOptions = {}) {
    const { statusCode = 200, headers = {}, body = {} } = options
    this.statusCode = statusCode
    this.headers = { ...DEFAULT_HEADERS, ...headers }
    this.body = body
    this.commands = []
    this.errors = []
  }

  addCommand(type: CommandType, value: Record<string, unknown>): void {
    this.commands.push({ type, value })
  }

  addError({
    errorSummary,
    reason,
    ...others
  }: Omit<HookError, 'locationType' | 'location' | 'domain'> &
    Partial<Pick<HookError, 'locationType' | 'location' | 'domain'>>): void {
    this.errors.push({ ...DEFAULTS_ERROR, errorSummary, reason, ...others })
  }

  private buildBody(): Record<string, unknown> {
    return merge(
      {},
      {
        ...(this.commands.length ? { commands: this.commands } : {}),
        ...(this.errors.length
          ? {
              error: {
                errorSummary: 'Errors were found in the user profile',
                errorCauses: this.errors
              }
            }
          : {})
      },
      this.body
    )
  }

  toALBResponse(): ALBResult {
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
