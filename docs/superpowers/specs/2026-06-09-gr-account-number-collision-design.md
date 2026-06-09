# GR `account_number` collision resolution

- **Date:** 2026-06-09
- **Status:** Approved (design)
- **Component:** okta-hooks — `src/models/global-registry.ts`

## Background

okta-hooks creates and maintains a `the_key`-owned Global Registry (GR) person entity
for each Okta account. When the Okta profile has a `usEmployeeId`, `buildPersonEntity`
writes that value to **both** the entity's `account_number` field **and** its
`hcm_person_number` field (and to `linked_identities.{hcm,pshr,siebel}`). The
`hcm_person_number` / `hcm` linked identity were added in PR #91 (merged 2026-04-02).

GR enforces a **uniqueness constraint on `account_number` *and* on `hcm_person_number`
for `the_key`-owned person entities** — two `the_key` person entities cannot share the
same value in either field. Both must be freed on the stale entity, or the new entity's
post still collides on whichever field is left.

### The edge case

Some job codes onboard a person **without** granting a Cru-domain email
(`GRANT_EMAIL == N`, `SYSTEM_ONBOARD == Y`). In that flow no new Okta account is
created; the person's **existing personal account** (personal/non-Cru email) is modified
in place to onboard them, and a `usEmployeeId` is assigned. okta-hooks then writes that
employee number to the `account_number` of the personal account's `the_key` GR entity.

Later the person stops working for Cru, but their personal Okta account stays active
(donations, other systems). The `account_number` remains populated on that entity.

When the same person returns as full staff **with** a Cru-domain email, onboarding's
anti-hijacking policy creates a **separate** Okta work account, leaving the personal
account untouched. Both accounts now carry the same `usEmployeeId`. Okta allows this,
but when okta-hooks tries to save the new work account's `the_key` person entity, the
GR `account_number` uniqueness constraint **collides** with the old personal-account
entity, and the new entity cannot be saved.

## Goal

Before saving the new (Cru-email, onboarded) work account's GR person entity, detect any
`the_key` person entity that already holds the same employee number (in `account_number`
and/or `hcm_person_number`) for a *different* account, and release it — clearing both
fields in GR and clearing `usEmployeeId` on the stale Okta account — so the new entity
saves cleanly and the conflict does not recur.

## Scope / non-goals

- **In scope:** clearing `account_number` **and** `hcm_person_number` on conflicting
  `the_key`-owned GR person entities, and clearing `usEmployeeId` on the corresponding
  stale Okta accounts.
