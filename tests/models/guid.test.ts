import { describe, it, expect, vi } from 'vitest'
import GUID from '@/models/guid.js'
import { v4 as uuid } from 'uuid'

vi.mock('uuid', () => ({
  v4: vi.fn()
}))

describe('GUID', () => {
  describe('static create()', () => {
    it('should return lowercase uuid', () => {
      vi.mocked(uuid).mockReturnValue('1DACCAF3-3135-45EA-9C11-544D3EC388FF')
      expect(GUID.create()).toEqual('1daccaf3-3135-45ea-9c11-544d3ec388ff')
    })
  })
})
