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
