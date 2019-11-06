[![Coverage Status](https://coveralls.io/repos/github/CruGlobal/okta-hooks/badge.svg?branch=master)](https://coveralls.io/github/CruGlobal/okta-hooks?branch=master)

# Cru/Okta Web-hooks
Serverless project providing web-hooks that allow customization of Okta identity provider.

### Progress
- [x] generate guids for new accounts.
- [ ] prevent users from changing their email when it involves corporate email domains.
- [ ] populate some additional attributes when the user authenticates (employeeId, designation).
- [ ] sync the username to the email address, so when an email address is verified the username needs to be updated.


## Native Binaries
### getpass
eDirectory Universal Password Retrieval Utility
https://github.com/tjpatter/getpass


#### Compile for lambda
```shell script
./bin/update_getpass.sh
```
