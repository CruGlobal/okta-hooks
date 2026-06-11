# GR account_number Collision Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before okta-hooks saves a new Cru-email staff account's `the_key` Global Registry person entity, release the same employee number from any stale `the_key` person entity (and from the stale Okta account) so the unique-constraint collision on `account_number`/`hcm_person_number` cannot block the save.

**Architecture:** A new `resolveAccountNumberCollision(profile)` method on the `GlobalRegistry` model runs at the top of `createOrUpdateProfile`. It gates on (has employee id, not a test account, Cru-domain email, `orca !== false`), looks up conflicting `the_key` person entities by **both** identifier fields (transition-resilient), clears `account_number`+`hcm_person_number` on each conflict via `Entity.put` (required), and clears `usEmployeeId` on the stale Okta account via an injected Okta client (best-effort, Rollbar on failure).

**Tech Stack:** TypeScript (ES modules), Vitest, `global-registry-nodejs-client`, `@okta/okta-sdk-nodejs`, lodash, Rollbar.

**Spec:** `docs/superpowers/specs/2026-06-09-gr-account-number-collision-design.md` (all four GR assumptions verified against stage / GR source).

---

## File Structure

- `src/config/domains.ts` *(new)* — `googleManagedDomains` + `hasCruDomain()`, ported from us-onboarding. Single responsibility: Cru email-domain classification.
- `tests/config/domains.test.ts` *(new)* — unit tests for `hasCruDomain`.
- `src/types/okta.ts` *(modify)* — add `orca?: boolean`.
- `src/types/global-registry-nodejs-client.d.ts` *(modify)* — expose `put`, add `fields` to get options.
- `tests/mocks/global-registry-nodejs-client.ts` *(modify)* — add `mockEntityPUT`.
- `tests/mocks/okta-sdk-nodejs.ts` *(modify)* — add `mockListUsers` to the Client surface.
- `src/models/global-registry.ts` *(modify)* — constructor Okta param; `resolveAccountNumberCollision` + helpers; call it in `createOrUpdateProfile`.
- `tests/models/global-registry.test.ts` *(modify)* — tests for the new behavior.
- `src/handlers/sns/user-lifecycle-create.ts`, `user-lifecycle-status-change.ts`, `user-account-update-profile.ts` *(modify)* — pass the Okta client into `GlobalRegistry`.

---

## Task 1: Port `hasCruDomain` domain config

**Files:**
- Create: `src/config/domains.ts`
- Test: `tests/config/domains.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/config/domains.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { hasCruDomain } from '@/config/domains.js'

describe('hasCruDomain', () => {
  it('returns true for Google-managed Cru domains (case-insensitive)', () => {
    expect(hasCruDomain('jon.watson@cru.org')).toBe(true)
    expect(hasCruDomain('someone@familylife.com')).toBe(true)
    expect(hasCruDomain('SOMEONE@CRU.ORG')).toBe(true)
  })

  it('returns false for non-Cru domains', () => {
    expect(hasCruDomain('person@gmail.com')).toBe(false)
    expect(hasCruDomain('person@example.com')).toBe(false)
  })

  it('returns false for malformed input', () => {
    expect(hasCruDomain('not-an-email')).toBe(false)
    expect(hasCruDomain('')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/config/domains.test.ts`
Expected: FAIL — cannot resolve `@/config/domains.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/config/domains.ts`:

```ts
/**
 * Cru email-domain classification.
 *
 * Ported from us-onboarding (src/config/domains.ts) and kept self-contained here to
 * avoid a cross-repo dependency. If the canonical list changes there, update it here too.
 */

export const googleManagedDomains: string[] = [
  'cru.org',
  'allvox.com',
  'arrowheadconferences.org',
  'athletesinaction.org',
  'bridgesinternational.com',
  'cembassy.org',
  'crumilitary.org',
  'designmovement.org',
  'destino.org',
  'epicmovement.com',
  'facultycommons.org',
  'familylife.com',
  'isponline.org',
  'jesusfilm.org',
  'sightlineministry.org',
  'unto.com',
  'campuscrusadeforchrist.com',
  'ccci.org',
  'cru.comm',
  'crusade.org',
  'keynote.org',
  'studentventure.com'
]

/**
 * True when the email's domain is one of Cru's Google-managed (work) domains.
 */
export function hasCruDomain(email: string): boolean {
  const domain = email?.split('@')[1]?.toLowerCase()
  return domain ? googleManagedDomains.includes(domain) : false
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- tests/config/domains.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config/domains.ts tests/config/domains.test.ts
git commit -m "Add hasCruDomain domain config to okta-hooks"
```

