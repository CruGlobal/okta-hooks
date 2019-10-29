class RegistrationRequest {
  constructor (body) {
    const { data: { userProfile } } = JSON.parse(body)
    this.userProfile = userProfile
  }

  get firstName () {
    return this.userProfile.firstName
  }

  get lastName () {
    return this.userProfile.lastName
  }

  get login () {
    return this.userProfile.login
  }

  get email () {
    return this.userProfile.email
  }
}

export default RegistrationRequest
