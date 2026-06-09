import { describe, it, expect, vi, beforeEach } from 'vitest'
import GlobalRegistry, { PERSON_DESIGNATION_ENTITY_TYPE } from '@/models/global-registry.js'
import { GRClient, mockEntityGET, mockEntityDELETE, mockEntityPOST } from 'global-registry-nodejs-client'
import { v4 as uuid } from 'uuid'

vi.mock('global-registry-nodejs-client', async () => {
  const { mockEntityGET, mockEntityDELETE, mockEntityPOST, GRClient } = await import('../mocks/global-registry-nodejs-client.js')
  return { GRClient, mockEntityGET, mockEntityDELETE, mockEntityPOST }
})

describe('GlobalRegistry', () => {
  let globalRegistry: GlobalRegistry
  beforeEach(() => {
    vi.clearAllMocks()
    globalRegistry = new GlobalRegistry('token', 'https://example.com')
  })

  describe('constructor()', () => {
    it('should instantiate a new instance', () => {
      expect(globalRegistry.client).toBeDefined()
      expect(GRClient).toHaveBeenCalledWith({ accessToken: 'token', baseUrl: 'https://example.com' })
    })

    it('accepts an optional Okta client', () => {
      const okta = { userApi: {} } as any
      const gr = new GlobalRegistry('token', 'https://example.com', okta)
      expect(gr).toBeInstanceOf(GlobalRegistry)
    })
  })

  describe('isProbablyTestAccount( email )', () => {
    it('should return if email is probably not a test account', () => {
      expect(globalRegistry.isProbablyTestAccount('tony.stark@avengers.org')).toBeFalsy()
      expect(globalRegistry.isProbablyTestAccount()).toBeTruthy()
      expect(globalRegistry.isProbablyTestAccount(null as any)).toBeTruthy()
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
      vi.spyOn(globalRegistry, 'getDesignationRelationshipEntity')
      vi.spyOn(globalRegistry, 'deleteRelationshipEntity')
    })

    it('should do nothing if designation relationship does not exist', async () => {
      const profile = { theKeyGuid: uuid() } as any
      vi.mocked(globalRegistry.getDesignationRelationshipEntity).mockResolvedValue(undefined)
      await globalRegistry.deleteDesignationRelationshipIfNecessary(profile)
      expect(globalRegistry.getDesignationRelationshipEntity).toHaveBeenCalledWith(profile.theKeyGuid)
      expect(globalRegistry.deleteRelationshipEntity).not.toHaveBeenCalled()
    })

    describe('designation relationship exists', () => {
      let profile: any, entity: any
      beforeEach(() => {
        profile = { theKeyGuid: uuid() }
        entity = { id: uuid(), person: { id: uuid() }, designation: { designation_number: '0123456' } }
        vi.mocked(globalRegistry.getDesignationRelationshipEntity).mockResolvedValue(entity)
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
    let profile: any
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
        vi.spyOn(globalRegistry, 'findOrCreateDesignationEntity').mockResolvedValue(designationEntityId)
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
          hcm_person_number: null,
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
          hcm_person_number: '0987654',
          linked_identities: {
            hcm: { hcm_person_number: '0987654' },
            pshr: { account_number: '0987654' },
            siebel: { account_number: '0987654' }
          }
        })
      })
    })
  })

  describe('createOrUpdateProfile( profile )', () => {
    let profile: any
    beforeEach(() => {
      profile = {
        theKeyGuid: uuid()
      }
      vi.spyOn(globalRegistry, 'buildPersonEntity').mockResolvedValue({ client_integration_id: profile.theKeyGuid })
      vi.spyOn(globalRegistry, 'deleteDesignationRelationshipIfNecessary').mockResolvedValue(undefined)
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

    it('should handle master_person:relationship as an array', async () => {
      const personId = uuid()
      const masterPersonId = uuid()
      mockEntityPOST.mockResolvedValue({
        entity: {
          person: {
            id: personId,
            'master_person:relationship': [
              { master_person: masterPersonId, relationship_entity_id: uuid() },
              { master_person: masterPersonId, relationship_entity_id: uuid() }
            ]
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

  describe('findConflictCandidates( filter, fields )', () => {
    it('returns entities for a matching filter', async () => {
      const entities = [{ person: { id: 'p1' } }]
      mockEntityGET.mockResolvedValue({ entities })
      const result = await globalRegistry.findConflictCandidates(
        { account_number: '12345678' },
        'account_number,hcm_person_number,email_address'
      )
      expect(result).toEqual(entities)
      expect(mockEntityGET).toHaveBeenCalledWith({
        entity_type: 'person',
        filters: { owned_by: 'the_key', account_number: '12345678' },
        fields: 'account_number,hcm_person_number,email_address'
      })
    })

    it('returns [] when GR has no entities key', async () => {
      mockEntityGET.mockResolvedValue({})
      expect(await globalRegistry.findConflictCandidates({ hcm_person_number: 'x' }, 'f')).toEqual([])
    })

    it('treats a "field not defined" 400 as empty', async () => {
      mockEntityGET.mockRejectedValue({
        statusCode: 400,
        error: { error: "can't find entity type named 'hcm_person_number' that is a child of \"person\"" }
      })
      expect(await globalRegistry.findConflictCandidates({ hcm_person_number: 'x' }, 'f')).toEqual([])
    })

    it('re-throws any other error', async () => {
      mockEntityGET.mockRejectedValue({ statusCode: 500, error: 'boom' })
      await expect(globalRegistry.findConflictCandidates({ account_number: 'x' }, 'f')).rejects.toEqual({
        statusCode: 500,
        error: 'boom'
      })
    })
  })

  describe('isAccountNumberConflict( entity, profile )', () => {
    const profile = {
      theKeyGuid: 'NEW-GUID',
      login: 'jon.watson@cru.org',
      usEmployeeId: '12345678'
    } as any

    it('true: account_number matches, different email, different guid', () => {
      const entity = {
        person: {
          id: 'p1',
          account_number: '12345678',
          client_integration_id: 'STALE-GUID',
          email_address: { email: 'jon@gmail.com' }
        }
      }
      expect(globalRegistry.isAccountNumberConflict(entity, profile)).toBe(true)
    })

    it('true: matches on hcm_person_number only', () => {
      const entity = {
        person: {
          id: 'p1',
          hcm_person_number: '12345678',
          client_integration_id: 'STALE-GUID',
          email_address: { email: 'jon@gmail.com' }
        }
      }
      expect(globalRegistry.isAccountNumberConflict(entity, profile)).toBe(true)
    })

    it('true: email_address is an array with no matching email', () => {
      const entity = {
        person: {
          id: 'p1',
          account_number: '12345678',
          client_integration_id: 'STALE-GUID',
          email_address: [{ email: 'jon@gmail.com' }, { email: 'jon@yahoo.com' }]
        }
      }
      expect(globalRegistry.isAccountNumberConflict(entity, profile)).toBe(true)
    })

    it('false: number does not actually match (loose filter guard)', () => {
      const entity = {
        person: {
          id: 'p1',
          account_number: '99999999',
          client_integration_id: 'STALE-GUID',
          email_address: { email: 'jon@gmail.com' }
        }
      }
      expect(globalRegistry.isAccountNumberConflict(entity, profile)).toBe(false)
    })

    it('false: same account being saved (client_integration_id matches theKeyGuid)', () => {
      const entity = {
        person: {
          id: 'p1',
          account_number: '12345678',
          client_integration_id: 'NEW-GUID',
          email_address: { email: 'jon.watson@cru.org' }
        }
      }
      expect(globalRegistry.isAccountNumberConflict(entity, profile)).toBe(false)
    })

    it('false: one of the emails matches the saving login', () => {
      const entity = {
        person: {
          id: 'p1',
          account_number: '12345678',
          client_integration_id: 'STALE-GUID',
          email_address: [{ email: 'old@gmail.com' }, { email: 'jon.watson@cru.org' }]
        }
      }
      expect(globalRegistry.isAccountNumberConflict(entity, profile)).toBe(false)
    })
  })

  describe('deleteProfile( profile )', () => {
    it('should remove person and designation fro GR', async () => {
      const profile = { theKeyGuid: uuid(), thekeyGrPersonId: uuid(), grMasterPersonId: uuid() } as any
      const person1 = uuid()
      const person2 = uuid()
      mockEntityGET.mockResolvedValue({ entities: [{ person: { id: person1 } }, { person: { id: person2 } }] })
      mockEntityDELETE.mockResolvedValue({})
      vi.spyOn(globalRegistry, 'deleteDesignationRelationshipIfNecessary')

      expect(await globalRegistry.deleteProfile(profile)).toBeTruthy()
      expect(mockEntityGET).toHaveBeenCalled()
      expect(mockEntityDELETE).toHaveBeenCalledWith(person1)
      expect(mockEntityDELETE).toHaveBeenCalledWith(person2)
      expect(globalRegistry.deleteDesignationRelationshipIfNecessary).toHaveBeenCalledWith(expect.anything(), true)
      expect(profile.thekeyGrPersonId).toEqual(null)
      expect(profile.grMasterPersonId).toEqual(null)
    })

    it('should skip entities without person.id', async () => {
      const profile = { theKeyGuid: uuid(), thekeyGrPersonId: uuid(), grMasterPersonId: uuid() } as any
      const person1 = uuid()
      mockEntityGET.mockResolvedValue({
        entities: [
          { person: { id: person1 } },
          { person: {} },
          { other: { id: uuid() } }
        ]
      })
      mockEntityDELETE.mockResolvedValue({})
      vi.spyOn(globalRegistry, 'deleteDesignationRelationshipIfNecessary')

      expect(await globalRegistry.deleteProfile(profile)).toBeTruthy()
      expect(mockEntityDELETE).toHaveBeenCalledTimes(1)
      expect(mockEntityDELETE).toHaveBeenCalledWith(person1)
    })

    it('should handle undefined entities in response', async () => {
      const profile = { theKeyGuid: uuid(), thekeyGrPersonId: uuid(), grMasterPersonId: uuid() } as any
      mockEntityGET.mockResolvedValue({})
      mockEntityDELETE.mockResolvedValue({})
      vi.spyOn(globalRegistry, 'deleteDesignationRelationshipIfNecessary')

      expect(await globalRegistry.deleteProfile(profile)).toBeTruthy()
      expect(mockEntityDELETE).not.toHaveBeenCalled()
      expect(profile.thekeyGrPersonId).toEqual(null)
      expect(profile.grMasterPersonId).toEqual(null)
    })
  })
})
