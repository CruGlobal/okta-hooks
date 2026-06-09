import { GRClient } from 'global-registry-nodejs-client'
import { endsWith, startsWith, get, find } from 'lodash'
import equalsIgnoreCase from '../utils/equals-ignore-case.js'
import type { OktaUserProfile } from '../types/okta.js'
import type { Client } from '@okta/okta-sdk-nodejs'

export const PERSON_ENTITY_TYPE = 'person'
export const PERSON_DESIGNATION_ENTITY_TYPE = 'person_person_designation_designation'
export const THE_KEY_SYSYEM = 'the_key'
export const PSHR_SYSTEM = 'pshr'
export const SIEBEL_SYSTEM = 'siebel'
export const HCM_SYSTEM = 'hcm'

interface DesignationRelationshipEntity {
  id: string
  person?: { id: string }
  designation?: { designation_number: string }
  client_integration_id: string
}

class GlobalRegistry {
  private client: GRClient
  private okta?: Client

  constructor(accessToken: string, baseUrl: string, okta?: Client) {
    this.client = new GRClient({ baseUrl, accessToken })
    this.okta = okta
  }

  async createOrUpdateProfile(profile: OktaUserProfile): Promise<boolean> {
    const personEntity = await this.buildPersonEntity(profile)

    await this.deleteDesignationRelationshipIfNecessary(profile)

    const result = await this.client.Entity.post(
      { [PERSON_ENTITY_TYPE]: personEntity },
      {
        full_response: true,
        require_mdm: true,
        fields: 'master_person:relationship'
      }
    )

    const personId = get(result, 'entity.person.id') as string | undefined
    const masterPersonRelationship = get(result, 'entity.person.master_person:relationship') as
      | { master_person?: string }
      | { master_person?: string }[]
      | undefined
    const masterPersonId = (
      Array.isArray(masterPersonRelationship)
        ? masterPersonRelationship[0]?.master_person
        : masterPersonRelationship?.master_person
    ) as string | undefined
    if (
      !equalsIgnoreCase(personId, profile.thekeyGrPersonId) ||
      !equalsIgnoreCase(masterPersonId, profile.grMasterPersonId)
    ) {
      profile.thekeyGrPersonId = personId
      profile.grMasterPersonId = masterPersonId
      return true
    }
    return false
  }

  async deleteProfile(profile: OktaUserProfile): Promise<boolean> {
    const response = await this.client.Entity.get({
      entity_type: PERSON_ENTITY_TYPE,
      filters: {
        owned_by: THE_KEY_SYSYEM,
        client_integration_id: profile.theKeyGuid
      }
    })
    // remove user(s) from the GR since the account is deactivated
    await Promise.all(
      (response.entities ?? [])
        .filter((entity) => get(entity, 'person.id'))
        .map((entity) => this.client.Entity.delete(get(entity, 'person.id') as string))
    )

    // delete any potentially orphaned entities or relationships
    await this.deleteDesignationRelationshipIfNecessary(profile, true)

    // remove stored person and master_person ids and signal profile has changed
    profile.thekeyGrPersonId = null
    profile.grMasterPersonId = null
    return true
  }

  async findOrCreateDesignationEntity(designationNumber?: string): Promise<string | undefined> {
    if (designationNumber) {
      const result = await this.client.Entity.post({
        designation: {
          designation_number: designationNumber,
          client_integration_id: designationNumber
        }
      })
      return get(result, 'entity.designation.id') as string | undefined
    }
  }

  async buildPersonEntity(profile: OktaUserProfile): Promise<Record<string, unknown>> {
    const designationEntityId = await this.findOrCreateDesignationEntity(profile.usDesignationNumber)
    return {
      client_integration_id: profile.theKeyGuid,
      key_username: profile.login,
      first_name: profile.firstName,
      last_name: profile.lastName,
      email_address: {
        client_integration_id: profile.theKeyGuid,
        email: profile.login
      },
      authentication: {
        client_integration_id: profile.theKeyGuid,
        key_guid: profile.theKeyGuid
      },
      ...(profile.usEmployeeId && !this.isProbablyTestAccount(profile.login)
        ? {
            account_number: profile.usEmployeeId,
            hcm_person_number: profile.usEmployeeId,
            linked_identities: {
              [HCM_SYSTEM]: { hcm_person_number: profile.usEmployeeId },
              [PSHR_SYSTEM]: { account_number: profile.usEmployeeId },
              [SIEBEL_SYSTEM]: { account_number: profile.usEmployeeId }
            }
          }
        : {
            account_number: null,
            hcm_person_number: null
          }),
      ...(designationEntityId
        ? {
            'designation:relationship': {
              designation: designationEntityId,
              client_integration_id: profile.theKeyGuid
            }
          }
        : {})
    }
  }

