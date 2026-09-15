# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cru Okta Web-hooks: AWS Lambda functions that handle Okta identity provider registration and event processing. Integrates with Okta, AWS (SNS), MMD Postgres, and CruGlobal's Global Registry.

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
   - `registration.ts` - Inline hook: validates registrations, generates GUIDs, blocks restricted email domains (source selected by the `restricted_domains_postgres` feature flag)
   - `verification.ts` - Verification endpoint for Okta hook setup
   - `events.ts` - Event hook: routes Okta events to SNS topic

2. **SNS Handlers** (`sns/`) - Triggered by SNS messages
   - `user-lifecycle-create.ts` - Creates profiles in Global Registry on user creation
   - `user-lifecycle-status-change.ts` - Handles deactivation/reactivation events
   - `user-account-update-profile.ts` - Syncs profile and email changes

3. **Scheduled Handlers** (`schedule/`)
   - `sync-missing-okta-users.ts` - Re-syncs users missing Global Registry IDs (every 30 minutes)
   - `sync-restricted-domains.ts` - Syncs restricted domains from the IDM Google Sheet into DynamoDB (every 3 hours)

**Models** (`src/models/`):
- `HookResponse` - Builds Okta hook response format with ALB response conversion
- `RegistrationRequest` / `OktaRequest` / `OktaEvent` - Parse incoming Okta payloads
- `RestrictedDomains` - Looks up blocked email domains. The `restricted_domains_postgres` feature flag (pipeline v2 flag service, read via `@cruglobal/flags`) selects MMD Postgres (`Domains.is_idm_self_service_prevention`); while disabled or absent it reads the DynamoDB table kept fresh by the Google Sheet sync. The flag exists until MMD prod go-live (`cru app flags enable restricted_domains_postgres -n okta-hooks -e production`); the sync always runs so DynamoDB stays a warm fallback.
- `GlobalRegistry` - CruGlobal registry client wrapper

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
  surface automatically. Promotion to production is a separate, manual step run
  from `cru-deploy`; production moves only on a promote, never on merge.
- The image is environment-agnostic: `PROJECT_NAME` and `ENVIRONMENT` are
  injected as function environment variables at runtime, so the same image bytes
  run in every environment. `DD_VERSION` is the only build-baked identity value.
- `.github/workflows/nodejs.yml` is the PR CI gate (the `test` check); it no
  longer builds or deploys.
- Infrastructure (Lambda functions, IAM, triggers, SSM parameters) is managed
  with Terraform in `CruGlobal/cru-terraform` under `applications/okta-hooks/`.

This pipeline replaces the former `staging` branch build loop and the retired v1
`build-deploy-lambda.yml` workflow.
