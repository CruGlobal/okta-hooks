import { CruFlags } from '@cruglobal/flags'

// Pipeline v2 feature flags. CRU_FLAGS_URL is injected by the aws/lambda/app
// terraform module in deployed environments; unset (local, tests) the client
// is inert and every flag reads disabled.
// On-demand mode: Lambda freezes between invocations, so refreshing rides on
// reads instead of a poll timer (at most one conditional GET per 30s).
const flags = new CruFlags({ refreshMode: 'on-demand' })

export default flags
