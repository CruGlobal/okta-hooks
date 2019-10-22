import uuid from 'uuid/v4'
import toLower from 'lodash/toLower'
import HookResponse, { COMMAND_USER_PROFILE_UPDATE } from '../../models/hook-response'

export const handler = async (lambdaEvent) => {
  const response = new HookResponse()
  response.addCommand(COMMAND_USER_PROFILE_UPDATE, {
    theKeyGuid: toLower(uuid())
  })
  return response.toALBResponse()
}
