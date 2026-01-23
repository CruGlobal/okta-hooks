import { toLower } from 'lodash'

const equalsIgnoreCase = (string: unknown, target: unknown): boolean => {
  if (typeof string !== 'string' || typeof target !== 'string') {
    return false
  }
  return toLower(string) === toLower(target)
}

export default equalsIgnoreCase
