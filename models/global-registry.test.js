import GlobalRegistry, { PERSON_DESIGNATION_ENTITY_TYPE } from './global-registry'
import { GRClient, mockEntityGET, mockEntityDELETE, mockEntityPOST } from 'global-registry-nodejs-client'
import uuid from 'uuid/v4'

describe('GlobalRegistry', () => {
  let globalRegistry
  beforeEach(() => {
    jest.clearAllMocks()
    globalRegistry = new GlobalRegistry('token', 'https://example.com')
  })

  describe('constructor()', () => {
    it('should instantiate a new instance', () => {
      expect(globalRegistry.client).toBeDefined()
      expect(GRClient).toHaveBeenCalledWith({ accessToken: 'token', baseUrl: 'https://example.com' })
    })
  })

  describe('isProbablyTestAccount( email )', () => {
    it('should return if email is probably not a test account', () => {
      expect(globalRegistry.isProbablyTestAccount('tony.stark@avengers.org')).toBeFalsy()
      expect(globalRegistry.isProbablyTestAccount()).toBeTruthy()
      expect(globalRegistry.isProbablyTestAccount(null)).toBeTruthy()
      expect(globalRegistry.isProbablyTestAccount('test.account@ccci.org')).toBeTruthy()
      expect(globalRegistry.isProbablyTestAccount('account@example.test.com')).toBeTruthy()
      expect(globalRegistry.isProbablyTestAccount('my.test.account@avengers.org')).toBeTruthy()
      expect(globalRegistry.isProbablyTestAccount('test.account@avengers.org')).toBeTruthy()
      expect(globalRegistry.isProbablyTestAccount('account@crutest.org')).toBeTruthy()
      expect(globalRegistry.isProbablyTestAccount('account@example.com')).toBeTruthy()
      expect(globalRegistry.isProbablyTestAccount('account@test.cru.org')).toBeTruthy()
    })
  })

  describe('deleteRelationshipEntity( relationshipId )', () => {
    it('should delete the relationship from Global Registry', async () => {
      const relationshipEntityId = uuid()
      await globalRegistry.deleteRelationshipEntity(relationshipEntityId)
      expect(mockEntityDELETE).toHaveBeenCalledWith(relationshipEntityId)
    })
  })

  describe('getDesignationRelationshipEntity (theKeyGuid)', () => {
    it('should return designation entity', async () => {
      const theKeyGuid = uuid()
      const entity = {
        person: { client_integration_id: theKeyGuid },
        designation: { designation_number: '0123456', client_integration_id: '0123456' },
        client_integration_id: theKeyGuid
      }
      mockEntityGET.mockResolvedValue({
        entities: [
          { person_person_designation_designation: { client_integration_id: uuid() } },
          { person_person_designation_designation: entity }
        ]
      })
      const designationEntity = await globalRegistry.getDesignationRelationshipEntity(theKeyGuid)
      expect(mockEntityGET).toHaveBeenCalledWith({
        entity_type: PERSON_DESIGNATION_ENTITY_TYPE,
        filters: { owned_by: 'the_key', client_integration_id: theKeyGuid }
      })
      expect(designationEntity).toEqual(entity)
    })

    it('should be undefined if relationship does not exist', async () => {
      const theKeyGuid = uuid()
      mockEntityGET.mockResolvedValue({ entities: [] })
      expect(await globalRegistry.getDesignationRelationshipEntity(theKeyGuid)).not.toBeDefined()
    })
  })

  describe('deleteDesignationRelationshipIfNecessary( profile )', () => {
    beforeEach(() => {
      jest.spyOn(globalRegistry, 'getDesignationRelationshipEntity')
      jest.spyOn(globalRegistry, 'deleteRelationshipEntity')
    })

    it('should do nothing if designation relationship does not exist', async () => {
      const profile = { theKeyGuid: uuid() }
      globalRegistry.getDesignationRelationshipEntity.mockResolvedValue(undefined)
      await globalRegistry.deleteDesignationRelationshipIfNecessary(profile)
      expect(globalRegistry.getDesignationRelationshipEntity).toHaveBeenCalledWith(profile.theKeyGuid)
      expect(globalRegistry.deleteRelationshipEntity).not.toHaveBeenCalled()
    })

    describe('designation relationship exists', () => {
      let profile, entity
      beforeEach(() => {
        profile = { theKeyGuid: uuid() }
        entity = { id: uuid(), person: { id: uuid() }, designation: { designation_number: '0123456' } }
        globalRegistry.getDesignationRelationshipEntity.mockResolvedValue(entity)
      })

      it('should not delete if nothing changed', async () => {
        profile.usDesignationNumber = entity.designation.designation_number
        profile.thekeyGrPersonId = entity.person.id
        await globalRegistry.deleteDesignationRelationshipIfNecessary(profile)
        expect(globalRegistry.deleteRelationshipEntity).not.toHaveBeenCalled()
      })

      it('should delete if designation numbers changed', async () => {
        profile.usDesignationNumber = '0987654'
        profile.thekeyGrPersonId = entity.person.id
        await globalRegistry.deleteDesignationRelationshipIfNecessary(profile)
        expect(globalRegistry.deleteRelationshipEntity).toHaveBeenCalledWith(entity.id)
      })

      it('should delete if gr person id is not set', async () => {
        profile.usDesignationNumber = entity.designation.designation_number
        await globalRegistry.deleteDesignationRelationshipIfNecessary(profile)
        expect(globalRegistry.deleteRelationshipEntity).toHaveBeenCalledWith(entity.id)
      })

      it('should delete if gr person id is different', async () => {
        profile.usDesignationNumber = entity.designation.designation_number
        profile.thekeyGrPersonId = uuid()
        await globalRegistry.deleteDesignationRelationshipIfNecessary(profile)
        expect(globalRegistry.deleteRelationshipEntity).toHaveBeenCalledWith(entity.id)
      })
    })
  })

  describe('findOrCreateDesignationEntity( designationNumber )', () => {
    it('should do nothing if designation number is not set', async () => {
      expect(await globalRegistry.findOrCreateDesignationEntity()).not.toBeDefined()
      expect(mockEntityPOST).not.toHaveBeenCalled()
    })

    it('should return the designation entity id', async () => {
      const designationEntityId = uuid()
      mockEntityPOST.mockResolvedValue({ entity: { designation: { id: designationEntityId } } })
      expect(await globalRegistry.findOrCreateDesignationEntity('0123456')).toEqual(designationEntityId)
      expect(mockEntityPOST).toHaveBeenCalledWith({
        designation: {
          designation_number: '0123456',
          client_integration_id: '0123456'
        }
      })
    })
  })

  describe('buildPersonEntity( profile )', () => {
    let profile
    beforeEach(() => {
      profile = {
        theKeyGuid: uuid(),
        firstName: 'Bruce',
        lastName: 'Banner',
        login: 'bruce.banner@avengers.org',
        email: 'bruce.banner@avengers.org'
      }
    })

    describe('with usDesignationNumber', () => {
      it('should build person entity', async () => {
        profile.usDesignationNumber = '0123456'
        const designationEntityId = uuid()
        jest.spyOn(globalRegistry, 'findOrCreateDesignationEntity').mockResolvedValue(designationEntityId)
        expect(await globalRegistry.buildPersonEntity(profile)).toEqual({
          client_integration_id: profile.theKeyGuid,
          key_username: 'bruce.banner@avengers.org',
          first_name: 'Bruce',
          last_name: 'Banner',
          email_address: {
            client_integration_id: profile.theKeyGuid,
            email: 'bruce.banner@avengers.org'
          },
          authentication: {
            client_integration_id: profile.theKeyGuid,
            key_guid: profile.theKeyGuid
          },
          account_number: null,
          'designation:relationship': {
            designation: designationEntityId,
            client_integration_id: profile.theKeyGuid
          }
        })
      })
    })

    describe('with usEmployeeId', () => {
      it('should build person entity', async () => {
        profile.usEmployeeId = '0987654'
        expect(await globalRegistry.buildPersonEntity(profile)).toEqual({
          client_integration_id: profile.theKeyGuid,
          key_username: 'bruce.banner@avengers.org',
          first_name: 'Bruce',
          last_name: 'Banner',
          email_address: {
            client_integration_id: profile.theKeyGuid,
            email: 'bruce.banner@avengers.org'
          },
          authentication: {
            client_integration_id: profile.theKeyGuid,
            key_guid: profile.theKeyGuid
          },
          account_number: '0987654',
          linked_identities: {
            pshr: { account_number: '0987654' },
            siebel: { account_number: '0987654' }
          }
        })
      })
    })
  })

  describe('createOrUpdateProfile( profile )', () => {
    let profile
    beforeEach(() => {
      profile = {
        theKeyGuid: uuid()
      }
      jest.spyOn(globalRegistry, 'buildPersonEntity').mockResolvedValue({ client_integration_id: profile.theKeyGuid })
      jest.spyOn(globalRegistry, 'deleteDesignationRelationshipIfNecessary').mockResolvedValue(undefined)
    })

    it('should return true if profile was updated', async () => {
      const personId = uuid()
      const masterPersonId = uuid()
      profile.thekeyGrPersonId = uuid()
      mockEntityPOST.mockResolvedValue({
        entity: {
          person: {
            id: personId,
            'master_person:relationship': { master_person: masterPersonId }
          }
        }
      })
      expect(await globalRegistry.createOrUpdateProfile(profile)).toBeTruthy()
      expect(profile.thekeyGrPersonId).toEqual(personId)
      expect(profile.grMasterPersonId).toEqual(masterPersonId)
    })

    it('should return false if profile did not change', async () => {
      profile.thekeyGrPersonId = uuid()
      profile.grMasterPersonId = uuid()
      mockEntityPOST.mockResolvedValue({
        entity: {
          person: {
            id: profile.thekeyGrPersonId,
            'master_person:relationship': { master_person: profile.grMasterPersonId }
          }
        }
      })
      expect(await globalRegistry.createOrUpdateProfile(profile)).toBeFalsy()
    })
  })

  describe('deleteProfile( profile )', () => {
    it('should remove person and designation fro GR', async () => {
      const profile = { theKeyGuid: uuid(), theKeyGrPersonId: uuid(), grMasterPersonId: uuid() }
      const person1 = uuid()
      const person2 = uuid()
      mockEntityGET.mockResolvedValue({ entities: [{ person: { id: person1 } }, { person: { id: person2 } }] })
      mockEntityDELETE.mockResolvedValue({})
      jest.spyOn(globalRegistry, 'deleteDesignationRelationshipIfNecessary')

      expect(await globalRegistry.deleteProfile(profile)).toBeTruthy()
      expect(mockEntityGET).toHaveBeenCalled()
      expect(mockEntityDELETE).toHaveBeenCalledWith(person1)
      expect(mockEntityDELETE).toHaveBeenCalledWith(person2)
      expect(globalRegistry.deleteDesignationRelationshipIfNecessary).toHaveBeenCalledWith(expect.anything(), true)
      expect(profile.theKeyGrPersonId).toEqual(null)
      expect(profile.grMasterPersonId).toEqual(null)
    })
  })
})
