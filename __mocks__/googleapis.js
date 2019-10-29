export const mockSpreadsheetsGet = jest.fn()

export const google = {
  auth: {
    JWT: jest.fn()
  },
  sheets: jest.fn().mockImplementation(() => ({
    spreadsheets: {
      values: {
        get: mockSpreadsheetsGet
      }
    }
  }))
}
