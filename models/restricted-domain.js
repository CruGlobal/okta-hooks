import { parseOneAddress } from 'email-addresses'
import { DynamoDB } from 'aws-sdk'
import toLower from 'lodash/toLower'
import has from 'lodash/has'

class RestrictedDomain {
  static async isRestricted (emailAddress) {
    const parsedAddress = parseOneAddress(emailAddress)

    const DocumentClient = new DynamoDB.DocumentClient()
    const result = await DocumentClient.get({
      TableName: 'okta-hooks-staging-restricted-domains', // process.env.DYNAMODB_RESTRICTED_DOMAINS,
      Key: { DomainName: toLower(parsedAddress.domain) }
    }).promise()
    return has(result, 'Item')
  }
}

export default RestrictedDomain
