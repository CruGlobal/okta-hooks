import { GRClient } from 'global-registry-nodejs-client'
import { endsWith, startsWith, get, find } from 'lodash'
import equalsIgnoreCase from '../utils/equals-ignore-case.js'

export const PERSON_ENTITY_TYPE = 'person'
export const PERSON_DESIGNATION_ENTITY_TYPE = 'person_person_designation_designation'
export const THE_KEY_SYSYEM = 'the_key'
export const PSHR_SYSTEM = 'pshr'
export const SIEBEL_SYSTEM = 'siebel'

interface OktaUserProfile {
  theKeyGuid: string
  login: string
  firstName: string
  lastName: string
  email?: string
  usDesignationNumber?: string
  usEmployeeId?: string
  thekeyGrPersonId?: string | null
  grMasterPersonId?: string | null
}

interface DesignationRelationshipEntity {
  id: string
  person?: { id: string }
  designation?: { designation_number: string }
  client_integration_id: string
}

class GlobalRegistry {
  private client: GRClient

  constructor(accessToken: string, baseUrl: string) {
    this.client = new GRClient({ baseUrl, accessToken })
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
    const masterPersonRelationship = get(result, 'entity.person.master_person:relationship')
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
            linked_identities: {
              [PSHR_SYSTEM]: { account_number: profile.usEmployeeId },
              [SIEBEL_SYSTEM]: { account_number: profile.usEmployeeId }
            }
          }
        : {
            account_number: null
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
