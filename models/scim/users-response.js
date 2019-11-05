import Response, { SCHEMA_LIST, SCHEMA_USER } from './response'

class UsersResponse extends Response {
  constructor () {
    super({ schema: SCHEMA_LIST })
  }

  buildBody () {
    return {
      ...super.buildBody(),
      totalResults: 1,
      startIndex: 1,
      itemsPerPage: 2,
      Resources: [{
        id: 1,
        userName: 'tony.stark@avengers.org',
        theKeyGuid: 'uuid',
        givenName: 'Tony',
        familyName: 'Stark',
        email: 'tony.stark@avengers.org',
        active: true,
        schemas: [SCHEMA_USER],
        meta: {
          resourceType: 'User',
          location: 'https://okta-hooks-preview.cru.org/scim/v2/Users/1'
        }
      }]
    }
  }
}

export default UsersResponse
