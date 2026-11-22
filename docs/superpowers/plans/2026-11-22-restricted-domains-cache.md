# Restricted Domains from a DynamoDB Copy of MMD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The registration inline hook decides from a DynamoDB copy of MMD's restricted-domain list, always answers Okta with an explicit ALLOW or DENY, and the scheduled job refreshes the copy from MMD with guards.

**Architecture:** `RestrictedDomains.isRestricted` does one DynamoDB `GetItem`. `syncDomainsFromMmd` reads MMD Postgres, diffs against a table `Scan`, and batch-writes the difference, refusing to write on MMD errors, empty results or a large shrink. The hook wraps everything in one try/catch whose catch path DENYs with a "try again" error, logs a structured line for a Datadog log monitor, and bounds the Rollbar wait.

**Tech Stack:** TypeScript (ESM), AWS SDK v3 (`@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`), `pg`, Vitest, esbuild.

**Spec:** `docs/superpowers/specs/2026-11-22-restricted-domains-cache-design.md`

## Global Constraints

- Every hook response is HTTP 200 with a `com.okta.action.update` command carrying `registration: 'ALLOW'` or `registration: 'DENY'`. No path returns 204.
- The hook answers in under 2.5 s in every path, including a hung DynamoDB call and a hung Rollbar call.
- Domain match: lowercase the parsed email domain, exact `GetItem` on `DomainName`. No subdomain or parent matching.
- MMD query, verbatim: `SELECT DISTINCT lower(domain) AS domain FROM "Domains" WHERE is_idm_self_service_prevention = true`. Drop null or empty values.
- BatchWrite chunks of 25. Retry `UnprocessedItems`; fail the run if any remain.
- Refresh guards write nothing and throw: MMD error; zero rows; deletes > `max(ceil(0.10 * currentCount), 100)` unless the event has `allowLargeDelete: true`.
- New error reason `RESTRICTED_DOMAIN_CHECK_UNAVAILABLE`, location `data.userProfile.login`. English text: `We couldn't finish creating your account. Please try again in a few minutes.` Translated for fr_FR and pt_BR (drafts below, flagged for native review); other locales get English.
- Structured log line on every check failure: `console.error(JSON.stringify({ event: 'restricted_domain_check_failed', error: <redacted message> }))`. The Datadog monitor keys on `restricted_domain_check_failed`.
- Env var for the table: `DYNAMODB_RESTRICTED_DOMAINS` (already set on `registration` and `sync_restricted_domains`).
- No Claude or Anthropic branding in commits or PRs. No feature flags. Never run Terraform locally.
- `npm run lint`, `npm run typecheck`, `npm run test` all pass with nothing skipped.

## Review Focus

1. A DynamoDB call that hangs instead of failing: the hook must still DENY with the "try again" error inside the budget (test with a never-resolving mock and fake timers or a short client timeout).
2. Rollbar that never calls back: the response must still return inside the budget (test with a never-resolving `rollbar.error` mock).
3. An email whose domain has uppercase letters or surrounding whitespace in MMD: both sides normalize to lowercase and trimmed, so `User@Example.ORG` matches an MMD row ` Example.org `.
4. An MMD answer with only a few rows when the table holds thousands (partial outage or bad data): the shrink guard trips and nothing is written.
5. `BatchWrite` returning `UnprocessedItems` on every retry: the run throws instead of reporting success with a half-written table.

---

### Task 1: RestrictedDomains model (DynamoDB lookup and MMD refresh)

**Files:**
- Modify: `src/models/restricted-domains.ts`
- Modify: `src/handlers/schedule/sync-restricted-domains.ts`
- Modify: `package.json`, `package-lock.json` (remove `@googleapis/sheets`)
- Delete: `tests/mocks/googleapis-sheets.ts` and any references to it (check `vitest.config.ts`, `tests/setup.ts`)
- Test: `tests/models/restricted-domains.test.ts`, `tests/handlers/schedule/` (existing sync handler test, if present; create `sync-restricted-domains.test.ts` if not)

