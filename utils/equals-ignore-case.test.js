import equalsIgnoreCase from './equals-ignore-case'

describe('equalsIgnoreCase( string, target )', () => {
  it('should return if strings are the same ignoring case', () => {
    expect(equalsIgnoreCase('aBcDeFg', 'AbcDeFG')).toBeTruthy()
    expect(equalsIgnoreCase('', '')).toBeTruthy()
    expect(equalsIgnoreCase(undefined, null)).toBeFalsy()
    expect(equalsIgnoreCase('aBcDeFg')).toBeFalsy()
    expect(equalsIgnoreCase('', 'aBcDeFg')).toBeFalsy()
    expect(equalsIgnoreCase('aBcDeFg', '0123456')).toBeFalsy()
  })
})
