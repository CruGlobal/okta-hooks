declare module 'global-registry-nodejs-client' {
  interface GRClientOptions {
    baseUrl: string
    accessToken: string
  }

  interface EntityGetOptions {
    entity_type: string
    filters: Record<string, string | undefined>
  }

  interface EntityPostOptions {
    full_response?: boolean
    require_mdm?: boolean
    fields?: string
  }

  interface EntityResponse {
    entity?: Record<string, unknown>
    entities?: Array<Record<string, unknown>>
  }

  interface EntityClient {
    get(options: EntityGetOptions): Promise<EntityResponse>
    post(entity: Record<string, unknown>, options?: EntityPostOptions): Promise<EntityResponse>
    delete(entityId: string): Promise<void>
  }

  export class GRClient {
    constructor(options: GRClientOptions)
    Entity: EntityClient
  }
}
