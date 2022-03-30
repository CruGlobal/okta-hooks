export const mockSpreadsheetsGet = jest.fn()

export const auth = {
  JWT: jest.fn()
}

export const sheets = jest.fn().mockImplementation(() => ({
  spreadsheets: {
    values: {
      get: mockSpreadsheetsGet
    }
  }
}))
