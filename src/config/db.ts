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
