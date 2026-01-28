# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cru Okta Web-hooks: AWS Lambda functions that handle Okta identity provider registration and event processing. Integrates with Okta, AWS (SNS/DynamoDB), Google Sheets, and CruGlobal's Global Registry.

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
   - `registration.ts` - Inline hook: validates registrations, generates GUIDs, blocks restricted email domains
   - `verification.ts` - Verification endpoint for Okta hook setup
   - `events.ts` - Event hook: routes Okta events to SNS topic

2. **SNS Handlers** (`sns/`) - Triggered by SNS messages
   - `user-lifecycle-create.ts` - Creates profiles in Global Registry on user creation
   - `user-lifecycle-status-change.ts` - Handles deactivation/reactivation events
   - `user-account-update-profile.ts` - Syncs profile and email changes

3. **Scheduled Handlers** (`schedule/`)
   - `sync-restricted-domains.ts` - Syncs restricted domains from Google Sheets to DynamoDB (every 3 hours)
   - `sync-missing-okta-users.ts` - Re-syncs users missing Global Registry IDs (every 30 minutes)

**Models** (`src/models/`):
- `HookResponse` - Builds Okta hook response format with ALB response conversion
- `RegistrationRequest` / `OktaRequest` / `OktaEvent` - Parse incoming Okta payloads
- `RestrictedDomains` - DynamoDB + Google Sheets integration for blocked email domains
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
- Infrastructure managed via Terraform (linked at `okta-hooks-terraform-config`)
