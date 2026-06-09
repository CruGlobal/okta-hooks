/**
 * Cru email-domain classification.
 *
 * Ported from us-onboarding (src/config/domains.ts) and kept self-contained here to
 * avoid a cross-repo dependency. If the canonical list changes there, update it here too.
 */

export const googleManagedDomains: string[] = [
  'cru.org',
  'allvox.com',
  'arrowheadconferences.org',
  'athletesinaction.org',
  'bridgesinternational.com',
  'cembassy.org',
  'crumilitary.org',
  'designmovement.org',
  'destino.org',
  'epicmovement.com',
  'facultycommons.org',
  'familylife.com',
  'isponline.org',
  'jesusfilm.org',
  'sightlineministry.org',
  'unto.com',
  'campuscrusadeforchrist.com',
  'ccci.org',
  'cru.comm',
  'crusade.org',
  'keynote.org',
  'studentventure.com'
]

/**
 * True when the email's domain is one of Cru's Google-managed (work) domains.
 */
export function hasCruDomain(email: string): boolean {
  const domain = email?.split('@')[1]?.toLowerCase()
  return domain ? googleManagedDomains.includes(domain) : false
}
