export const mockGetUser = jest.fn()
export const mockListGroupUsers = jest.fn()
export const Client = jest.fn().mockImplementation(() => ({
  getUser: mockGetUser,
  listGroupUsers: mockListGroupUsers
}))
