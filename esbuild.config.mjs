import * as esbuild from 'esbuild'
import { execSync } from 'child_process'

const version = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()

// Map source handlers to Terraform-expected output names
const handlerMap = {
  './src/handlers/alb/registration.ts': 'registration',
  './src/handlers/alb/verification.ts': 'verification',
  './src/handlers/alb/events.ts': 'events',
  './src/handlers/sns/user-lifecycle-create.ts': 'create',
  './src/handlers/sns/user-lifecycle-status-change.ts': 'status_change',
  './src/handlers/sns/user-account-update-profile.ts': 'update_profile',
  './src/handlers/schedule/sync-restricted-domains.ts': 'sync_restricted_domains',
  './src/handlers/schedule/sync-missing-okta-users.ts': 'sync_missing_okta_users'
}

// Build each handler as a separate bundle with flat output
// Using CommonJS format for DataDog Lambda layer compatibility
for (const [input, output] of Object.entries(handlerMap)) {
  await esbuild.build({
    entryPoints: [input],
    bundle: true,
    platform: 'node',
    target: 'node22',
    outfile: `dist/${output}.js`,
    sourcemap: true,
    format: 'cjs',
    external: [
      // AWS SDK v3 is included in Lambda runtime
      '@aws-sdk/*'
    ],
    define: {
      'process.env.SOURCEMAP_VERSION': JSON.stringify(version)
    }
  })
}

console.log(`Built ${Object.keys(handlerMap).length} handlers`)
