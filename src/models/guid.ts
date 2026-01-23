import { v4 as uuid } from 'uuid'
import { toLower } from 'lodash'

class GUID {
  static create(): string {
    return toLower(uuid())
  }
}

export default GUID
