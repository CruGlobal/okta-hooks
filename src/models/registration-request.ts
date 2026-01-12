interface UserProfile {
  firstName: string
  lastName: string
  login: string
  email: string
}

interface RegistrationRequestData {
  data: {
    userProfile: UserProfile
  }
}

class RegistrationRequest {
  private userProfile: UserProfile

  constructor(body: string) {
    const {
      data: { userProfile }
    } = JSON.parse(body) as RegistrationRequestData
    this.userProfile = userProfile
  }

  get firstName(): string {
    return this.userProfile.firstName
  }

  get lastName(): string {
    return this.userProfile.lastName
  }

  get login(): string {
    return this.userProfile.login
  }

  get email(): string {
    return this.userProfile.email
  }
}

export default RegistrationRequest