---

## Task 2: Types & mocks scaffolding

No behavior yet — these support later tasks. Verified by `npm run typecheck`.

**Files:**
- Modify: `src/types/okta.ts`
- Modify: `src/types/global-registry-nodejs-client.d.ts`
- Modify: `tests/mocks/global-registry-nodejs-client.ts`
- Modify: `tests/mocks/okta-sdk-nodejs.ts`

- [ ] **Step 1: Add `orca` to the profile type**

In `src/types/okta.ts`, add the field to the `OktaUserProfile` interface (after `lastName`):

```ts
  orca?: boolean
```

- [ ] **Step 2: Expose `put` and `fields` on the GR client type**

Replace the body of `src/types/global-registry-nodejs-client.d.ts` `EntityGetOptions` and `EntityClient` with:

```ts
  interface EntityGetOptions {
    entity_type: string
    filters: Record<string, string | undefined>
    fields?: string
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
    put(
      id: string,
      content: Record<string, unknown>,
      options?: EntityPostOptions
    ): Promise<EntityResponse>
    delete(entityId: string): Promise<void>
  }
```

- [ ] **Step 3: Add `mockEntityPUT` to the GR client mock**

Replace `tests/mocks/global-registry-nodejs-client.ts` with:

```ts
import { vi } from 'vitest'

export const mockEntityGET = vi.fn()
export const mockEntityDELETE = vi.fn()
export const mockEntityPOST = vi.fn()
export const mockEntityPUT = vi.fn()

export const GRClient = vi.fn().mockImplementation(() => ({
  Entity: {
    get: mockEntityGET,
    delete: mockEntityDELETE,
    post: mockEntityPOST,
    put: mockEntityPUT
  }
}))
```

- [ ] **Step 4: Add `listUsers` to the Okta SDK mock**

In `tests/mocks/okta-sdk-nodejs.ts`, add the export and wire it into `userApi`:

Add after `export const mockUpdateUser = vi.fn()`:

```ts
export const mockListUsers = vi.fn()
```

And change the `userApi` block in the `Client` mock to:

```ts
  userApi: {
    getUser: mockGetUser,
    updateUser: mockUpdateUser,
    listUsers: mockListUsers
  },
```

