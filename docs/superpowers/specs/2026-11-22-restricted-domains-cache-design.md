# Restricted Domains from a DynamoDB Copy of MMD: Design

**Date:** 2026-11-22
**Status:** Draft, awaiting Jon's approval
**Tracking:** Flightdeck OKHOOKS-7 (cache and refresh), OKHOOKS-8 (alerts)
**Supersedes:** the read path in `2026-08-18-mmd-postgres-restricted-domains-design.md`

## Why

The registration inline hook blocks self-service Okta sign-up for restricted email
domains. Today it queries MMD Postgres during the sign-up request
(`src/models/restricted-domains.ts`, `isRestrictedInPostgres`). Okta waits at most 3 s for
the hook, retries once, then denies with a generic error
(https://developer.okta.com/docs/concepts/inline-hooks/). When MMD can't be reached the
outcome is accidental:

- A fast error (refused connection, bad password) hits the handler's `catch`, which
  returns 204 with no commands. Okta lets the sign-up through unchecked (fail open). May
  Workman raised this on 2026-11-18.
- A slow error (2 s connect timeout, plus a 2 s query timeout, plus the awaited Rollbar
  call) runs past 3 s, and Okta denies with "There was an error creating your account".
  This happened once in prod: 2026-11-06 03:56Z, 4.16 s.
- Nothing alerts. The error reaches Rollbar only. okta-hooks has no Datadog monitors.

DevOps (David Hollenberger, 2026-11-18): MMD outages run about 30 s (weekly maintenance,
Wed 04:00-04:30 UTC) to 1-2 min (failover). Prod sees about 130 sign-ups a day.

## Decisions (Jon, 2026-11-22)

- **Option C.** The sign-up check decides from a copy of MMD's restricted-domain list kept
  in DynamoDB. MMD is not called during a sign-up, so an MMD outage cannot affect sign-ups.
- The copy lives in the existing table `okta-hooks-{env}-restricted-domains`. The Google
  Sheet feed is replaced by a refresh from MMD on the job's existing **3-hour** schedule.
  (The design first proposed every 15 minutes. After review on cru-terraform #13616,
  Jon kept 3 hours, 2026-11-23.)
- **If DynamoDB can't be read, refuse every sign-up** with a "please try again in a few
  minutes" message. No fallback to MMD.
- **The hook always returns an explicit ALLOW or DENY.** It never relies on a 204 / empty
  response, whose meaning Okta does not document.
- **Alerts go to Jon only.** No DevOps HelpScout ticket; the Datadog alert is enough.
- **No rush for the 2026-11-25 04:00Z MMD resize.** Ship on the normal schedule.

## Goals

- MMD being down never changes a sign-up decision.
- Every hook response is an explicit decision, sent well inside Okta's 3 s.
- A failing refresh never empties or shrinks the copy by accident.
- Jon hears about a stale copy or a failing check from Datadog.

## Non-goals

- A retry queue. The decision must be made inside Okta's 3 s window, and the 3-hour
  schedule is the refresh's retry. (A queue was considered and dropped: see Approaches.)
- Changing the SNS handlers (create, status change, update profile). None of them use MMD.
- Changing what MMD marks as restricted, or mmd-api.

## Anti-goals

- A refresh that deletes most rows because MMD returned a partial or empty answer.
- A hook response that arrives after 3 s, which turns any decision into Okta's generic
  denial.

## Approaches considered

- **A. Fail open, re-check later through a queue.** Allow during an outage, re-check the
  domain on a back-off schedule, act on the account if restricted. Rejected: a
  restricted-domain account is live for minutes or longer, and Okta has no way to defer
  the decision.
- **B. Fail closed on MMD errors.** Simplest, but turns away real sign-ups during every
  MMD outage.
- **C. Decide from a DynamoDB copy refreshed from MMD (chosen).** Decisions stay correct
  through MMD outages. Costs: a domain newly restricted in MMD takes up to 3 hours to
  take effect, and the copy needs a guarded refresh and a staleness alert.

## Design

### Sign-up check (registration hook)

- `RestrictedDomains.isRestricted(email)` keeps its signature and `email-addresses`
  parsing. It lowercases the parsed domain and does one DynamoDB `GetItem` on
  `DomainName = <domain>` against `DYNAMODB_RESTRICTED_DOMAINS`. A hit means restricted.
  This exactly matches today's Postgres rule (`lower(domain) = $1`, exact match, no
  subdomain or parent-domain matching).
