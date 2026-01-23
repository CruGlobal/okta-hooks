import { vi } from 'vitest'

export const mockSpreadsheetsGet = vi.fn()

export const auth = {
  JWT: vi.fn()
}

export const sheets = vi.fn().mockImplementation(() => ({
  spreadsheets: {
    values: {
      get: mockSpreadsheetsGet
    }
  }
}))
