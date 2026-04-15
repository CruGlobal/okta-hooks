import type { UserProfile } from '@okta/okta-sdk-nodejs'

/**
 * Okta user profile extended with the custom fields this project reads
 * and writes. Custom fields live on Okta's `UserProfile` via its
 * `[key: string]: CustomAttributeValue | ... | undefined` index signature;
 * this interface narrows the types we rely on so downstream code can use
 * them without per-site casts.
 */
export interface OktaUserProfile extends UserProfile {
  theKeyGuid: string
  login: string
  firstName: string
  lastName: string
  email?: string
  usDesignationNumber?: string
  usEmployeeId?: string
  thekeyGrPersonId?: string | null
  grMasterPersonId?: string | null
}
