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