- **Amended 2026-11-23: sub-domain rule.** The exact match above is replaced. An
  email's domain is blocked when it, or any parent domain of it, is in the table. A
  listed root domain blocks itself and all its sub-domains. A listed sub-domain blocks
  itself and its own sub-domains, but not its root or the root's other sub-domains.
  Source: May Workman's "MMD development notes" doc, approved by Jon Watson 2026-11-23.
  `isRestricted` sends the domain and each parent domain, down to two labels
  (never the top-level domain alone), that passes `normalizeDomain`'s checks, so
  `foo_bar.cru.org` still checks `cru.org`. They go as exact keys in one `BatchGetItem`. More than 100
  keys are split into parallel requests of 100. A hit decides. With no hit, unprocessed
  keys are resent after 50 ms and then 100 ms, and keys still unprocessed make the check
  throw, which the hook turns into the "try again" DENY.
- **Amended 2026-11-23: refresh marker (empty-table guard), approved by Jon.** An empty
  or never-refreshed table used to allow every sign-up, because finding no domain looked
  the same as "not restricted". Now:
  - The refresh writes an item with key `DomainName = '#refresh'` after every successful
    run, including a run with no changes, holding `LastSuccessAt` (ISO 8601 time) and
    `DomainCount` (MMD's domain count). It writes the marker last, and never when the
    zero-rows guard or the shrink guard trips or a write fails. Its scan leaves the
    marker out, so the marker is never diffed, deleted or counted toward the shrink
    limit. `normalizeDomain` rejects `#`, so the key can never be a domain.
  - `isRestricted` reads the marker in the same `BatchGetItem` as the domains (first
    request only, inside the 100-key limit). A domain found still blocks at once, even
    with no marker. Unprocessed keys, the marker included, are retried as before, and
    still unprocessed throws. Every key read with no domain and no marker throws "no
    refresh marker". Marker found and no domain found allows. The marker never counts as
    a domain hit.
  - So a table with no marker gives every sign-up the "try again" DENY and logs
    `restricted_domain_check_failed`, which fires the alert. A successful refresh ends it.
    Manual refresh:
    `cru app impersonate -n okta-hooks -e staging -- aws lambda invoke --function-name okta-hooks-stage-sync_restricted_domains --cli-binary-format raw-in-base64-out --payload '{}' /dev/stdout`
    (for prod: `-e production` and `okta-hooks-prod-sync_restricted_domains`).
- An address with no parseable domain stays "not restricted", as today.
- The registration bundle no longer imports `src/config/db.ts` or `pg`.
- Time budget: the DynamoDB client gets explicit short timeouts (for example 1,000 ms per
  request, at most 2 attempts) so the lookup either answers or fails well under 3 s. The
  Rollbar report in the error path must not push the response past the budget: bound the
  wait (for example `Promise.race` with about 500 ms). Not awaiting it at all loses the
  report, because the wrapper in `src/config/rollbar.ts` resolves only on Rollbar's
  callback and Lambda can freeze first. The builder picks the exact numbers; the requirement is that the hook answers in under
  2.5 s in every path, with the tests proving it.
- Responses, always HTTP 200 with an explicit command:
  - **Not restricted:** `com.okta.action.update` `{ registration: 'ALLOW' }`, plus the
    existing `com.okta.user.profile.update` (`theKeyGuid`, `orca: false`, and `locale`
    when allowed). Behavior is otherwise unchanged.
  - **Restricted:** unchanged: `{ registration: 'DENY' }` plus the
    `RESTRICTED_EMAIL_DOMAIN` error (English, with the fr_FR and pt_BR translations in
    `registration.ts`).
  - **Any error** (DynamoDB unreachable, timeout, throttling, missing table, or any other
    exception in the handler): `{ registration: 'DENY' }` plus a new error with reason
    `RESTRICTED_DOMAIN_CHECK_UNAVAILABLE` and a "please try again in a few minutes"
    summary. It is translated for the same locales as the restricted message (fr_FR and
    pt_BR today), and English otherwise. Both translations need a native speaker's check
    before release (French: May Workman or the Agapé team; Portuguese: to be found). The
    error is reported to Rollbar and emits the alert signal below.
- The `catch` that returns 204 is removed, along with its stale comment about a rethrow.

### Refresh from MMD (scheduled job)

- The existing `sync_restricted_domains` Lambda is repointed from the Google Sheet to MMD.
  Its handler calls a renamed `syncDomainsFromMmd()`.
- Source query, through the existing pool in `src/config/db.ts`:
  `SELECT DISTINCT domain FROM "Domains" WHERE is_idm_self_service_prevention = true`.
  (Changed 2026-11-23, PR #134: the query no longer lowercases. `normalizeDomain` cleans
  and case-folds every value, and the refresh skips and logs rows it rejects, including
  null or empty ones.)
- The job scans the table, diffs, and writes only the difference: puts for new domains,
  deletes for removed ones, in `BatchWrite` chunks of 25 (the DynamoDB maximum). Any
  `UnprocessedItems` are retried with a short back-off, and the run fails if items remain.
- **Guards (never wipe the copy):**
  - MMD unreachable or the query fails: write nothing, fail the run.
  - MMD returns zero rows: write nothing, fail the run.
  - The run would delete more than 10% of the current rows, or more than 100 rows,
    whichever is larger (the shrink guard): apply the adds, skip every delete, fail
    the run, and say so in the error (how many adds went in, how many deletes were
    skipped, and how to override). Adds only grow the restricted set, so they are
    always safe; holding them back would let newly restricted domains sign up. Every
    run fails the same way until someone acts, so the stale-copy alert fires. A
    deliberate large removal is done by invoking the job once with the event
    `{ "allowLargeDelete": true }`. The builder may adjust the thresholds after the
    parity check (Rollout step 1) shows real numbers; the rule stays "a big shrink needs a
    human".
- A failed run throws after reporting to Rollbar, so Lambda counts it as an error. The
  next run, 3 hours later, is the retry. Async retries for this function stay at the
  module default.
- Schedule: unchanged at `cron(0 0/3 * * ? *)` (every 3 hours) in stage and prod. A
  domain newly restricted in MMD blocks sign-ups within 3 hours; a manual invoke of the
  job applies it at once.
- The Google Sheet code is removed: `googleSheetDomains`, `syncDomainsFromGoogle`, the
  `@googleapis/sheets` dependency, `tests/mocks/googleapis-sheets.ts`, and related tests.
  The DynamoDB SDK dependencies stay.

### Alerts (OKHOOKS-8)

Two Datadog monitors per environment (prod required; stage optional and quiet), notifying
Jon only (`@jon.watson@cru.org`), defined in cru-terraform `applications/okta-hooks`:

1. **Stale copy:** no successful refresh in about two scheduled runs (a 7-hour window
   holds at least two 3-hour runs), or the job did not run at all (no data). The exact
   query lives in cru-terraform `applications/okta-hooks/monitors.tf`.
2. **Check errors:** any registration hook check error in the last 5-15 minutes.

The registration hook returns HTTP 200 even on error, so the Lambda error metric does
not see these. The hook must emit a signal Datadog receives. The builder must verify
which signal actually reaches Datadog for okta-hooks before choosing:
- a structured `console.error` line (for example `restricted_domain_check_failed` with
  the error code) and a log monitor, if okta-hooks Lambda logs are indexed in Datadog
  (earlier research disagreed on this); or
- a custom metric through the Datadog Lambda extension; or
- an error-tagged APM span on the registration function (APM spans for this function
  are confirmed present in Datadog).

### Terraform (cru-terraform, stage and prod)

- No schedule change: `sync_restricted_domains` stays at `cron(0 0/3 * * ? *)`. The
  function description, which still says "from Google Sheet", is left as is, because
  changing it publishes a new Lambda version and moves the `live` alias.
- No database or network change: `PG_*`, `use_vpc` and the security groups are set for
  the whole module, so the sync function already has the same MMD access as
  `registration` (verified in both environments).
- The table, the `AllowDynamoDBAccess` IAM statement, and the registration function's
  `DYNAMODB_RESTRICTED_DOMAINS` variable already exist. No change.
- Add the monitors in the root `applications/okta-hooks/` directory next to
  `datadog.tf`. Only the root has the Datadog provider and its lock file; adding the
  provider to `prod/` or `stage/` would need a lock-file regeneration, which we can't do
  locally.
- Never run Terraform locally. Atlantis plans; DevOps approves before apply.

### Cleanup outside Terraform

- Delete the Google secrets with `cru app secrets` in stage and prod:
  `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_RESTRICTED_DOMAINS_SHEET`. Only
  after prod runs the new refresh.
- Update okta-hooks `CLAUDE.md` (the Models section and the architecture list) to the new
  design.
- mmd-api's `CLAUDE.md` (around lines 82-83) still describes the retired feature flag and
  DynamoDB fallback. Correct it in a separate small PR in that repo, following its own
  `CLAUDE.md`.

## Rollout

okta-hooks is on Pipeline v2: merge builds nothing; a build deploys to stage; Jon promotes
to prod.

1. **Parity check, stage and prod (read-only):** compare the table's current contents
   (from the Google Sheet) with MMD's restricted set. Report additions and removals to
   Jon before any cutover. This also sets the guard thresholds.
2. **Terraform PR:** the two monitors. Apply
   after DevOps approval.
3. **Code PR** with tests and an independent review. Merge, build, confirm stage runs it.
4. **Stage verification:** run the refresh by hand (`cru app impersonate ... aws lambda
   invoke`, after Jon approves), confirm the table matches MMD, then in the Okta preview
   org confirm: a restricted domain gets our DENY message; a normal domain registers and
   gets `theKeyGuid`; with DynamoDB access forced to fail (a test-only method chosen by
   the builder, never in prod) the user sees the "try again" message.
5. Jon promotes to prod. Run the prod refresh once by hand, confirm the table matches
   MMD, then watch the first scheduled runs and a real sign-up.
6. Remove the Google secrets. Close OKHOOKS-7 and OKHOOKS-8.

The refresh must populate the table from MMD (step 4/5) before the hook's new code is
relied on in each environment. The table already holds the Sheet's 2,165 rows, so the
hook is never reading an empty table.

**Amended 2026-11-23: refresh marker.** With the empty-table guard, the hook needs the
marker that only a successful refresh by the new code writes. After the first deploy of
that code to an environment, invoke the refresh once right away (command in the Sign-up
check amendment), or every sign-up gets the "try again" DENY until the next scheduled
run, up to 3 hours later. If that run trips the shrink guard, it writes no marker, so
sign-ups stay denied until the `{"allowLargeDelete": true}` invoke succeeds.

## Testing

TDD. Unit tests mock DynamoDB and `pg`.

- Hook: explicit ALLOW (with the profile update) for a normal domain; DENY with
  `RESTRICTED_EMAIL_DOMAIN` for a restricted one, in English, fr_FR and pt_BR; DENY with
  `RESTRICTED_DOMAIN_CHECK_UNAVAILABLE` on DynamoDB error, timeout and throttling; DENY on
  any other thrown error; no response path ever returns 204; a hung DynamoDB or Rollbar
  call still answers inside the budget; case-insensitive domain matching; an address
  with no domain is allowed.
- Refresh: correct diff (adds, removes, no-op); chunking at 25 and retry of
  `UnprocessedItems`; the MMD-error and zero-rows guards write nothing and throw; a
  large shrink writes only the adds, sends no deletes, and throws, and a failed add
  surfaces its own error; `allowLargeDelete` bypasses only the shrink guard; null and mixed-case domains
  are normalized.
- `npm run lint`, `npm run typecheck`, and `npm run test` all pass with no skipped issues.

## Left to the builder

- Exact DynamoDB timeout and retry numbers, and how Rollbar is bounded, within the
  2.5 s requirement.
- Which Datadog signal the hook emits for check errors, after verifying what reaches
  Datadog.
- The exact French and Portuguese wording, each to be checked by a native speaker.
- Guard thresholds, adjusted from the parity check numbers.
- How to force a DynamoDB failure in stage for step 4, as long as it can't affect prod.
