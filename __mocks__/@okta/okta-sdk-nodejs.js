import forEach from 'lodash/forEach'

const values = {
  users: []
}
export const setUsers = (users = []) => {
  values.users = users
}
export const mockGetUser = jest.fn()
export const mockListGroupUsers = jest.fn(() => ({
  each: fn => forEach(values.users, fn)
}))
export const Client = jest.fn().mockImplementation(() => ({
  getUser: mockGetUser,
  listGroupUsers: mockListGroupUsers
}))
