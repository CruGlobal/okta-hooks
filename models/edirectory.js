import LDAPClient from 'ldapjs-client'

const MAPPING = {
  cruCountryCode: 'c',
  login: 'cn,',
  email: 'uid,',
  firstName: 'givenname,',
  nickName: 'crupreferredname,',
  lastName: 'sn,',
  theKeyGuid: 'thekeyguid,',
  grMasterPersonId: 'thekeygrmasterpersonid,',
  thekeyGrPersonId: 'thekeygrpersonid,',
  managerId: 'crumanagerid,',
  organization: 'cruministrycode,',
  cruPayGroup: 'crupaygroup,',
  division: 'crusubministrycode,',
  emailAliases: 'cruproxyaddresses,',
  relayGuid: 'relayguid,',
  department: 'departmentnumber,',
  city: 'city,',
  state: 'st,',
  zipCode: 'postalcode,',
  primaryPhone: 'telephonenumber,',
  groupMembership: 'groupmembership,',
  thekeyAccountVerified: 'thekeyaccountverified,',
  thekeyPasswordForceChange: 'thekeypasswordforceChange,',
  passwordAllowChange: 'passwordallowChange,',
  loginDisabled: 'logindisabled,',
  usDesignationNumber: 'crudesignation,',
  usEmployeeId: 'employeenumber'
}

class eDirectory {
  constructor (url, user, password) {
    this.client = new LDAPClient({ url })
    this.user = user
    this.password = password
  }

  async fetchUser (guid) {
    try {
      await this.client.bind(this.user, this.password)
      const entries = await this.client.search('ou=sso,ou=account,dc=ccci,dc=org', {
        filter: `(thekeyGuid=${guid})`,
        scope: 'one',
        attributes: ['*', 'modifyTimestamp']
      })
      return entries[0]
    } finally {
      await this.client.unbind()
    }
  }
}

export default eDirectory
