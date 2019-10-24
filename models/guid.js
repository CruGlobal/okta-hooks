import uuid from 'uuid/v4'
import toLower from 'lodash/toLower'

class GUID {
  static create () {
    return toLower(uuid())
  }
}

export default GUID
