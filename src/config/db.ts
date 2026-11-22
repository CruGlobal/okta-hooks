import pg from 'pg'

// MMD pool for the scheduled restricted-domains refresh only. The registration
// hook must never import it: its bundle must not carry pg. Module scope, so warm
// invocations reuse it (same pattern as mmd-api). No one waits on the refresh,
// so the timeouts are generous but still well inside the job's Lambda timeout.
const pool = new pg.Pool({
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  user: process.env.PG_USERNAME,
  password: process.env.PG_PASSWORD,
  port: parseInt(process.env.PG_PORT || '5432', 10),
  max: 1,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
  query_timeout: 30000
})

// Prevent an idle-connection termination from crashing the Lambda container.
pool.on('error', (error) => {
  console.error('Unexpected postgres pool error', error)
})

export default pool
