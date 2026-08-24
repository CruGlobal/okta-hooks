import pg from 'pg'

// Module-scope pool, reused across warm Lambda invocations (same pattern as mmd-api).
const pool = new pg.Pool({
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  user: process.env.PG_USERNAME,
  password: process.env.PG_PASSWORD,
  port: parseInt(process.env.PG_PORT || '5432', 10),
  max: 1,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 2000,
  query_timeout: 2000
})

// Prevent an idle-connection termination from crashing the Lambda container.
pool.on('error', (error) => {
  console.error('Unexpected postgres pool error', error)
})

export default pool
