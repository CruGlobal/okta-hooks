export const mockGetUser = jest.fn()
export const Client = jest.fn().mockImplementation(() => ({
  getUser: mockGetUser
}))
