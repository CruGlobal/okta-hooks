# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cru Okta Web-hooks: AWS Lambda functions that handle Okta identity provider registration and event processing. Integrates with Okta, AWS (SNS, DynamoDB), MMD Postgres, and CruGlobal's Global Registry.

## Common Commands

```bash
npm run lint        # Run ESLint
npm run lint:fix    # Run ESLint with auto-fix
npm run test        # Run Vitest tests with coverage
npm run test:watch  # Run Vitest in watch mode
npm run typecheck   # Run TypeScript type checking
npm run build       # Build Lambda handlers with esbuild
```

To run a single test file:
```bash
npm run test tests/path/to/file.test.ts
```

## Architecture

**Lambda Handlers** (`src/handlers/`):

1. **ALB Handlers** (`alb/`) - Triggered via Application Load Balancer from Okta hooks
   - `registration.ts` - Inline hook: validates registrations, generates GUIDs, blocks restricted email domains (looked up in a DynamoDB copy of MMD's list). Always answers with an explicit ALLOW or DENY; see "Registration hook and restricted domains" below
   - `verification.ts` - Verification endpoint for Okta hook setup
   - `events.ts` - Event hook: routes Okta events to SNS topic

2. **SNS Handlers** (`sns/`) - Triggered by SNS messages
   - `user-lifecycle-create.ts` - Creates profiles in Global Registry on user creation
   - `user-lifecycle-status-change.ts` - Handles deactivation/reactivation events
   - `user-account-update-profile.ts` - Syncs profile and email changes

3. **Scheduled Handlers** (`schedule/`)
   - `sync-missing-okta-users.ts` - Re-syncs users missing Global Registry IDs (every 30 minutes)
   - `sync-restricted-domains.ts` - Refreshes the DynamoDB copy of restricted domains from MMD Postgres (every 3 hours), with guards against emptying it

**Models** (`src/models/`):
- `HookResponse` - Builds Okta hook response format with ALB response conversion
- `RegistrationRequest` / `OktaRequest` / `OktaEvent` - Parse incoming Okta payloads
- `RestrictedDomains` - Blocked email domains. MMD Postgres (`Domains.is_idm_self_service_prevention`) is the source of truth. The DynamoDB table in `DYNAMODB_RESTRICTED_DOMAINS` is a copy, so a domain newly restricted in MMD takes up to 3 hours to block sign-ups. A manual invoke of `sync_restricted_domains` applies it at once.
  - `normalizeDomain(value)` (exported) turns an MMD value or an email's domain into a table key, or `null` when it is not a domain. It removes invisible format characters (Unicode category Cf: zero-width spaces and joiners, U+FEFF, direction marks) anywhere in the value, composes to NFC (so the NFD and NFC forms of an IDN give one key), trims, strips one trailing dot, and lowercases. It does all case folding: the MMD query reads `domain` as stored, with no SQL `lower()`, so Postgres collation and JavaScript cannot disagree. A valid result has at least two dot-separated labels and at most 253 characters. Each label is 1 to 63 letters, digits, combining marks (any script, so IDNs pass) or inner hyphens. The refresh and the lookup both use it, so their keys always match. Real MMD rows need it: a leading zero-width space on `dimension-x.ch`, `mateus28.com.`, `msubridges..com`, and notes such as `no more will be added` typed into the domain column.
  - `isRestricted(email)` (registration hook) blocks the email's normalized domain when it, or any parent domain of it, is a key in the table. A listed root domain blocks itself and all its sub-domains: listed `cru.org` blocks `cru.org`, `mail.cru.org` and `fr.mail.cru.org`. A listed sub-domain blocks itself and its own sub-domains, but not its root or the root's other sub-domains: listed `staff.example.org` blocks `staff.example.org` and `fr.staff.example.org`, but not `example.org` or `students.example.org`. Keys match exactly, so `notcru.org` and `cru.org.example.com` never match `cru.org`. The rule comes from May Workman's "MMD development notes" doc, approved by Jon Watson 2026-11-23.
    - It looks up the domain and each parent domain, down to two labels, in one DynamoDB `BatchGetItem`, together with the refresh marker: `fr.staff.example.org` sends `#refresh`, `fr.staff.example.org`, `staff.example.org` and `example.org`. The top-level domain alone (`org`, `uk`) is never looked up, because `normalizeDomain` needs two labels and the refresh stores only its output. Country domains need no special case: listed `agape.org.uk` blocks `mail.agape.org.uk` (a listed `org.uk` would block everything under it, like any other two-label key). When the whole domain fails `normalizeDomain` (an underscore or other bad label), it still looks up the parents that pass, so `foo_bar.cru.org` checks `cru.org` and `a.b_c.d.cru.org` checks `d.cru.org` and `cru.org`.
    - `BatchGetItem` takes at most 100 keys. A 253-character domain can have 126 candidates, so a longer list is split into requests of 100 sent in parallel. The marker goes in the first request only and counts toward its 100. The normal case is always one request.
    - The Lambda role needs `dynamodb:BatchGetItem` on the table (cru-terraform `applications/okta-hooks/{stage,prod}/application.tf`, statement `AllowDynamoDBAccess`). Without it every lookup fails with AccessDenied and every sign-up gets the "try again" DENY.
    - The decision, in order:
      1. A domain found: blocked, at once. This holds even when the marker is missing or DynamoDB left other keys in `UnprocessedKeys`. Finding only the marker never counts as a hit.
      2. Keys left in `UnprocessedKeys` (the marker included): it resends only those, after 50 ms and then 100 ms. Keys still unprocessed after that make it throw.
      3. Every key read, no domain found, and no marker: it throws "Restricted domains table has no refresh marker (#refresh). It may be empty or never refreshed." An empty or never-refreshed table proves nothing.
      4. Every key read, no domain found, and the marker found: not restricted.
    - Every throw becomes the hook's "try again" DENY. An unread key is never taken as "not listed" or "no marker".
    - An address with no domain, or with no valid candidate left (a single label, a domain literal, or a bad label in the last two), is not restricted and costs no read. It never calls MMD, so an MMD outage cannot change a sign-up decision. Its client gives up fast (500 ms to connect and 600 ms per request, 2 attempts), and it throws on any DynamoDB error. The hook's 1.5 s lookup timeout caps the whole check, retries included.
  - The refresh marker is the item with key `DomainName = '#refresh'` (`REFRESH_MARKER_KEY`). It holds `LastSuccessAt` (ISO 8601 time) and `DomainCount` (how many domains MMD gave, which is the table's domain count after the run). `normalizeDomain` rejects `#`, so it can never be a domain key. The sign-up check needs it: see "Registration hook and restricted domains" below.
  - `syncDomainsFromMmd()` (scheduled job) reads MMD, normalizes each value, scans the table, and writes only the difference in `BatchWrite` chunks of 25, retrying `UnprocessedItems`. The scan leaves out the refresh marker, so the marker is never diffed, deleted or counted toward the shrink limit. A run that finishes every write with no guard tripped puts the marker last, even when nothing changed. A guard trip or a failed write leaves the marker as it was. A row that normalizes to `null` is never written. A run that skips any logs one line, `{"event":"restricted_domains_skipped_invalid","count":...,"values":[...]}` (at most 50 values), so the MMD owner can fix them. Table keys are diffed as stored, so a dirty key an earlier run wrote is deleted and its clean version added. It writes nothing and throws when the MMD query fails or MMD returns zero valid domains. When the run would delete more than `max(ceil(10% of the table), 100)` rows (the shrink guard), it still writes the adds, skips every delete, and throws. Every run fails the same way until someone acts, so the stale-copy Datadog monitor fires once there has been no successful run across about two scheduled runs. It lives in cru-terraform `applications/okta-hooks/monitors.tf`. A deliberate large removal is one manual invoke with the event `{"allowLargeDelete": true}`. The refresh has its own DynamoDB client with the SDK's default retries and timeouts, so one throttle or slow Scan page does not fail the run.
  - The job passes the MMD pool to the constructor. The model never imports `src/config/db.ts`, so the registration bundle carries no `pg`.
  - History (Flightdeck OKHOOKS-7): the refresh from MMD replaced a Google Sheet feed into the same table, and before this design the hook queried MMD during each sign-up. The `restricted_domains_postgres` feature flag that once picked the source was retired 2026-10-02: checking it called the pipeline v2 flag service on every sign-up, which often timed out and pushed the hook past Okta's 3 s limit. The flag is left in the flag service, because `cru app flags rm` burns the name forever.
- `GlobalRegistry` - CruGlobal registry client wrapper

## Registration hook and restricted domains

Okta waits at most 3 s for the registration inline hook and retries once. Then it
refuses the sign-up with its own generic error
(https://developer.okta.com/docs/concepts/inline-hooks/). So:

- The hook always answers HTTP 200 with an explicit `com.okta.action.update`
  ALLOW or DENY. It never returns 204. Okta does not document what an empty
  response means, and the old 204 error path let sign-ups through unchecked.
- Any error (DynamoDB unreachable, throttled or timed out, a missing table, or
  any other throw) is a DENY with reason `RESTRICTED_DOMAIN_CHECK_UNAVAILABLE`
  and a "please try again in a few minutes" message, with help@checkmyokta.com
  as the contact if the problem continues, in English, fr_FR or pt_BR.
  It never fails open.
- The hook answers in about 2 s in every path. The lookup times out after
  1.5 s and the Rollbar report gets at most 0.5 s.
- Each failure logs one line,
  `{"event":"restricted_domain_check_failed","name":...,"error":...}`, with
  credentials redacted. The hook still returns 200, so the Lambda error metric
  never sees these. A Datadog log monitor on that event (cru-terraform
  `applications/okta-hooks`) is the alert.
- Empty-table guard. The check reads the refresh marker (`#refresh`) in the
  same `BatchGetItem` as the domains. If no domain is found and the marker is
  missing, the table may be empty or never refreshed, so the check throws.
  Every sign-up then gets the "try again" DENY and logs
  `restricted_domain_check_failed`, so the alert fires. A listed domain is
  still blocked with the normal message. A successful refresh writes the
  marker and ends it.

To run the refresh by hand (stage, then prod):

```bash
cru app impersonate -n okta-hooks -e staging -- aws lambda invoke --function-name okta-hooks-stage-sync_restricted_domains --cli-binary-format raw-in-base64-out --payload '{}' /dev/stdout
cru app impersonate -n okta-hooks -e production -- aws lambda invoke --function-name okta-hooks-prod-sync_restricted_domains --cli-binary-format raw-in-base64-out --payload '{}' /dev/stdout
```

For a deliberate large removal, send the payload `'{"allowLargeDelete": true}'`
instead of `'{}'`.

**Rollout: invoke the refresh right after the first deploy.** A table holds no
marker until a refresh run by this code succeeds. After this code first reaches
an environment (a stage candidate, then a prod promote), run the refresh once
right away with the command above. Until a run succeeds, every sign-up gets the
"try again" DENY, and the next scheduled run can be up to 3 hours away.

**Rollout: the first refresh may hold back deletes.** Before the MMD refresh, the
table held the Google Sheet's rows. The first refresh writes every domain MMD
restricts that the Sheet lacked, right away. If the Sheet holds more domains
that MMD lacks than the shrink limit allows, that run skips all of those
deletes and fails with the shrink guard error, and so does every run after it.
A run stopped by the shrink guard writes no marker, so in a table that has
never had a marker, every sign-up stays denied until the deletes are applied.
Compare the table with MMD, then invoke `sync_restricted_domains` once with the
event `{"allowLargeDelete": true}` to apply the deletes. That run writes the
marker. Scheduled runs work on their own after that.

## Global Registry access is scoped by credential

A GR bearer token grants visibility into the entities its client system is
configured to see. **An empty result means "not visible to this token", never
"not present in GR".** Do not conclude a namespace is absent without first
confirming the credential could have seen it.

| Entities owned by | Use these credentials | Stage host |
|---|---|---|
| `the_key` (and the `hcm` view we read) | okta-hooks | `https://stage-backend.global-registry.org` |
| `pshr` | us-onboarding (`cru app secrets read -n us-onboarding -e staging --keys GLOBAL_REGISTRY_HOST --keys GLOBAL_REGISTRY_API_TOKEN`) | `https://stage-api.global-registry.org` |

The two hostnames front the same GR instance; entity ids are identical across
them, so an id resolved with one token can be fetched with the other.

Query semantics, verified 2026-09-14: `filters[<field>]` matches against the
entity across **all** systems' values, while `filters[owned_by]` only selects
which system's attribute view is **rendered**. A filter hit therefore does not
mean the matched value belongs to the system you filtered by. Searching the
`pshr` namespace for `account_number=000414026` returns an entity whose `pshr`
view renders `account_number=000559826`. Read values from the rendered view;
never infer them from the fact that a filter matched.

## Employee identifiers after HCM go-live: do not "fix" buildPersonEntity

**Okta is the system of record for employee identifiers, not Global Registry.**
That single fact resolves a question that otherwise looks like a bug.

`buildPersonEntity` (`src/models/global-registry.ts`) writes the one Okta
`profile.usEmployeeId` value into **both** `account_number` and
`hcm_person_number` on the `the_key`-owned person entity, plus all three linked
identities. That looks wrong, because the two GR fields mean different things:
`account_number` is the legacy PeopleSoft HR EMPLID and `hcm_person_number` is
the Oracle HCM Person Number. `usEmployeeId` holds the PSHR EMPLID today and
will hold the HCM Person Number after go-live.

**It is not wrong, and it needs no change.** Per Jon Watson, 2026-09-15:

- After HCM go-live, `account_number` on the `the_key`-owned person entity is
  no longer needed and can be ignored entirely. Nothing consumes it.
- The legacy PSHR EMPLID is preserved in Okta `profile.pshrEMPLID` if it is
  ever needed again, so nothing is lost by GR not holding it.
- `account_number` ending up with the HCM Person Number is harmless, and
  arguably more correct: HCM becomes the system of record, so the field then
  holds the person's real account number from the authoritative system.

Flightdeck OKHOOKS-4 proposed splitting the two sources and was **cancelled**
for exactly this reason. The code was right; the analysis lacked this context.
Do not re-derive that ticket.

Two related facts that remain true and are worth keeping:

- okta-hooks never writes a GR-derived value back into `usEmployeeId`. The only
  Okta profile fields it sets from GR data are `thekeyGrPersonId` and
  `grMasterPersonId`.
- `clearStaleOktaEmployeeId` blanking `usEmployeeId` is **intentional design,
  not a defect**: no two GR accounts may hold the same `usEmployeeId`, so
  clearing the stale account's copy is how that uniqueness is enforced. Leave
  it alone.
- `pshrEMPLID` appears nowhere in `src/` or `tests/`. Every `updateUser` call
  sends the whole fetched user object back, so the field round-trips unchanged.
  Keep it that way: PSHR SAML authentication matches on `pshrEMPLID`, and the
  value is frozen historical data with no repopulation path.

## Bulk Okta edits flood the update_profile pipeline

Any batch that writes an Okta profile field across many accounts emits one
`user.account.update_profile` event per account, which floods the SNS topic and
times out `okta-hooks-*-update_profile` en masse. This happened twice in August
2026 from the EMPLID migration batches (PSHR EMPLID into `streetAddress`, then
moving it to `pshrEMPLID` and clearing `streetAddress`). It is expected
behavior for a bulk edit, not an incident.

Dropped events from such a flood are acceptable: they are profile updates
propagating to `the_key`-owned GR person entities, and what matters is that the
values landed correctly **in Okta**. If GR missed some, replay the migration
manifest against GR directly. Flightdeck OKHOOKS-2 proposed a dead-letter queue
for this and was **cancelled** — a one-off migration does not justify one.

## Code Conventions

- TypeScript with ES modules (`import`/`export`)
- Lambda handlers export `handler` function receiving typed AWS Lambda events
- Test files in `tests/` directory mirroring `src/` structure as `*.test.ts`
- Uses Vitest with globals enabled (no need to import `describe`, `it`, `expect`)
- Path alias `@/` maps to `src/` directory
- Rollbar for error tracking
- Environment variables for all external configuration

## Build & Deployment

Uses esbuild (`esbuild.config.mjs`) to bundle handlers:
- Each handler is bundled separately to `dist/` as CommonJS (for DataDog Lambda layer compatibility)
- AWS SDK v3 is externalized (included in Lambda runtime)

This app runs on Cru's build-once / promote pipeline (pipeline v2):

- `.github/workflows/pipeline-v2.yml` builds a single environment-neutral
  container image from the default branch — nightly at 05:00 UTC and on manual
  dispatch. Builds do **not** run on push/merge.
- Each build produces a candidate that is deployed to the release-candidate
  surface automatically. The deploy job starts that deploy through the deploy
  gate with the run's GitHub OIDC token; it has no org token, so if the gate
  refuses or can't be reached, the deploy fails.
- Promotion to production is a separate, manual step that runs in
  `cru-deploy`, started with `cru app promote -n okta-hooks` (and
  `cru app rollback -n okta-hooks <release>` to go back). The CLI signs you in
  with Okta and sends the request through the deploy gate, which allows it only
  for the developers listed in this app's Terraform; push access to this repo
  does not count. Production moves only on a promote, never on merge.
- The image is environment-agnostic: `PROJECT_NAME` and `ENVIRONMENT` are
  injected as function environment variables at runtime, so the same image bytes
  run in every environment. `DD_VERSION` is the only build-baked identity value.
- `.github/workflows/nodejs.yml` is the PR CI gate (the `test` check); it no
  longer builds or deploys.
- Infrastructure (Lambda functions, IAM, triggers, SSM parameters) is managed
  with Terraform in `CruGlobal/cru-terraform` under `applications/okta-hooks/`.

This pipeline replaces the former `staging` branch build loop and the retired v1
`build-deploy-lambda.yml` workflow.