**Interfaces:**
- Produces: `RestrictedDomains.isRestricted(emailAddress: string): Promise<boolean>` (static, unchanged signature; throws on any DynamoDB error).
- Produces: `new RestrictedDomains().syncDomainsFromMmd(options?: { allowLargeDelete?: boolean }): Promise<{ added: number; removed: number }>` (throws on guard trip or failure).
- Produces: `export class RestrictedDomainsSyncError extends Error` for guard trips (message names the guard and the counts).
- Consumes: `pool` from `src/config/db.ts`; `DynamoDBDocumentClient` from `@aws-sdk/lib-dynamodb`.

- [ ] **Step 1: Write failing tests for `isRestricted`**
  - `isRestricted('a@Blocked.ORG')` sends `GetCommand` with `TableName = process.env.DYNAMODB_RESTRICTED_DOMAINS` and `Key: { DomainName: 'blocked.org' }`, returns `true` when `Item` is present.
  - Returns `false` when `Item` is undefined.
  - Returns `false` without any DynamoDB call for `'not-an-email'`.
  - Rejects (propagates) when the DynamoDB send rejects.
  - No `pg` query is made (assert the pool mock is not called).
- [ ] **Step 2: Write failing tests for `syncDomainsFromMmd`**
  - MMD rows `[' Example.org ', 'b.org', null, '']`, table `['b.org', 'old.org']` (with 2,000 filler rows so the guard is not hit): puts `example.org`, deletes `old.org`, returns `{ added: 1, removed: 1 }`.
  - No difference: no `BatchWriteCommand` sent, returns `{ added: 0, removed: 0 }`.
  - 60 puts are sent as 3 `BatchWriteCommand`s (25, 25, 10).
  - `UnprocessedItems` on the first attempt are resent; if still present after the retries, rejects.
  - Pool query rejects: rejects, no `BatchWriteCommand` sent.
  - MMD returns 0 rows: rejects with `RestrictedDomainsSyncError`, nothing written.
  - Table 2,165 rows, run would delete 300 (limit is max(217, 100) = 217): rejects with `RestrictedDomainsSyncError`, nothing written. Same input with `{ allowLargeDelete: true }` writes.
  - Table 2,165 rows, run would delete 217: allowed.
  - Table 150 rows, run would delete 100: allowed (limit 100). Deletes 101: rejected.
  - `Scan` is paginated with `LastEvaluatedKey` until exhausted.