- [ ] **Step 5: Verify type-check and existing tests still pass**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run test`
Expected: all existing tests PASS (no behavior changed yet).

- [ ] **Step 6: Commit**

```bash
git add src/types/okta.ts src/types/global-registry-nodejs-client.d.ts tests/mocks/global-registry-nodejs-client.ts tests/mocks/okta-sdk-nodejs.ts
git commit -m "Add orca type, GR put/fields types, and put/listUsers mocks"
```

---

## Task 3: Inject optional Okta client into GlobalRegistry

**Files:**
- Modify: `src/models/global-registry.ts`
- Test: `tests/models/global-registry.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/models/global-registry.test.ts`, add a test inside the existing `describe('constructor()', ...)` block:

```ts
    it('accepts an optional Okta client', () => {
      const okta = { userApi: {} } as any
      const gr = new GlobalRegistry('token', 'https://example.com', okta)
      expect(gr).toBeInstanceOf(GlobalRegistry)
    })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/models/global-registry.test.ts`
Expected: FAIL — TypeScript error: Expected 2 arguments, but got 3.

- [ ] **Step 3: Add the constructor parameter and imports**

In `src/models/global-registry.ts`, add imports near the top (after the existing lodash import):

```ts
import type { Client, User } from '@okta/okta-sdk-nodejs'
import rollbar from '../config/rollbar.js'
import { hasCruDomain } from '../config/domains.js'
```

Replace the field declaration and constructor:

```ts
  private client: GRClient
  private okta?: Client

  constructor(accessToken: string, baseUrl: string, okta?: Client) {
    this.client = new GRClient({ baseUrl, accessToken })
    this.okta = okta
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- tests/models/global-registry.test.ts`
Expected: PASS (existing tests + the new constructor test).

- [ ] **Step 5: Commit**

```bash
git add src/models/global-registry.ts tests/models/global-registry.test.ts
git commit -m "Inject optional Okta client into GlobalRegistry"
```

---

## Task 4: `isFieldNotDefinedError` + `findConflictCandidates`

Transition-resilient GR lookup: returns `the_key` person candidates for one identifier filter, treating a "field not defined" 400 as empty.

**Files:**
- Modify: `src/models/global-registry.ts`
- Test: `tests/models/global-registry.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a new top-level `describe` block in `tests/models/global-registry.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- tests/models/global-registry.test.ts`
Expected: FAIL — `globalRegistry.findConflictCandidates is not a function`.

- [ ] **Step 3: Implement the methods**

In `src/models/global-registry.ts`, add these methods to the `GlobalRegistry` class (after `isProbablyTestAccount`):

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- tests/models/global-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/models/global-registry.ts tests/models/global-registry.test.ts
git commit -m "Add transition-resilient GR conflict candidate lookup"
```

---

## Task 5: `emailAddresses` + `isAccountNumberConflict`

Decide whether a candidate entity is a true conflict.

**Files:**
- Modify: `src/models/global-registry.ts`
- Test: `tests/models/global-registry.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block in `tests/models/global-registry.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- tests/models/global-registry.test.ts`
Expected: FAIL — `globalRegistry.isAccountNumberConflict is not a function`.

- [ ] **Step 3: Implement the methods**

Add to the `GlobalRegistry` class in `src/models/global-registry.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- tests/models/global-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/models/global-registry.ts tests/models/global-registry.test.ts
git commit -m "Add account_number conflict detection"
```

---

## Task 6: `releaseAccountNumber`

Clear `account_number` + `hcm_person_number` on a stale `the_key` entity via `Entity.put`.

**Files:**
- Modify: `src/models/global-registry.ts`
- Test: `tests/models/global-registry.test.ts`

- [ ] **Step 1: Write the failing test**

Add a new `describe` block in `tests/models/global-registry.test.ts`:

```ts
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
```

Also extend the `vi.mock('global-registry-nodejs-client', ...)` factory at the top of the file to include `mockEntityPUT`, and add it to the import on line 3. The mock factory becomes:

```ts
import { GRClient, mockEntityGET, mockEntityDELETE, mockEntityPOST, mockEntityPUT } from 'global-registry-nodejs-client'
import { v4 as uuid } from 'uuid'

vi.mock('global-registry-nodejs-client', async () => {
  const { mockEntityGET, mockEntityDELETE, mockEntityPOST, mockEntityPUT, GRClient } = await import('../mocks/global-registry-nodejs-client.js')
  return { GRClient, mockEntityGET, mockEntityDELETE, mockEntityPOST, mockEntityPUT }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/models/global-registry.test.ts`
Expected: FAIL — `globalRegistry.releaseAccountNumber is not a function`.

- [ ] **Step 3: Implement the method**

Add to the `GlobalRegistry` class in `src/models/global-registry.ts`:

```ts
  async releaseAccountNumber(entity: Record<string, unknown>): Promise<void> {
    const personId = get(entity, 'person.id') as string
    // PUT /entities/:id updates the loaded person with update-time validations and
    // partial reconciliation; a null value destroys that field's value-entity.
    await this.client.Entity.put(personId, {
      account_number: null,
      hcm_person_number: null
    })
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- tests/models/global-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/models/global-registry.ts tests/models/global-registry.test.ts
git commit -m "Add releaseAccountNumber to clear stale GR employee number"
```

---

## Task 7: `clearStaleOktaEmployeeId`

Clear `usEmployeeId` on the stale Okta account (looked up by `theKeyGuid`). Best-effort.

**Files:**
- Modify: `src/models/global-registry.ts`
- Test: `tests/models/global-registry.test.ts`

- [ ] **Step 1: Add the rollbar mock and write the failing tests**

At the top of `tests/models/global-registry.test.ts`, after the `global-registry-nodejs-client` mock, add:

```ts
vi.mock('@/config/rollbar.js')
```

And add the import near the top:

```ts
import rollbar from '@/config/rollbar.js'
```

Add a new `describe` block:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- tests/models/global-registry.test.ts`
Expected: FAIL — `gr.clearStaleOktaEmployeeId is not a function`.

- [ ] **Step 3: Implement the method**

Add to the `GlobalRegistry` class in `src/models/global-registry.ts`:

```ts
  async clearStaleOktaEmployeeId(entity: Record<string, unknown>): Promise<void> {
    const okta = this.okta
    if (!okta) {
      return
    }
    const theKeyGuid = get(entity, 'person.client_integration_id') as string | undefined
    if (!theKeyGuid) {
      return
    }
    try {
      const collection = await okta.userApi.listUsers({
        search: `profile.theKeyGuid eq "${theKeyGuid}"`
      })
      const matched: User[] = []
      await collection.each((user: User) => {
        matched.push(user)
      })
      for (const user of matched) {
        if (user.profile) {
          const staleProfile = user.profile as Record<string, unknown>
          staleProfile.usEmployeeId = null
        }
        await okta.userApi.updateUser({ userId: user.id!, user })
      }
    } catch (error) {
      // Best-effort: the GR collision is already resolved; only the ping-pong mitigation
      // is deferred. Surface but do not block onboarding.
      await rollbar.error(
        'resolveAccountNumberCollision: failed to clear stale Okta usEmployeeId',
        error as Error,
        { theKeyGuid }
      )
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- tests/models/global-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/models/global-registry.ts tests/models/global-registry.test.ts
git commit -m "Add best-effort clearing of stale Okta usEmployeeId"
```

---

## Task 8: `resolveAccountNumberCollision` orchestration + gate

**Files:**
- Modify: `src/models/global-registry.ts`
- Test: `tests/models/global-registry.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block in `tests/models/global-registry.test.ts`:

```ts
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
        fields: 'account_number,hcm_person_number,email_address'
      })
      expect(mockEntityGET).toHaveBeenCalledWith({
        entity_type: 'person',
        filters: { owned_by: 'the_key', hcm_person_number: '12345678' },
        fields: 'account_number,hcm_person_number,email_address'
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
      // Same conflict entity returned for both account_number and hcm_person_number queries.
      mockEntityGET.mockResolvedValue({ entities: [conflictEntity()] })
      await gr.resolveAccountNumberCollision(staffProfile())
      expect(mockEntityPUT).toHaveBeenCalledTimes(1)
    })

    it('resolves an HCM-only conflict (account_number absent)', async () => {
      const hcmOnly = conflictEntity({ account_number: undefined })
      // Only the hcm_person_number query returns it.
      mockEntityGET
        .mockResolvedValueOnce({ entities: [] }) // account_number query
        .mockResolvedValueOnce({ entities: [hcmOnly] }) // hcm_person_number query
      await gr.resolveAccountNumberCollision(staffProfile())
      expect(mockEntityPUT).toHaveBeenCalledWith('stale-person-id', {
        account_number: null,
        hcm_person_number: null
      })
    })

    it('continues when one field query 400s (field not defined)', async () => {
      mockEntityGET
        .mockResolvedValueOnce({ entities: [conflictEntity()] }) // account_number query
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- tests/models/global-registry.test.ts`
Expected: FAIL — `gr.resolveAccountNumberCollision is not a function`.

- [ ] **Step 3: Implement the method**

Add to the `GlobalRegistry` class in `src/models/global-registry.ts`:

```ts
  async resolveAccountNumberCollision(profile: OktaUserProfile): Promise<void> {
    const employeeId = profile.usEmployeeId
    if (
      !employeeId ||
      this.isProbablyTestAccount(profile.login) ||
      !hasCruDomain(profile.login) ||
      profile.orca === false
    ) {
      return
    }

    const fields = 'account_number,hcm_person_number,email_address'
    const [byAccountNumber, byHcmPersonNumber] = await Promise.all([
      this.findConflictCandidates({ account_number: employeeId }, fields),
      this.findConflictCandidates({ hcm_person_number: employeeId }, fields)
    ])

    const candidatesById = new Map<string, Record<string, unknown>>()
    for (const entity of [...byAccountNumber, ...byHcmPersonNumber]) {
      const personId = get(entity, 'person.id') as string | undefined
      if (personId) {
        candidatesById.set(personId, entity)
      }
    }

    for (const entity of candidatesById.values()) {
      if (this.isAccountNumberConflict(entity, profile)) {
        // GR clear is required (runs before the new entity is posted); a failure
        // propagates because the subsequent post would collide anyway.
        await this.releaseAccountNumber(entity)
        // Okta clear is best-effort (logged, never blocks onboarding).
        await this.clearStaleOktaEmployeeId(entity)
      }
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- tests/models/global-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/models/global-registry.ts tests/models/global-registry.test.ts
git commit -m "Add resolveAccountNumberCollision orchestration and gate"
```

---

## Task 9: Run collision resolution inside `createOrUpdateProfile`

**Files:**
- Modify: `src/models/global-registry.ts:27-31` (`createOrUpdateProfile`)
- Test: `tests/models/global-registry.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/models/global-registry.test.ts`, inside the existing `describe('createOrUpdateProfile( profile )', ...)` block, add a test:

```ts
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
```

Also add, to the existing `describe('createOrUpdateProfile( profile )', ...)` `beforeEach`, a spy so the other createOrUpdateProfile tests stay isolated from the new behavior:

```ts
      vi.spyOn(globalRegistry, 'resolveAccountNumberCollision').mockResolvedValue(undefined)
```

(Place it alongside the existing `vi.spyOn(globalRegistry, 'buildPersonEntity')...` and `vi.spyOn(globalRegistry, 'deleteDesignationRelationshipIfNecessary')...` lines. The new ordering test re-overrides the spy with its own `mockImplementation`, which is fine.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/models/global-registry.test.ts`
Expected: FAIL — order is `['post']` only / `resolveAccountNumberCollision` not called.

- [ ] **Step 3: Wire it into `createOrUpdateProfile`**

In `src/models/global-registry.ts`, add the call as the first line of `createOrUpdateProfile` (before `buildPersonEntity`):

```ts
  async createOrUpdateProfile(profile: OktaUserProfile): Promise<boolean> {
    await this.resolveAccountNumberCollision(profile)

    const personEntity = await this.buildPersonEntity(profile)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- tests/models/global-registry.test.ts`
Expected: PASS (including all pre-existing createOrUpdateProfile tests).

- [ ] **Step 5: Commit**

```bash
git add src/models/global-registry.ts tests/models/global-registry.test.ts
git commit -m "Run account_number collision resolution before posting GR entity"
```

---

## Task 10: Pass the Okta client into GlobalRegistry from the handlers

**Files:**
- Modify: `src/handlers/sns/user-lifecycle-create.ts:11-14`
- Modify: `src/handlers/sns/user-lifecycle-status-change.ts:10-13`
- Modify: `src/handlers/sns/user-account-update-profile.ts:10-13`

These three handlers already construct `const okta = new Client(...)` and `new GlobalRegistry(token, url)`. Add `okta` as the third argument in each.

- [ ] **Step 1: Update `user-lifecycle-create.ts`**

Change the `GlobalRegistry` construction to:

```ts
  const globalRegistry = new GlobalRegistry(
    process.env.GLOBAL_REGISTRY_TOKEN!,
    process.env.GLOBAL_REGISTRY_URL!,
    okta
  )
```

- [ ] **Step 2: Update `user-lifecycle-status-change.ts`**

Make the identical change to its `GlobalRegistry` construction (add `,\n    okta` as the third argument).

- [ ] **Step 3: Update `user-account-update-profile.ts`**

Make the identical change to its `GlobalRegistry` construction (add `,\n    okta` as the third argument).

- [ ] **Step 4: Run the handler test suites**

Run: `npm run test -- tests/handlers/sns`
Expected: PASS. (Handler tests mock `GlobalRegistry`, so the extra constructor argument is accepted without assertion changes.)

- [ ] **Step 5: Commit**

```bash
git add src/handlers/sns/user-lifecycle-create.ts src/handlers/sns/user-lifecycle-status-change.ts src/handlers/sns/user-account-update-profile.ts
git commit -m "Pass Okta client into GlobalRegistry for collision resolution"
```

---

## Task 11: Full verification

- [ ] **Step 1: Type-check**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 3: Full test suite with coverage**

Run: `npm run test`
Expected: all tests PASS.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: builds successfully.

- [ ] **Step 5: Commit any lint fixups**

```bash
git add -A
git commit -m "Lint and verification fixups"
```

(Skip if nothing changed.)

---

## Self-Review Notes (coverage map)

- **Spec gate (usEmployeeId / test account / Cru domain / orca):** Task 8 (`resolveAccountNumberCollision`), Task 1 (`hasCruDomain`).
- **Dual lookup + union + transition resilience:** Tasks 4 and 8.
- **Conflict selection (either field, email mismatch, self-exclusion, object-or-array email):** Task 5.
- **GR clear via PUT (required):** Task 6; failure propagation verified in Task 8.
- **Okta `usEmployeeId` clear by theKeyGuid (best-effort):** Task 7.
- **Runs before the post, all 3 callers:** Tasks 9 and 10.
- **Types/mocks support:** Task 2.