- **Out of scope:** `linked_identities.{hcm,pshr,siebel}` are **not** modified (only the
  two top-level fields are cleared, and only on `the_key`-owned records — this is also all
  the okta-hooks GR token is expected to have access to). Entities owned by other systems
  (e.g. `pshr`, `hcm`) are never touched. The uniqueness constraint only applies among
  `the_key`-owned entities; `linked_identities.{hcm,pshr,siebel}` live in other systems'
  namespaces and do not block the new post (confirmed — see Assumptions #4), so clearing
  the two scalar fields on the stale `the_key` entity is sufficient.

## Trigger / gate

A new resolution step runs at the **top of `createOrUpdateProfile`, before any entity is
posted**, only when **all** of the following hold for the account being saved:

1. `profile.usEmployeeId` is present (there is an `account_number` to claim).
2. `!isProbablyTestAccount(profile.login)` — mirrors `buildPersonEntity`; test accounts
   never receive an `account_number`, so they can never collide.
3. `hasCruDomain(profile.login)` — **step 1**: the saving account has a Cru email.
4. `profile.orca !== false` — **step 2**: the account is supposed to be onboarded
   (`true` and `undefined` both pass; only an explicit `false` is excluded).

If any condition is false, skip resolution and proceed exactly as today.

## Resolution algorithm (steps 3 & 4)

1. **Query GR** for candidate conflicts on **both** identifier fields, explicitly
   retrieving the fields needed to verify the conflict. The employee number lives in
   `account_number` today (PSHR) and is migrating to `hcm_person_number` (Oracle HCM);
   during and after the transition a stale entity may carry the value in either field, so
   both must be searched:

   ```ts
   const fields = 'account_number,hcm_person_number,email_address'
   const byAccountNumber = Entity.get({
     entity_type: 'person',
     filters: { owned_by: 'the_key', account_number: profile.usEmployeeId },
     fields
   })
   const byHcmPersonNumber = Entity.get({
     entity_type: 'person',
     filters: { owned_by: 'the_key', hcm_person_number: profile.usEmployeeId },
     fields
   })
   ```

   **Union** the two result sets, de-duplicating by `person.id` (an entity carrying the
   value in both fields is returned by both queries).

   **Transition resilience.** Each query is run and handled independently. GR returns an
   empty set (not an error) when a *defined* field has no match, but it returns a **400**
   (`can't find entity type named '<field>' that is a child of 'person'`) if the field is
   not defined on the `person` type at all. Because the employee number is migrating
   `account_number` → `hcm_person_number`, a field may be undefined in a given
   environment at some point in the transition. Therefore: if a single field's query
   fails with that "field not defined" 400, treat it as an empty result and continue with
   the other query rather than aborting. Any other error (auth, network, a different 400)
   propagates. Verified against stage 2026-06-09: both fields are currently defined and
   filterable, and unknown filters 400 (GR does not silently ignore them).

2. **Select true conflicts.** Read fields off `entity.person` (verified shape — see
   Assumptions #3). For each unique candidate, treat it as a conflict **only if all**
   hold:
   - **Either** `person.account_number` **or** `person.hcm_person_number` is populated and
     `equalsIgnoreCase(String(field), String(profile.usEmployeeId))` (authoritative
     equality check — does not trust the filters alone, and guards against no-op writes),
     **and**
   - **none** of the candidate's email addresses `equalsIgnoreCase` `profile.login`
     (normalize `person.email_address` to an array first, since it may be a single object
     or an array; a non-matching email means it belongs to a different account — the stale
     personal account), **and**
   - `person.client_integration_id` !== `profile.theKeyGuid` (defensive: never the account
     being saved).

3. **For each true conflict:**
   1. **Strip GR `account_number` and `hcm_person_number`** —
      `Entity.put(person.id, { account_number: null, hcm_person_number: null })`.
      Only these two fields, only on the `the_key`-owned record (`hcm_person_number: null`
      is harmless if the field was unset on a legacy entity). **Required** before the new
      entity is posted; a failure here propagates (the subsequent post would collide
      anyway).
   2. **Clear stale Okta `usEmployeeId`** — locate the stale Okta account by its
      `theKeyGuid`, which equals the conflict entity's `person.client_integration_id`
      (unambiguous join; avoids choosing among possibly-multiple emails):
      `listUsers({ search: 'profile.theKeyGuid eq "<client_integration_id>"' })`. For the
      matched user, set `profile.usEmployeeId = null` (Okta's convention for clearing a
      custom attribute; `undefined` would be omitted from the payload and clear nothing)
      and `updateUser(...)`. This stops the stale account from re-claiming the number on
      its next sync. **Best-effort:** on failure or no match, log to Rollbar and continue
      (the immediate collision is already resolved; only the ping-pong mitigation is
      deferred).

4. **Fall through** to the existing flow: `deleteDesignationRelationshipIfNecessary`
   then `Entity.post`.

## Code changes

- **`src/config/domains.ts`** (new) — port `googleManagedDomains` and `hasCruDomain()`
  from us-onboarding as a self-contained copy. (Accepted cross-repo duplication / drift
  risk over a shared package for now.)
- **`src/types/okta.ts`** — add `orca?: boolean`.
- **`src/models/global-registry.ts`**:
  - Constructor accepts an optional Okta `Client` (`constructor(accessToken, baseUrl, okta?)`).
  - New private `resolveAccountNumberCollision(profile)` implementing the algorithm above.
  - Call it at the top of `createOrUpdateProfile`.
- **Callers that pass their Okta client into `GlobalRegistry`** (the three handlers that
  call `createOrUpdateProfile`; `sync-missing-okta-users` is *not* one — it only
  re-publishes `user.lifecycle.create` SNS events, which re-enter via the create handler):
  - `src/handlers/sns/user-lifecycle-create.ts`
  - `src/handlers/sns/user-lifecycle-status-change.ts`
  - `src/handlers/sns/user-account-update-profile.ts`
- **`src/types/global-registry-nodejs-client.d.ts`** — expose `put(id, content, options?)`
  (already implemented in the underlying lib) on `EntityClient`; add optional `fields`
  to `EntityGetOptions`.
- **`tests/mocks/global-registry-nodejs-client.ts`** — add `mockEntityPUT` and wire it
  into the `GRClient` mock.

## Error handling (Decision B)

- GR `account_number` strip: **required** before post; failure propagates (existing
  Rollbar-and-throw behavior in each handler).
- Stale Okta `usEmployeeId` clear: **best-effort**; log to Rollbar on failure or when no
  matching user is found, then continue so onboarding completes.

## Architectural note

Placing the resolution inside `createOrUpdateProfile` (per decision) means the
`GlobalRegistry` model now depends on an Okta `Client` to clear the stale account's
`usEmployeeId`. This is a deliberate, scoped coupling: the Okta client is injected
(optional) so existing GR-only unit tests remain valid, and the collision logic that
spans both systems stays in one place rather than being fragmented across the four
three handlers that call `createOrUpdateProfile`.

## Assumptions to verify during implementation

1. ✅ **Verified (stage, 2026-06-09).** GR `Entity.get` supports filtering by
   `account_number` **and** by `hcm_person_number`; an unmatched value returns an empty
   set, and an undefined filter field returns a 400 (does not silently match all). See
   the transition-resilience note in the algorithm.
2. ✅ **Verified (GR source, 2026-06-09).** `Entity.put(id, { account_number: null,
   hcm_person_number: null })` is a **partial** update: `entities_controller#update`
   reconciles only the properties present in the payload (omitted fields are untouched),
   and a blank/nil value `destroy`s that property's value-entity (clears the field) —
   see `Entity#set_value_without_details`. It also only affects value-entities the
   token's system created (`find_current_entities` filters by
   `created_by: Thread.current[:system].id`), so okta-hooks' `the_key` token can only
   clear `the_key`-owned data — consistent with scope.
3. ✅ **Verified (stage, 2026-06-09).** A real `the_key` person carrying both fields
   returns this shape (scalar fields are **omitted when unset**, not returned as null):

   ```json
   { "person": {
       "id": "…",
       "account_number": "<string>",
       "hcm_person_number": "<string>",
       "email_address": { "id": "…", "email": "<string>", "client_integration_id": "…" },
       "client_integration_id": "…"
   } }
   ```

   Extraction paths: `entity.person.id`, `entity.person.account_number`,
   `entity.person.hcm_person_number`, `entity.person.client_integration_id`,
   `entity.person.email_address.email`. `email_address` returned as a single object here
   (one email); since a person may have several and GR returns arrays for multi-valued
   fields (cf. `master_person:relationship`, already handled both ways in this codebase),
   extraction must normalize object-or-array. Observed hit rate in a 1000-record sample:
   14 with `account_number`, 7 with `hcm_person_number` — confirms both lookups are
   needed during the transition.
4. ✅ **Confirmed working-as-designed.** GR's uniqueness rejection on the new post is
   driven only by collisions among `the_key`-owned entities (the `account_number` /
   `hcm_person_number` scalar fields). `linked_identities.{hcm,pshr,siebel}` live in
   other systems' namespaces and do **not** block the post, so clearing the two scalar
   fields on the stale `the_key` entity is sufficient.

If any does not hold, mechanics change (e.g. POST-upsert by `client_integration_id`
instead of PUT; or client-side filtering of a broader query) — flag and adjust before
proceeding.

## Test plan (Vitest)

`tests/models/global-registry.test.ts` — new `resolveAccountNumberCollision` /
`createOrUpdateProfile` cases:

- **No collision:** both queries return only the saving account (or empty) → no PUT,
  no Okta update, normal post proceeds.
- **Gate misses:** each of (no `usEmployeeId`, test account, non-Cru email,
  `orca === false`) → resolution skipped entirely.
- **Single conflict:** stale entity with same `account_number`, different email →
  `Entity.put(id, { account_number: null, hcm_person_number: null })` called, stale Okta
  user's `usEmployeeId` cleared via `updateUser`, then post proceeds.
- **Legacy stale entity (no `hcm_person_number`):** found via the `account_number` query;
  PUT still clears both fields (`hcm_person_number: null` is a harmless no-op).
- **HCM-only stale entity (no `account_number`):** found via the `hcm_person_number`
  query; treated as a conflict and both fields cleared.
- **Entity in both result sets:** de-duplicated by `person.id`; stripped once.
- **Multiple conflicts:** all stale entities stripped; all stale Okta users cleared.
- **`account_number` not populated / not equal:** candidate skipped (no PUT).
- **Okta clear fails / user not found:** Rollbar logged, post still proceeds.
- **GR strip fails:** error propagates (no post).
- Plus unit tests for `hasCruDomain()` in `tests/config/domains.test.ts`.