- [ ] **Step 3: Run the tests and confirm they fail.** Run: `npm run test tests/models/restricted-domains.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** in `src/models/restricted-domains.ts`:
  - Module-scope `DynamoDBDocumentClient` built from `new DynamoDBClient({ maxAttempts: 2, requestHandler: { requestTimeout: 800, connectionTimeout: 500 } })` (exact numbers may change, but the lookup must give up well under 2 s).
  - `isRestricted` uses `GetCommand`; drop `isRestrictedInPostgres`.
  - `syncDomainsFromMmd` per Global Constraints; normalize with `trim().toLowerCase()`; `UnprocessedItems` retried up to 3 times with 200/400/800 ms waits.
  - Remove `googleSheetDomains`, `syncDomainsFromGoogle` and the `@googleapis/sheets` import and dependency (`npm uninstall @googleapis/sheets`).
  - Update the class comment to the new design.
- [ ] **Step 5: Update the sync handler** `src/handlers/schedule/sync-restricted-domains.ts`: call `syncDomainsFromMmd({ allowLargeDelete: (event as { allowLargeDelete?: boolean })?.allowLargeDelete === true })`, `console.log` the `{ added, removed }` result, keep the Rollbar report and rethrow on error. Test: handler passes `allowLargeDelete` only when the event sets it to `true`; rethrows on failure.
- [ ] **Step 6: Run** `npm run lint && npm run typecheck && npm run test`. Expected: all pass.
- [ ] **Step 7: Commit** `feat: refresh restricted domains from MMD into DynamoDB and look them up there`

### Task 2: Registration hook (explicit decisions, failure path, budget)

**Files:**
- Modify: `src/handlers/alb/registration.ts`
- Test: `tests/handlers/alb/registration.test.ts`

**Interfaces:**
- Consumes: `RestrictedDomains.isRestricted` (Task 1; throws on lookup failure).
- Produces: nothing new for other tasks. Error reason string `RESTRICTED_DOMAIN_CHECK_UNAVAILABLE`; log event name `restricted_domain_check_failed`.

- [ ] **Step 1: Write failing tests**
  - Normal domain: status 200; `commands` contains `{ type: 'com.okta.action.update', value: { registration: 'ALLOW' } }` and the existing `com.okta.user.profile.update` with `theKeyGuid` and `orca: false` (and `locale` when the header is allowed).
  - Restricted domain: DENY with `RESTRICTED_EMAIL_DOMAIN`; English, fr_FR and pt_BR texts unchanged.
  - `isRestricted` rejects: status 200, DENY, error reason `RESTRICTED_DOMAIN_CHECK_UNAVAILABLE`, English text from Global Constraints; with `x-cru-locale: fr_FR` and `pt_BR` the translated text; with `x-cru-locale: de_DE` English. No `theKeyGuid` command.
  - Any other throw (for example `GUID.create` throws): same DENY "try again" response.
  - `console.error` is called once with a JSON string whose `event` is `restricted_domain_check_failed`, and the string contains no credential (use a fake error message containing `password=secret`; assert it is redacted via `redactError`).
  - `rollbar.error` never resolves: the handler still resolves within 1,000 ms of the failure (fake timers or a real short wait).
  - No test path yields status 204.
- [ ] **Step 2: Run** `npm run test tests/handlers/alb/registration.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** in `registration.ts`:
  - Add the ALLOW command on the not-restricted path.
  - Add `CHECK_UNAVAILABLE_ERRORS` map and default text. Translation drafts (flag both in the PR as needing native review):
    - fr_FR: `Nous n'avons pas pu terminer la création de votre compte. Veuillez réessayer dans quelques minutes.`
    - pt_BR: `Não foi possível concluir a criação da sua conta. Tente novamente em alguns minutos.`
  - Locale resolution must not throw before the try: compute it inside the try, and have the catch recompute it defensively from the raw header.
  - Catch: `const redacted = redactError(error)`; `console.error(JSON.stringify({ event: 'restricted_domain_check_failed', error: <redacted message> }))`; `await Promise.race([rollbar.error(...), sleep(500)])`; return the DENY "try again" response.
  - Remove the 204 path and its stale comments.
- [ ] **Step 4: Run** `npm run lint && npm run typecheck && npm run test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat: always answer the registration hook with an explicit decision`

### Task 3: Docs and build check

**Files:**
- Modify: `CLAUDE.md` (Architecture `registration.ts` and `sync-restricted-domains.ts` lines; the `RestrictedDomains` Models bullet) to describe the DynamoDB lookup, the 15-minute MMD refresh and its guards, the explicit ALLOW/DENY and the "try again" DENY.
- Verify: `esbuild.config.mjs` needs no change (both handlers stay); `npm run build` succeeds and `dist/registration.js` does not contain `pg` code (`grep -c "pg-protocol" dist/registration.js` prints 0).

- [ ] **Step 1: Update CLAUDE.md.**
- [ ] **Step 2: Run** `npm run build` and the grep above. Expected: build succeeds, grep prints 0.
- [ ] **Step 3: Commit** `docs: describe the DynamoDB restricted-domain copy`

### Task 4: cru-terraform PR (done by the main thread, not an implementer)

In a free cru-terraform working directory, on a new branch from fresh master, following that repo's `CLAUDE.md`:
- `applications/okta-hooks/{prod,stage}/application.tf`: `sync_restricted_domains` schedule `cron(0/15 * * * ? *)`; description "Refresh restricted domains from MMD into DynamoDB".
- `applications/okta-hooks/` root: `monitors.tf` with, for prod (stage optional), notifying `@jon.watson@cru.org` only:
  - Stale copy: `sum(last_1h):sum:aws.lambda.errors{functionname:okta-hooks-prod-sync_restricted_domains}.as_count() >= 4`, plus a no-data alert on invocations.
  - Check errors: log monitor `service:okta-hooks env:prod "restricted_domain_check_failed"` count > 0 over 15 minutes.
- Draft PR, no `AI` label, no Claude trailers. Hand Jon the exact `atlantis apply -d <dir>` comments and their order. Never comment `atlantis apply`.
