import { vi } from 'vitest'

export const mockEntityGET = vi.fn()
export const mockEntityDELETE = vi.fn()
export const mockEntityPOST = vi.fn()

export const GRClient = vi.fn().mockImplementation(() => ({
  Entity: {
    get: mockEntityGET,
    delete: mockEntityDELETE,
    post: mockEntityPOST
  }
}))
