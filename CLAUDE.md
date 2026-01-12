# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cru Okta Web-hooks: AWS Lambda functions that handle Okta identity provider registration and event processing. Integrates with Okta, AWS (SNS/DynamoDB), Google Sheets, and CruGlobal's Global Registry.

## Common Commands

```bash
yarn lint        # Run Standard linter
yarn test        # Run Jest tests with coverage
```

To run a single test file:
```bash
yarn test path/to/file.test.js
```

## Architecture

**Lambda Functions:**

1. **Inline Hook - Registration** (`hooks/inline/registration.js`)
   - Validates new user registrations, generates GUIDs, blocks restricted email domains
   - Triggered via ALB from Okta inline hook

2. **Event Hook - Events** (`hooks/event/events.js`)
   - Routes Okta events to SNS topic, filters blocked actor IDs

3. **SNS Handlers** (`sns/user/`)
   - `lifecycle/create.js` - Creates profiles in Global Registry on user creation
   - `lifecycle/status-change.js` - Handles deactivation/reactivation events
   - `account/update-profile.js` - Syncs profile and email changes

4. **Scheduled Tasks** (`schedule/`)
   - `sync-restricted-domains.js` - Syncs restricted domains from Google Sheets to DynamoDB (every 3 hours)
   - `sync-missing-okta-users.js` - Re-syncs users missing Global Registry IDs (every 30 minutes)

**Key Models** (`models/`):
- `HookResponse` - Builds Okta hook response format
- `RegistrationRequest` / `OktaRequest` / `OktaEvent` - Parse incoming Okta payloads
- `RestrictedDomains` - DynamoDB + Google Sheets integration
- `GlobalRegistry` - CruGlobal registry client wrapper

## Code Conventions

- ES6 modules with `import`/`export` syntax
- Lambda handlers export `handler` function receiving `lambdaEvent`
- Test files colocated with source files as `*.test.js`
- Lodash used for utility functions
- Rollbar for error tracking
- Environment variables for all external configuration

## Deployment

Uses Serverless Framework v3 with serverless-webpack plugin. Configuration in `serverless.yml` defines:
- Lambda functions with ALB/SNS/schedule triggers
- SNS topic and DynamoDB table resources
- VPC/security group configuration
