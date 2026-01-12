import { vi } from 'vitest'
import { forEach } from 'lodash'

interface MockUser {
  id: string
  profile?: Record<string, unknown>
  status?: string
  update?: () => Promise<void>
}

const values: { users: MockUser[] } = {
  users: []
}

export const setUsers = (users: MockUser[] = []) => {
  values.users = users
}

export const mockGetUser = vi.fn()
export const mockListGroupUsers = vi.fn(() => ({
  each: (fn: (user: MockUser) => boolean | void) => forEach(values.users, fn)
}))

export const Client = vi.fn().mockImplementation(() => ({
  userApi: {
    getUser: mockGetUser
  },
  groupApi: {
    listGroupUsers: mockListGroupUsers
  }
}))
