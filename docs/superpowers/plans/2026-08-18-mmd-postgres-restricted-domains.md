# Restricted Domains via MMD Postgres — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Point okta-hooks' restricted-domain registration check at MMD Postgres and retire the Google Sheet + DynamoDB pipeline.

**Architecture:** The ALB registration inline hook queries MMD Postgres directly (`Domains.is_idm_self_service_prevention = true`) through a module-scope `pg.Pool`. A dedicated read-only Postgres user `okta_hooks` is created in MMD's Terraform; okta-hooks' Terraform consumes it via remote state and gains a dedicated Lambda security group with an ingress rule into the MMD RDS SG. The DynamoDB cache, 3-hour sync Lambda, and Google Sheets integration are deleted after cutover.

**Tech Stack:** TypeScript, Vitest, esbuild, `pg`, AWS Lambda, Terraform (Atlantis CI/CD).

**Spec:** `docs/superpowers/specs/2026-08-18-mmd-postgres-restricted-domains-design.md`

## Global Constraints

- **Never run `terraform`/`tofu` locally.** Push branches; Atlantis auto-plans. A failed Atlantis plan is the feedback loop.
- cru-terraform work: check `git status` in BOTH `~/Source/cru-terraform` and `~/Source/cru-terraform-2`; use a directory on master (or with a merged/closed PR + clean tree), branch from freshly pulled master.
- okta-hooks PRs target `master`. Stage deploy = `On Staging` label (verify the merge actually landed on `origin/staging`; the action fails silently on conflict). Prod deploy = merge to `master`.
- **PROD GATE:** production Postgres data is NOT built out yet (Ric Poolman leads). Tasks 6–8 do not start until Ric confirms the prod pipeline is running.
- No AI branding in commits. Concise commit messages.
- Env var names: `PG_HOST`, `PG_DATABASE`, `PG_USERNAME`, `PG_PASSWORD`, `PG_PORT`.
- Registration hook must keep failing open (204) on any error — do not change `registration.ts`.
- Cross-session state lives in the knowledge-graph entity `okta-hooks MMD Postgres Migration`; the orchestrator updates its STATUS observation after each task.

---

### Task 1: Stage parity check (human-in-the-loop)

**Files:**
- Create: `scratchpad or scripts/parity-check.ts` (throwaway; do NOT commit)

**Interfaces:**
- Consumes: stage DynamoDB table `okta-hooks-stage-restricted-domains`; stage MMD Postgres.
- Produces: a diff report for Jon. No code artifacts.

- [ ] **Step 1: Write the throwaway script** in the session scratchpad:

```typescript
// parity-check.ts — throwaway. Run with: npx vite-node parity-check.ts (or tsx)
// Requires: okta-hooks stage AWS role assumed (DynamoDB), and MMD stage PG creds in env.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb'
import pg from 'pg'

const TABLE = 'okta-hooks-stage-restricted-domains'

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const pool = new pg.Pool({
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  user: process.env.PG_USERNAME,
  password: process.env.PG_PASSWORD,
  port: parseInt(process.env.PG_PORT || '5432', 10),
  max: 1,
  ssl: { rejectUnauthorized: false }
})

const dynamoDomains = new Set<string>()
let lastKey: Record<string, unknown> | undefined
do {
  const page = await dynamo.send(new ScanCommand({ TableName: TABLE, ExclusiveStartKey: lastKey }))
  for (const item of page.Items ?? []) dynamoDomains.add((item.DomainName as string).toLowerCase())
  lastKey = page.LastEvaluatedKey
} while (lastKey)

const result = await pool.query(
  'SELECT lower(domain) AS domain FROM "Domains" WHERE is_idm_self_service_prevention = true'
)
const pgDomains = new Set<string>(result.rows.map((r) => r.domain))
await pool.end()

const onlyDynamo = [...dynamoDomains].filter((d) => !pgDomains.has(d)).sort()
const onlyPg = [...pgDomains].filter((d) => !dynamoDomains.has(d)).sort()
console.log(`DynamoDB: ${dynamoDomains.size} domains; Postgres flagged: ${pgDomains.size}`)
console.log(`In DynamoDB only (would STOP being blocked): ${onlyDynamo.length}`)
onlyDynamo.forEach((d) => console.log(`  - ${d}`))
console.log(`In Postgres only (would START being blocked): ${onlyPg.length}`)
onlyPg.forEach((d) => console.log(`  + ${d}`))
```

