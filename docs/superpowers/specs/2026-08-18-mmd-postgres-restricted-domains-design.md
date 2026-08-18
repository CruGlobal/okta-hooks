# Restricted Domains via MMD Postgres — Design

**Date:** 2026-08-18
**Status:** Approved in brainstorming; implementation pending
**Tracking:** Flightdeck task under Okta Hooks (OKHOOKS) — to be created
**Cross-session state:** knowledge-graph entity `okta-hooks MMD Postgres Migration`

## Problem

okta-hooks blocks self-service Okta registration for restricted (ministry-managed /
self-service-prevention) email domains. The domain list currently comes from the legacy
IDM Google Sheet (tab `Okta self-service prevention`, column A), synced every 3 hours by
the `sync_restricted_domains` Lambda into a DynamoDB table
(`okta-hooks-{env}-restricted-domains`). The ALB registration inline hook does a DynamoDB
`GetItem` per signup and returns DENY on a hit.

The sheet is going away. MMD Postgres (`Domains.is_idm_self_service_prevention = true`)
is already the authoritative source for this data (confirmed by Jon, 2026-08-18). This is
the only feature in okta-hooks that touches the sheet or the DynamoDB table.

## Decision summary

- **Read path:** the registration hook queries MMD Postgres directly. The DynamoDB
  table, sync Lambda, and its cron are deleted entirely. No cache layer.
- **Credentials:** a dedicated read-only Postgres user `okta_hooks`, not the
  write-capable `ministry_managed_domains_admin` app user.
- **Failure mode:** unchanged. The registration handler's existing catch returns 204
  (fail open, registration allowed) if the database is unreachable.
- **Cutover safety:** one-time parity check (current DynamoDB contents vs Postgres
  flagged set, stage and prod) before cutover, even though Postgres is authoritative.

## Code changes (okta-hooks)

- Add `pg` dependency. New `src/config/db.ts` exporting a module-scope `pg.Pool`
  (`max: 1`, `ssl: { rejectUnauthorized: false }`) — same pattern as mmd-api's
  `src/db.ts`.
- Rewrite `src/models/restricted-domains.ts`: `RestrictedDomains.isRestricted(email)`
  keeps its signature and `email-addresses` parsing, but runs:
  ```sql
  SELECT 1 FROM "Domains"
  WHERE lower(domain) = $1 AND is_idm_self_service_prevention = true
  LIMIT 1
  ```
- `src/handlers/alb/registration.ts` is untouched.
- Delete: `syncDomainsFromGoogle`, `googleSheetDomains`, `allDomains`,
  `src/handlers/schedule/sync-restricted-domains.ts`, `tests/mocks/googleapis-sheets.ts`,
  and the related tests.
- Remove dependencies `@googleapis/sheets`, `@aws-sdk/client-dynamodb`,
  `@aws-sdk/lib-dynamodb` (nothing else uses them).
- `esbuild.config.mjs`: remove the `sync_restricted_domains` entry; externalize
  `pg-native`.
- Env vars: `PG_HOST`, `PG_DATABASE`, `PG_USERNAME`, `PG_PASSWORD`, `PG_PORT`
  (mmd-api naming). Update `.env` / `.env.test`; tests mock `pg`.

## Infrastructure (two Terraform PRs)

okta-hooks Lambdas already run with `use_vpc = true`, so in-VPC RDS access only needs
security-group ingress.

### TF PR 1 — additive

`cru-terraform/applications/ministry-managed-domains/{stage,prod}`:
- Add `okta_hooks` to `db_utility_users` (passworded role, no default perms) and
  `db_read_all_public` in the `database/postgres` module call.
- Add outputs `okta_hooks_username` / `okta_hooks_password` (from
  `utility_users_passwords`).
- Add an RDS SG ingress rule from the okta-hooks Lambda SG
  (`okta-hooks-{env}-lambda`, via data source) — same precedent as the existing
  mmd-api Lambda rule in MMD's `database.tf`.

`cru-terraform/applications/okta-hooks/{stage,prod}`:
- Add `terraform_remote_state` data source for `ministry-managed-domains/{env}`.
- Wire `PG_*` into the module `parameters` (SSM-injected).
- DynamoDB and the sync function stay for now.

**Apply order:** MMD directories before okta-hooks directories (outputs must exist).
Note the order in the PR description.

### TF PR 2 — cleanup (only after prod cutover verified)

- Remove the DynamoDB table, its IAM policy statement, the `sync_restricted_domains`
  function, and its EventBridge cron entry from both okta-hooks envs.
- Then manually delete the `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`, and
  `GOOGLE_RESTRICTED_DOMAINS_SHEET` SSM params (they are not Terraform-managed).

## Rollout

1. Parity check: diff DynamoDB contents against Postgres flagged domains (stage and
   prod data); surface any drift to Jon before cutover.
2. Apply TF PR 1 (MMD dirs, then okta-hooks dirs).
3. Code PR to okta-hooks → `On Staging` label → verify in oktapreview: flagged domain
   gets DENY; normal domain registers.
4. Merge code PR to master (prod deploy); verify in prod.
5. TF PR 2 + manual SSM cleanup.

## Testing

TDD throughout. Unit tests mock `pg`; registration hook tests cover DENY on flagged
domain, allow on normal domain, and fail-open on query error. Standard review pass
before merging the code PR.