  /**
   * If the user's designation has changed since last time, we need to delete the old relationship.
   * Also, if the relationship is associated with the wrong Key person, we delete it as well.
   * (Otherwise, we'll get a client_integration_id collision later on.)
   * Mainly this will happen if the previous step deleted The Key's person entity,
   * in which case the given user's GR person id must be null.
   * In Stage, this can also happen if a previous sync deleted the Key person but not the relationship.
   * (A faulty sync was deployed & run that didn't perform this relationship cleanup step.)
   * In this case, the given user's GR person id is not null, but it does not match the relationship's person id.
   */
  async deleteDesignationRelationshipIfNecessary(
    profile: OktaUserProfile,
    deactivated = false
  ): Promise<void> {
    const relationshipEntity = await this.getDesignationRelationshipEntity(profile.theKeyGuid)
    if (relationshipEntity) {
      const grDesignationNumber = get(relationshipEntity, 'designation.designation_number') as
        | string
        | undefined
      const currentAssociatedPersonId = get(relationshipEntity, 'person.id') as string | undefined
      const theKeyPersonId = profile.thekeyGrPersonId

      const shouldDelete =
        // the user is deactivated
        deactivated ||
        // the designation number changed
        !equalsIgnoreCase(grDesignationNumber, profile.usDesignationNumber) ||
        // the person entity was recently deleted or doesn't exist yet
        !theKeyPersonId ||
        // the person entity doesn't match
        !equalsIgnoreCase(theKeyPersonId, currentAssociatedPersonId)

      if (shouldDelete) {
        await this.deleteRelationshipEntity(relationshipEntity.id)
      }
    }
  }

  async getDesignationRelationshipEntity(
    theKeyGuid: string
  ): Promise<DesignationRelationshipEntity | undefined> {
    const result = await this.client.Entity.get({
      entity_type: PERSON_DESIGNATION_ENTITY_TYPE,
      filters: { owned_by: THE_KEY_SYSYEM, client_integration_id: theKeyGuid }
    })
    if (result.entities) {
      const entity = find(result.entities, (obj) =>
        equalsIgnoreCase(
          get(obj, `${PERSON_DESIGNATION_ENTITY_TYPE}.client_integration_id`),
          theKeyGuid
        )
      )
      return get(entity, PERSON_DESIGNATION_ENTITY_TYPE) as DesignationRelationshipEntity | undefined
    }
  }

  async deleteRelationshipEntity(relationshipEntityId: string): Promise<void> {
    await this.client.Entity.delete(relationshipEntityId)
  }

  async releaseAccountNumber(entity: Record<string, unknown>): Promise<void> {
    const personId = get(entity, 'person.id') as string
    // PUT /entities/:id updates the loaded person with update-time validations and
    // partial reconciliation; a null value destroys that field's value-entity.
    await this.client.Entity.put(personId, {
      account_number: null,
      hcm_person_number: null
    })
  }

  isFieldNotDefinedError(error: unknown): boolean {
    const err = error as { statusCode?: number; error?: unknown; message?: string }
    if (err?.statusCode !== 400) {
      return false
    }
    const haystack = `${JSON.stringify(err.error ?? '')} ${err.message ?? ''}`
    return haystack.includes("can't find entity type named")
  }

  async findConflictCandidates(
    identifierFilter: Record<string, string>,
    fields: string
  ): Promise<Array<Record<string, unknown>>> {
    try {
      const result = await this.client.Entity.get({
        entity_type: PERSON_ENTITY_TYPE,
        filters: { owned_by: THE_KEY_SYSYEM, ...identifierFilter },
        fields
      })
      return result.entities ?? []
    } catch (error) {
      // During the PSHR->HCM transition a filter field may not be defined on the person
      // type in a given environment; GR returns a 400 in that case. Treat that single
      // field's query as "no candidates" and let the other query proceed.
      if (this.isFieldNotDefinedError(error)) {
        return []
      }
      throw error
    }
  }

  emailAddresses(entity: Record<string, unknown>): string[] {
    const emailAddress = get(entity, 'person.email_address')
    const list = Array.isArray(emailAddress) ? emailAddress : [emailAddress]
    return list
      .map((item) => get(item, 'email'))
      .filter((email): email is string => typeof email === 'string')
  }

  isAccountNumberConflict(entity: Record<string, unknown>, profile: OktaUserProfile): boolean {
    const accountNumber = get(entity, 'person.account_number')
    const hcmPersonNumber = get(entity, 'person.hcm_person_number')
    const clientIntegrationId = get(entity, 'person.client_integration_id')

    // Authoritative match: actually holds this employee number in either identifier field.
    const numberMatches =
      equalsIgnoreCase(accountNumber, profile.usEmployeeId) ||
      equalsIgnoreCase(hcmPersonNumber, profile.usEmployeeId)
    if (!numberMatches) {
      return false
    }
    // Never the account currently being saved.
    if (equalsIgnoreCase(clientIntegrationId, profile.theKeyGuid)) {
      return false
    }
    // A different account: none of its emails equal the saving Cru login.
    return !this.emailAddresses(entity).some((email) => equalsIgnoreCase(email, profile.login))
  }

  isProbablyTestAccount(email: string | undefined): boolean {
    if (!email || typeof email !== 'string') {
      return true
    }
    return (
      startsWith(email, 'test.') ||
      email.indexOf('.test.') !== -1 ||
      endsWith(email, '@example.com') ||
      endsWith(email, '@crutest.org') ||
      endsWith(email, '@test.com') ||
      endsWith(email, '@test.cru.org')
    )
  }
}

export default GlobalRegistry
