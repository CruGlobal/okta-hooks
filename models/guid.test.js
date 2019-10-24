import GUID from './guid'
import uuid from 'uuid/v4'

jest.mock('uuid/v4')

describe('GUID', () => {
  describe('static create()', () => {
    it('should return lowercase uuid', () => {
      uuid.mockReturnValue('1DACCAF3-3135-45EA-9C11-544D3EC388FF')
      expect(GUID.create()).toEqual('1daccaf3-3135-45ea-9c11-544d3ec388ff')
    })
  })
})
