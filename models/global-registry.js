import { GRClient } from 'global-registry-nodejs-client'
import endsWith from 'lodash/endsWith'
import startsWith from 'lodash/startsWith'
import get from 'lodash/get'
import find from 'lodash/find'
import equalsIgnoreCase from '../utils/equals-ignore-case'

export const PERSON_DESIGNATION_ENTITY_TYPE = 'person_person_designation_designation'
export const CLIENT_INTEGRATION_ID = 'client_integration_id'

class GlobalRegistry {
  constructor (accessToken, baseUrl) {
    this.client = new GRClient({ baseUrl, accessToken })
  }

  async createOrUpdateProfile (profile) {
    const personEntity = await this.buildPersonEntity(profile)

    await this.deleteDesignationRelationshipIfNecessary(profile)

    const result = await this.client.Entity.post({ person: personEntity }, {
      require_mdm: true,
      fields: 'master_person:relationship'
    })

    const personId = get(result, 'entity.person.id')
    const masterPersonId = get(result, 'entity.person.master_person:relationship.master_person')
    if (!equalsIgnoreCase(personId, profile.thekeyGrPersonId) || !equalsIgnoreCase(masterPersonId, profile.grMasterPersonId)) {
      profile.thekeyGrPersonId = personId
      profile.grMasterPersonId = masterPersonId
      return true
    }
    return false
  }

  async findOrCreateDesignationEntity (designationNumber) {
    if (designationNumber) {
      const result = await this.client.Entity.post({
        designation: {
          designation_number: designationNumber,
          client_integration_id: designationNumber
        }
      })
      return get(result, 'entity.designation.id')
    }
  }

  async buildPersonEntity (profile) {
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
      ...(profile.usEmployeeId && !this.isProbablyTestAccount(profile.login) ? {
        account_number: profile.usEmployeeId,
        linked_identities: {
          pshr: { account_number: profile.usEmployeeId },
          siebel: { account_number: profile.usEmployeeId }
        }
      } : {
        account_number: null
      }),
      ...(designationEntityId ? {
        'designation:relationship': {
          designation: designationEntityId,
          client_integration_id: profile.theKeyGuid
        }
      } : {})
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
  async deleteDesignationRelationshipIfNecessary (profile) {
    const relationshipEntity = await this.getDesignationRelationshipEntity(profile.theKeyGuid)
    if (relationshipEntity) {
      const grDesignationNumber = get(relationshipEntity, 'designation.designation_number')
      const currentAssociatedPersonId = get(relationshipEntity, 'person.id')
      const theKeyPersonId = profile.thekeyGrPersonId

      const shouldDelete =
        /* the designation number changed */
        !equalsIgnoreCase(grDesignationNumber, profile.usDesignationNumber) ||
        /* the person entity was recently deleted or doesn't exist yet */
        !theKeyPersonId ||
        /* the person entity doesn't match */
        !equalsIgnoreCase(theKeyPersonId, currentAssociatedPersonId)

      if (shouldDelete) {
        await this.deleteRelationshipEntity(relationshipEntity.id)
      }
    }
  }

  async getDesignationRelationshipEntity (theKeyGuid) {
    const result = await this.client.Entity.get({
      entity_type: PERSON_DESIGNATION_ENTITY_TYPE,
      filters: { owned_by: 'the_key', [CLIENT_INTEGRATION_ID]: theKeyGuid }
    })
    /* istanbul ignore else */
    if (result.entities) {
      const entity = find(result.entities,
        obj => equalsIgnoreCase(get(obj, `${PERSON_DESIGNATION_ENTITY_TYPE}.${CLIENT_INTEGRATION_ID}`), theKeyGuid))
      return get(entity, PERSON_DESIGNATION_ENTITY_TYPE)
    }
  }

  async deleteRelationshipEntity (relationshipEntityId) {
    await this.client.Entity.delete(relationshipEntityId)
  }

  isProbablyTestAccount (email) {
    if (!email || typeof email !== 'string') {
      return true
    }
    return startsWith(email, 'test.') ||
      email.indexOf('.test.') !== -1 ||
      endsWith(email, '@example.com') ||
      endsWith(email, '@crutest.org') ||
      endsWith(email, '@test.com') ||
      endsWith(email, '@test.cru.org')
  }
}

export default GlobalRegistry
