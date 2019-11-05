import rollbar from '../config/rollbar'
import UsersResponse from '../models/scim/users-response'
import GroupsResponse from '../models/scim/groups-response'

const GET_USERS = /^GET \/scim\/v2\/Users$/i
const GET_USER = /^GET \/scim\/v2\/Users\/(.+)$/i
const GET_GROUPS = /^GET \/scim\/v2\/Groups$/i

export const handler = async lambdaEvent => {
  try {
    console.log(JSON.stringify(lambdaEvent))
    const request = `${lambdaEvent.httpMethod} ${lambdaEvent.path}`
    if (GET_USERS.test(request)) {
      return new UsersResponse().toALBResponse()
    } else if (GET_GROUPS.test(request)) {
      return new GroupsResponse().toALBResponse()
    } else {
      await rollbar.warning(`Unknown Request: ${lambdaEvent.httpMethod} ${lambdaEvent.path}`, { lambdaEvent })
    }
  } catch (error) {
    await rollbar.error('SCIM error', error, { lambdaEvent })
    throw error
  }
}
