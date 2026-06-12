import { describe, it, expect, vi, beforeEach } from 'vitest'
import GlobalRegistry, { PERSON_DESIGNATION_ENTITY_TYPE } from '@/models/global-registry.js'
import { GRClient, mockEntityGET, mockEntityDELETE, mockEntityPOST, mockEntityPUT } from 'global-registry-nodejs-client'
import { v4 as uuid } from 'uuid'
import rollbar from '@/config/rollbar.js'

vi.mock('global-registry-nodejs-client', async () => {
  const { mockEntityGET, mockEntityDELETE, mockEntityPOST, mockEntityPUT, GRClient } = await import('../mocks/global-registry-nodejs-client.js')
  return { GRClient, mockEntityGET, mockEntityDELETE, mockEntityPOST, mockEntityPUT }
})

vi.mock('@/config/rollbar.js')

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
      vi.spyOn(globalRegistry, 'resolveAccountNumberCollision').mockResolvedValue(undefined)
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

    it('resolves account_number collisions before posting the entity', async () => {
      const order: string[] = []
      vi.spyOn(globalRegistry, 'resolveAccountNumberCollision').mockImplementation(async () => {
        order.push('resolve')
      })
      mockEntityPOST.mockImplementation(async () => {
        order.push('post')
        return { entity: { person: { id: uuid() } } }
      })
      await globalRegistry.createOrUpdateProfile(profile)
      expect(globalRegistry.resolveAccountNumberCollision).toHaveBeenCalledWith(profile)
      expect(order).toEqual(['resolve', 'post'])
    })
  })

  describe('findConflictCandidates( filter, fields )', () => {
    it('returns entities for a matching filter', async () => {
      const entities = [{ person: { id: 'p1' } }]
      mockEntityGET.mockResolvedValue({ entities })
      const result = await globalRegistry.findConflictCandidates(
        { account_number: '12345678' },
        'account_number,hcm_person_number'
      )
      expect(result).toEqual(entities)
      expect(mockEntityGET).toHaveBeenCalledWith({
        entity_type: 'person',
        filters: { owned_by: 'the_key', account_number: '12345678' },
        fields: 'account_number,hcm_person_number'
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

    it('true: account_number matches, different guid', () => {
      const entity = {
        person: {
          id: 'p1',
          account_number: '12345678',
          client_integration_id: 'STALE-GUID'
        }
      }
      expect(globalRegistry.isAccountNumberConflict(entity, profile)).toBe(true)
    })

    it('true: matches on hcm_person_number only', () => {
      const entity = {
        person: {
          id: 'p1',
          hcm_person_number: '12345678',
          client_integration_id: 'STALE-GUID'
        }
      }
      expect(globalRegistry.isAccountNumberConflict(entity, profile)).toBe(true)
    })

    it('true: email is irrelevant — a conflict even if an email matches the saving login', () => {
      const entity = {
        person: {
          id: 'p1',
          account_number: '12345678',
          client_integration_id: 'STALE-GUID',
          email_address: [{ email: 'old@gmail.com' }, { email: 'jon.watson@cru.org' }]
        }
      }
      expect(globalRegistry.isAccountNumberConflict(entity, profile)).toBe(true)
    })

    it('false: neither identifier field matches the employee number', () => {
      const entity = {
        person: {
          id: 'p1',
          account_number: '99999999',
          client_integration_id: 'STALE-GUID'
        }
      }
      expect(globalRegistry.isAccountNumberConflict(entity, profile)).toBe(false)
    })

    it('false: same account being saved (client_integration_id matches theKeyGuid)', () => {
      const entity = {
        person: {
          id: 'p1',
          account_number: '12345678',
          client_integration_id: 'NEW-GUID'
        }
      }
      expect(globalRegistry.isAccountNumberConflict(entity, profile)).toBe(false)
    })
  })

  describe('releaseAccountNumber( entity )', () => {
    it('clears account_number and hcm_person_number by person id via PUT', async () => {
      mockEntityPUT.mockResolvedValue({})
      await globalRegistry.releaseAccountNumber({ person: { id: 'person-123' } })
      expect(mockEntityPUT).toHaveBeenCalledWith('person-123', {
        account_number: null,
        hcm_person_number: null
      })
    })
  })

  describe('clearStaleOktaEmployeeId( entity )', () => {
    const entity = { person: { client_integration_id: 'STALE-GUID' } }

    it('does nothing when no Okta client is configured', async () => {
      const gr = new GlobalRegistry('token', 'https://example.com')
      await gr.clearStaleOktaEmployeeId(entity)
      // No throw, nothing to assert beyond completion.
    })

    it('nulls usEmployeeId on the matched user and updates Okta', async () => {
      const staleUser = { id: 'okta-stale-id', profile: { theKeyGuid: 'STALE-GUID', usEmployeeId: '12345678' } }
      const updateUser = vi.fn().mockResolvedValue(undefined)
      const listUsers = vi.fn().mockResolvedValue({
        each: (fn: (u: any) => void) => [staleUser].forEach(fn)
      })
      const okta = { userApi: { listUsers, updateUser } } as any
      const gr = new GlobalRegistry('token', 'https://example.com', okta)

      await gr.clearStaleOktaEmployeeId(entity)

      expect(listUsers).toHaveBeenCalledWith({ search: 'profile.theKeyGuid eq "STALE-GUID"' })
      expect(staleUser.profile.usEmployeeId).toBeNull()
      expect(updateUser).toHaveBeenCalledWith({ userId: 'okta-stale-id', user: staleUser })
    })

    it('logs to Rollbar and does not throw when Okta fails', async () => {
      const listUsers = vi.fn().mockRejectedValue(new Error('okta down'))
      const okta = { userApi: { listUsers, updateUser: vi.fn() } } as any
      const gr = new GlobalRegistry('token', 'https://example.com', okta)

      await expect(gr.clearStaleOktaEmployeeId(entity)).resolves.toBeUndefined()
      expect(rollbar.error).toHaveBeenCalled()
    })

    it('does nothing when the entity has no client_integration_id', async () => {
      const okta = { userApi: { listUsers: vi.fn(), updateUser: vi.fn() } } as any
      const gr = new GlobalRegistry('token', 'https://example.com', okta)
      await gr.clearStaleOktaEmployeeId({ person: {} })
      expect(okta.userApi.listUsers).not.toHaveBeenCalled()
    })
  })

  describe('resolveAccountNumberCollision( profile )', () => {
    let okta: any
    let updateUser: ReturnType<typeof vi.fn>
    let listUsers: ReturnType<typeof vi.fn>
    let gr: GlobalRegistry

    const conflictEntity = (overrides: Record<string, unknown> = {}) => ({
      person: {
        id: 'stale-person-id',
        account_number: '12345678',
        hcm_person_number: '12345678',
        client_integration_id: 'STALE-GUID',
        email_address: { email: 'jon@gmail.com' },
        ...overrides
      }
    })

    const staffProfile = (overrides: Record<string, unknown> = {}) =>
      ({
        theKeyGuid: 'NEW-GUID',
        login: 'jon.watson@cru.org',
        usEmployeeId: '12345678',
        ...overrides
      }) as any

    beforeEach(() => {
      updateUser = vi.fn().mockResolvedValue(undefined)
      listUsers = vi.fn().mockResolvedValue({
        each: (fn: (u: any) => void) =>
          [{ id: 'okta-stale-id', profile: { theKeyGuid: 'STALE-GUID', usEmployeeId: '12345678' } }].forEach(fn)
      })
      okta = { userApi: { listUsers, updateUser } }
      gr = new GlobalRegistry('token', 'https://example.com', okta)
      mockEntityPUT.mockResolvedValue({})
    })

    it.each([
      ['no usEmployeeId', staffProfile({ usEmployeeId: undefined })],
      ['test account', staffProfile({ login: 'test.jon@cru.org' })],
      ['non-Cru email', staffProfile({ login: 'jon@gmail.com' })],
      ['orca === false', staffProfile({ orca: false })]
    ])('skips entirely when gated out: %s', async (_label, profile) => {
      await gr.resolveAccountNumberCollision(profile)
      expect(mockEntityGET).not.toHaveBeenCalled()
      expect(mockEntityPUT).not.toHaveBeenCalled()
      expect(updateUser).not.toHaveBeenCalled()
    })

    it('proceeds when orca is undefined (treated as onboarded)', async () => {
      mockEntityGET.mockResolvedValue({ entities: [] })
      await gr.resolveAccountNumberCollision(staffProfile())
      expect(mockEntityGET).toHaveBeenCalledTimes(2)
    })

    it('queries both identifier fields', async () => {
      mockEntityGET.mockResolvedValue({ entities: [] })
      await gr.resolveAccountNumberCollision(staffProfile())
      expect(mockEntityGET).toHaveBeenCalledWith({
        entity_type: 'person',
        filters: { owned_by: 'the_key', account_number: '12345678' },
        fields: 'account_number,hcm_person_number'
      })
      expect(mockEntityGET).toHaveBeenCalledWith({
        entity_type: 'person',
        filters: { owned_by: 'the_key', hcm_person_number: '12345678' },
        fields: 'account_number,hcm_person_number'
      })
    })

    it('does nothing when there is no conflict', async () => {
      mockEntityGET.mockResolvedValue({ entities: [] })
      await gr.resolveAccountNumberCollision(staffProfile())
      expect(mockEntityPUT).not.toHaveBeenCalled()
      expect(updateUser).not.toHaveBeenCalled()
    })

    it('clears GR and Okta for a single conflict', async () => {
      mockEntityGET.mockResolvedValue({ entities: [conflictEntity()] })
      await gr.resolveAccountNumberCollision(staffProfile())
      expect(mockEntityPUT).toHaveBeenCalledWith('stale-person-id', {
        account_number: null,
        hcm_person_number: null
      })
      expect(listUsers).toHaveBeenCalledWith({ search: 'profile.theKeyGuid eq "STALE-GUID"' })
      expect(updateUser).toHaveBeenCalledTimes(1)
    })

    it('de-duplicates an entity returned by both queries (one PUT)', async () => {
      mockEntityGET.mockResolvedValue({ entities: [conflictEntity()] })
      await gr.resolveAccountNumberCollision(staffProfile())
      expect(mockEntityPUT).toHaveBeenCalledTimes(1)
    })

    it('clears each of multiple distinct conflicts', async () => {
      const entityA = conflictEntity({
        id: 'stale-A',
        client_integration_id: 'GUID-A',
        email_address: { email: 'a@gmail.com' }
      })
      const entityB = conflictEntity({
        id: 'stale-B',
        client_integration_id: 'GUID-B',
        email_address: { email: 'b@gmail.com' }
      })
      mockEntityGET
        .mockResolvedValueOnce({ entities: [entityA] }) // account_number query
        .mockResolvedValueOnce({ entities: [entityB] }) // hcm_person_number query

      await gr.resolveAccountNumberCollision(staffProfile())

      expect(mockEntityPUT).toHaveBeenCalledTimes(2)
      expect(mockEntityPUT).toHaveBeenCalledWith('stale-A', { account_number: null, hcm_person_number: null })
      expect(mockEntityPUT).toHaveBeenCalledWith('stale-B', { account_number: null, hcm_person_number: null })
      expect(updateUser).toHaveBeenCalledTimes(2)
      expect(listUsers).toHaveBeenCalledWith({ search: 'profile.theKeyGuid eq "GUID-A"' })
      expect(listUsers).toHaveBeenCalledWith({ search: 'profile.theKeyGuid eq "GUID-B"' })
    })

    it('resolves an HCM-only conflict (account_number absent)', async () => {
      const hcmOnly = conflictEntity({ account_number: undefined })
      mockEntityGET
        .mockResolvedValueOnce({ entities: [] })
        .mockResolvedValueOnce({ entities: [hcmOnly] })
      await gr.resolveAccountNumberCollision(staffProfile())
      expect(mockEntityPUT).toHaveBeenCalledWith('stale-person-id', {
        account_number: null,
        hcm_person_number: null
      })
    })

    it('continues when one field query 400s (field not defined)', async () => {
      mockEntityGET
        .mockResolvedValueOnce({ entities: [conflictEntity()] })
        .mockRejectedValueOnce({
          statusCode: 400,
          error: { error: "can't find entity type named 'hcm_person_number' that is a child of \"person\"" }
        })
      await gr.resolveAccountNumberCollision(staffProfile())
      expect(mockEntityPUT).toHaveBeenCalledTimes(1)
    })

    it('propagates a non-field GR error from a query', async () => {
      mockEntityGET.mockRejectedValue({ statusCode: 500, error: 'boom' })
      await expect(gr.resolveAccountNumberCollision(staffProfile())).rejects.toBeDefined()
    })

    it('propagates a GR PUT failure (required step)', async () => {
      mockEntityGET.mockResolvedValue({ entities: [conflictEntity()] })
      mockEntityPUT.mockRejectedValue(new Error('put failed'))
      await expect(gr.resolveAccountNumberCollision(staffProfile())).rejects.toThrow('put failed')
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
