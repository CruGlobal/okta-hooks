import toLower from 'lodash/toLower'

const equalsIgnoreCase = (string, target) => {
  if (typeof string !== 'string' || typeof target !== 'string') {
    return false
  }
  return toLower(string) === toLower(target)
}

export default equalsIgnoreCase
