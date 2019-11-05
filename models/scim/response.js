export const SCHEMA_USER = 'urn:ietf:params:scim:schemas:core:2.0:User'
export const SCHEMA_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse'
export const SCHEMA_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error'
export const SCHEMA_GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group'
export const SCHEMA_BULK_RESPONSE = '"urn:ietf:params:scim:api:messages:2.0:BulkResponse"'
export const SCHEMA_BULK_REQUEST = 'urn:ietf:params:scim:api:messages:2.0:BulkRequest'
export const SCHEMA_CONFIG = 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'

const STATUS_DESCRIPTIONS = {
  200: '200 OK',
  204: '204 No Content',
  500: '500 Internal Server Error'
}

const DEFAULT_HEADERS = {
  'Content-Type': 'application/scim+json; charset=utf-8'
}

class Response {
  constructor (options = {}) {
    const { statusCode = 200, headers = {}, schemas = [] } = options
    this.statusCode = statusCode
    this.headers = { ...DEFAULT_HEADERS, ...headers }
    this.schemas = schemas
    if (options.schema) {
      this.schemas.push(options.schema)
    }
  }

  buildBody () {
    return {
      schemas: this.schemas
    }
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

export default Response