- [ ] **Step 2: Have Jon run it.** Claude must NOT run `cru app assume-role` (credentials don't persist from sub-shells). Ask Jon to run in his terminal: `cru app assume-role -n okta-hooks -e staging`, then set the PG env vars (his personal `jwatson` creds from `~/Source/mmd-api/.env` work from Cru IP/VPN), then run the script and paste the output.
- [ ] **Step 3: Review the diff with Jon.** Domains "in DynamoDB only" stop being blocked after cutover — Jon decides whether any need flagging in MMD (via Jason Buckner/Okta Workflows) before proceeding. Record the outcome in the knowledge-graph STATUS observation.

### Task 2: Terraform PR 1 — additive infra (stage + prod)

**Files:**
- Modify: `applications/ministry-managed-domains/stage/database.tf` (module `postgres` call, around line 139)
- Modify: `applications/ministry-managed-domains/stage/outputs.tf`
- Modify: `applications/ministry-managed-domains/prod/database.tf` + `prod/outputs.tf` (mirror stage; preserve any existing entries)
- Create: `applications/okta-hooks/stage/mmd.tf` and `applications/okta-hooks/prod/mmd.tf`
- Modify: `applications/okta-hooks/stage/application.tf` and `prod/application.tf`

**Interfaces:**
- Consumes: existing MMD `module.postgres` (`database/postgres` module: `db_utility_users`, `db_read_all_public`, `utility_users_passwords` output); existing MMD RDS SG named `rds-ministry-managed-domains-{stage|prod}`; okta-hooks `module.okta_hooks` (`aws/lambda/app` v39.2.0, supports `security_group_ids`).
- Produces: remote-state outputs `okta_hooks_username` / `okta_hooks_password`; SSM params `PG_HOST/PG_DATABASE/PG_USERNAME/PG_PASSWORD/PG_PORT` for all okta-hooks functions; SG `okta-hooks-{env}-lambda` attached to the Lambdas.

- [ ] **Step 1: Pick a free cru-terraform working dir** (per Global Constraints), `git checkout master && git pull`, branch `okta-hooks-mmd-postgres`.
- [ ] **Step 2: MMD stage — add the utility user.** In `stage/database.tf` module `"postgres"`, add/extend:

```hcl
  db_utility_users = ["okta_hooks"]
  db_read_all_public = [
    "intf_de",
    "okta_hooks",
  ]
```

(`db_read_all_public` already contains `intf_de`; keep it. If prod's module call differs, apply the same two additions there, preserving existing entries.)

- [ ] **Step 3: MMD stage — add outputs** to `stage/outputs.tf`:

```hcl
output "okta_hooks_username" {
  description = "Read-only Postgres user for okta-hooks"
  value       = "okta_hooks"
}

output "okta_hooks_password" {
  description = "Password for the okta-hooks read-only Postgres user"
  value       = module.postgres.utility_users_passwords["okta_hooks"]
  sensitive   = true
}
```

- [ ] **Step 4: Mirror Steps 2–3 in `prod/database.tf` and `prod/outputs.tf`.**
- [ ] **Step 5: okta-hooks stage — create `stage/mmd.tf`:**

```hcl
data "terraform_remote_state" "mmd" {
  backend = "s3"
  config = {
    encrypt      = true
    bucket       = "cru-tf-remote-state"
    use_lockfile = true
    region       = "us-east-1"
    key          = "applications/ministry-managed-domains/stage/terraform.tfstate"
  }
}

data "aws_security_group" "mmd_rds" {
  vpc_id = data.aws_vpc.main.id
  name   = "rds-ministry-managed-domains-stage"
}

resource "aws_security_group" "lambda" {
  name        = "${local.identifier}-${local.env}-lambda"
  description = "Security group for ${local.identifier} Lambda functions"
  vpc_id      = data.aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "mmd_rds_from_okta_hooks" {
  security_group_id            = data.aws_security_group.mmd_rds.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.lambda.id
  description                  = "Allow okta-hooks Lambdas to reach MMD Postgres"
}
```

(`data.aws_vpc.main` already exists in `stage/data.tf`. The standalone ingress rule coexists with the RDS module's own rules — same approach as mmd-api prod, cru-terraform PR #11461.)

- [ ] **Step 6: okta-hooks stage — wire the module.** In `stage/application.tf` module `"okta_hooks"`, add below `use_vpc = true`:

```hcl
  security_group_ids = [aws_security_group.lambda.id]
```

and add to the `parameters` map:

```hcl
    PG_HOST     = data.terraform_remote_state.mmd.outputs.rds_address
    PG_DATABASE = data.terraform_remote_state.mmd.outputs.rds_database
    PG_USERNAME = data.terraform_remote_state.mmd.outputs.okta_hooks_username
    PG_PASSWORD = data.terraform_remote_state.mmd.outputs.okta_hooks_password
    PG_PORT     = "5432"
```

- [ ] **Step 7: Mirror Steps 5–6 in `prod/` (remote-state key `.../ministry-managed-domains/prod/...`, SG name `rds-ministry-managed-domains-prod`).** Prod's `data.tf` should already have `data.aws_vpc.main`; add it in `mmd.tf` if not.
- [ ] **Step 8: Commit and push; open PR** titled "okta-hooks: read-only MMD Postgres access for restricted domains". PR description MUST state the apply order: `ministry-managed-domains/stage` and `/prod` FIRST (creates user + outputs), then `atlantis plan -d applications/okta-hooks/stage` / `-d .../prod` re-plans, then apply those. The okta-hooks plans are EXPECTED to fail until the MMD dirs are applied (missing outputs).
- [ ] **Step 9: Iterate until MMD-dir plans are clean; get DevOps approval; drive applies via PR comments** (`atlantis apply -d <dir>` in the stated order, re-planning okta-hooks dirs after the MMD applies). Do not merge until all four dirs are applied.

### Task 3: Code — Postgres-backed `RestrictedDomains` (TDD)

**Files:**
- Create: `src/config/db.ts`
- Modify: `src/models/restricted-domains.ts` (full rewrite)
- Modify: `tests/models/restricted-domains.test.ts` (full rewrite)
- Modify: `.env`, `.env.test`
- Modify: `package.json` (add `pg`, `@types/pg`)

**Interfaces:**
- Consumes: env vars `PG_HOST/PG_DATABASE/PG_USERNAME/PG_PASSWORD/PG_PORT`; `email-addresses` `parseOneAddress`.
- Produces: `RestrictedDomains.isRestricted(emailAddress: string): Promise<boolean>` (signature unchanged — `registration.ts` and its tests are untouched); default-export `pool` from `src/config/db.ts`.

- [ ] **Step 1: Branch in okta-hooks** off the existing `mmd-postgres-restricted-domains` branch (it already holds the spec; continue on it).
- [ ] **Step 2: Install deps:** `npm install pg && npm install -D @types/pg`
- [ ] **Step 3: Write `src/config/db.ts`:**

```typescript
import pg from 'pg'

// Module-scope pool, reused across warm Lambda invocations (same pattern as mmd-api).
const pool = new pg.Pool({
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  user: process.env.PG_USERNAME,
  password: process.env.PG_PASSWORD,
  port: parseInt(process.env.PG_PORT || '5432', 10),
  max: 1,
  ssl: { rejectUnauthorized: false }
})

export default pool
```

- [ ] **Step 4: Rewrite the test file** `tests/models/restricted-domains.test.ts` (replaces the DynamoDB/Sheets version entirely):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import RestrictedDomains from '@/models/restricted-domains.js'
import pool from '@/config/db.js'

vi.mock('@/config/db.js', () => ({
  default: { query: vi.fn() }
}))

const mockQuery = vi.mocked(pool.query)

describe('RestrictedDomains', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('static isRestricted(emailAddress)', () => {
    it('is true when the domain is flagged in MMD Postgres', async () => {
      mockQuery.mockResolvedValue({ rowCount: 1, rows: [{ '?column?': 1 }] } as never)
      const result = await RestrictedDomains.isRestricted('tony.stark@Avengers.org')
      expect(result).toBe(true)
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT 1 FROM "Domains" WHERE lower(domain) = $1 AND is_idm_self_service_prevention = true LIMIT 1',
        ['avengers.org']
      )
    })

    it('is false when the domain is not flagged', async () => {
      mockQuery.mockResolvedValue({ rowCount: 0, rows: [] } as never)
      const result = await RestrictedDomains.isRestricted('tony.stark@avengers.org')
      expect(result).toBe(false)
    })

    it('is false for an invalid email address without querying', async () => {
      const result = await RestrictedDomains.isRestricted('not-a-valid-email')
      expect(result).toBe(false)
      expect(mockQuery).not.toHaveBeenCalled()
    })

    it('propagates query errors (registration handler fails open)', async () => {
      mockQuery.mockRejectedValue(new Error('connection refused'))
      await expect(RestrictedDomains.isRestricted('tony.stark@avengers.org'))
        .rejects.toThrow('connection refused')
    })
  })
})
```

- [ ] **Step 5: Run the test to verify it fails:** `npm run test tests/models/restricted-domains.test.ts` — expect FAIL (model still imports DynamoDB/Sheets; old methods gone from test's perspective).
- [ ] **Step 6: Rewrite `src/models/restricted-domains.ts`:**

```typescript
import { parseOneAddress, ParsedMailbox } from 'email-addresses'
import { toLower } from 'lodash'
import pool from '../config/db.js'

class RestrictedDomains {
  static async isRestricted(emailAddress: string): Promise<boolean> {
    const parsedAddress = parseOneAddress(emailAddress) as ParsedMailbox | null

    if (!parsedAddress || !parsedAddress.domain) {
      return false
    }

    const result = await pool.query(
      'SELECT 1 FROM "Domains" WHERE lower(domain) = $1 AND is_idm_self_service_prevention = true LIMIT 1',
      [toLower(parsedAddress.domain)]
    )
    return (result.rowCount ?? 0) > 0
  }
}

export default RestrictedDomains
```

- [ ] **Step 7: Run the model and registration tests to verify they pass:** `npm run test tests/models/restricted-domains.test.ts tests/handlers/alb/registration.test.ts` — expect PASS (registration tests spy on `isRestricted`, unchanged).
- [ ] **Step 8: Update env files.** In `.env`, delete `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_RESTRICTED_DOMAINS_SHEET` and any `DYNAMODB_RESTRICTED_DOMAINS`; add empty `PG_HOST=`, `PG_DATABASE=`, `PG_USERNAME=`, `PG_PASSWORD=`, `PG_PORT=5432`. In `.env.test`, replace lines 2–5 (DYNAMODB/GOOGLE vars) with `PG_HOST=localhost`, `PG_DATABASE=test`, `PG_USERNAME=test`, `PG_PASSWORD=test`, `PG_PORT=5432`.
- [ ] **Step 9: Commit:** `git add -A && git commit -m "Read restricted domains from MMD Postgres"`

### Task 4: Code — delete the Sheets/DynamoDB sync pipeline

**Files:**
- Delete: `src/handlers/schedule/sync-restricted-domains.ts`, `tests/handlers/schedule/sync-restricted-domains.test.ts`, `tests/mocks/googleapis-sheets.ts`
- Modify: `tests/mocks/aws-sdk-v3.ts` (remove DynamoDB exports only; SNS mocks stay — used by `events.test.ts` and `sync-missing-okta-users.test.ts`)
- Modify: `esbuild.config.mjs` (remove sync entry; externalize `pg-native`)
- Modify: `package.json` (remove `@googleapis/sheets`, `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`)

**Interfaces:**
- Consumes: Task 3's rewritten model (no `allDomains`/`googleSheetDomains`/`syncDomainsFromGoogle` callers remain after deletion).
- Produces: build with 7 handlers (no `sync_restricted_domains`).

- [ ] **Step 1: Delete the three files:** `git rm src/handlers/schedule/sync-restricted-domains.ts tests/handlers/schedule/sync-restricted-domains.test.ts tests/mocks/googleapis-sheets.ts`
- [ ] **Step 2: Trim `tests/mocks/aws-sdk-v3.ts`:** remove `mockDynamoDBSend`, `DynamoDBClient`, `DynamoDBDocumentClient`, `GetCommand`, `ScanCommand`, `BatchWriteCommand`. Keep `mockSNSSend`, `SNSClient`, `PublishCommand`.
- [ ] **Step 3: Update `esbuild.config.mjs`:** delete the line `'./src/handlers/schedule/sync-restricted-domains.ts': 'sync_restricted_domains',` and change the external array to:

```javascript
    external: [
      // AWS SDK v3 is included in Lambda runtime
      '@aws-sdk/*',
      // Optional native binding referenced by pg; not installed
      'pg-native'
    ],
```

- [ ] **Step 4: Remove deps:** `npm uninstall @googleapis/sheets @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb`
- [ ] **Step 5: Full verification:** `npm run lint && npm run typecheck && npm run test && npm run build` — all pass; build reports "Built 7 handlers".
- [ ] **Step 6: Commit:** `git add -A && git commit -m "Remove Google Sheets/DynamoDB restricted-domains sync"`

### Task 5: Stage rollout and verification (human-in-the-loop)

**Files:** none (process task)

**Interfaces:**
- Consumes: Task 2's applied stage infra; Tasks 3–4 on branch `mmd-postgres-restricted-domains`.
- Produces: verified stage behavior; go/no-go for the prod gate.

- [ ] **Step 1: Open the okta-hooks PR** to `master`; run the standard review pass (superpowers:requesting-code-review) and fix findings.
- [ ] **Step 2: Add the `On Staging` label.** Then VERIFY the merge landed: `git fetch && git log --oneline origin/staging --grep=mmd-postgres` (the action fails silently on conflict; if nothing merged, reconcile `staging` ← `master` first, then remove/re-add the label).
- [ ] **Step 3: Verify in oktapreview with Jon:** a domain flagged in stage MMD Postgres gets registration DENY ("help@checkmyokta.com must be contacted..."); a normal domain registers and receives `theKeyGuid`. Check Datadog/Rollbar for registration-Lambda errors (e.g. connection timeouts would show as fail-open 204s with Rollbar entries, not user-visible failures — Rollbar is the signal).
- [ ] **Step 4: Update the knowledge-graph STATUS observation** (stage verified, awaiting prod gate).

### Task 6: PROD GATE — hold

- [ ] **Step 1: Wait for Ric Poolman to confirm the production Postgres pipeline is up and running.** Do not proceed to Tasks 7–8 before this. (Contact: ric@cru.org.sg.)
- [ ] **Step 2: Re-run the Task 1 parity check against PROD** (table `okta-hooks-prod-restricted-domains` — prod `local.env` is `prod`; prod PG host `ministry-managed-domains-prod.ctzggtk79wff.us-east-1.rds.amazonaws.com`, database `ministry-managed-domains_prod`). Review the diff with Jon.

### Task 7: Production cutover

- [ ] **Step 1: Merge the okta-hooks PR to `master`** (deploys to prod).
- [ ] **Step 2: Verify in production Okta with Jon** (same checks as Task 5 Step 3, production domains/Rollbar).
- [ ] **Step 3: Update the knowledge-graph STATUS observation.**

### Task 8: Terraform PR 2 — cleanup

**Files:**
- Modify: `applications/okta-hooks/{stage,prod}/application.tf` — remove the `sync_restricted_domains` function block, its `aws_cloudwatch_event_rule` map entry (`"sync_restricted_domains" = "cron(0 0/3 * * ? *)"`), the `DYNAMODB_RESTRICTED_DOMAINS` environment entries on `registration`, and the `AllowDynamoDBAccess` IAM statement.
- Delete: `applications/okta-hooks/{stage,prod}/dynamodb.tf`

**Interfaces:**
- Consumes: verified prod cutover (Task 7).
- Produces: retired DynamoDB/sync infrastructure.

- [ ] **Step 1: Branch from fresh master in a free cru-terraform dir;** make the removals above in both env dirs. The plan should show: destroy 1 DynamoDB table, 1 EventBridge rule/target/permission, 1 Lambda function per env; no other changes.
- [ ] **Step 2: Open PR, let Atlantis plan, confirm the destroy set matches Step 1, get approval, apply both dirs, merge.**
- [ ] **Step 3: Manual SSM cleanup with Jon:** delete the manually-created params `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_RESTRICTED_DOMAINS_SHEET` under `/ecs/okta-hooks/staging/*` and `/ecs/okta-hooks/production/*` (list first with `cru app secrets list --visibility ALL -n okta-hooks -e <env>` to confirm exact names; never print values).
- [ ] **Step 4: Final knowledge-graph update:** mark the migration entity complete; move the okta-hooks entity observation from "currently reads from sheet" to "reads from MMD Postgres".
