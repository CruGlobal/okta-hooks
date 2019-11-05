export const mockEntityGET = jest.fn()
export const mockEntityDELETE = jest.fn()
export const mockEntityPOST = jest.fn()

export const GRClient = jest.fn().mockImplementation(() => ({
  Entity: {
    get: mockEntityGET,
    delete: mockEntityDELETE,
    post: mockEntityPOST
  }
}))
