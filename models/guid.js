import { v4 as uuid } from 'uuid'
import toLower from 'lodash/toLower'

class GUID {
  static create () {
    return toLower(uuid())
  }
}

export default GUID
