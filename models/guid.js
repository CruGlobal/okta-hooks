import uuid from 'uuid/v4'
import toLower from 'lodash/toLower'

const GUID_REGEX = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){4}[0-9a-f]{8}$/i

class GUID {
  static create () {
    return toLower(uuid())
  }

  static test (value) {
    return GUID_REGEX.test(value)
  }
}

export default GUID
