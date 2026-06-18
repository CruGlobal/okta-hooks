import { describe, it, expect } from 'vitest'
import { hasCruDomain } from '@/config/domains.js'

describe('hasCruDomain', () => {
  it('returns true for Google-managed Cru domains (case-insensitive)', () => {
    expect(hasCruDomain('jon.watson@cru.org')).toBe(true)
    expect(hasCruDomain('someone@familylife.com')).toBe(true)
    expect(hasCruDomain('SOMEONE@CRU.ORG')).toBe(true)
  })

  it('returns false for non-Cru domains', () => {
    expect(hasCruDomain('person@gmail.com')).toBe(false)
    expect(hasCruDomain('person@example.com')).toBe(false)
  })

  it('returns false for malformed input', () => {
    expect(hasCruDomain('not-an-email')).toBe(false)
    expect(hasCruDomain('')).toBe(false)
  })
})
