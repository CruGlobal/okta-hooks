import { parseOneAddress } from 'email-addresses'
import { DynamoDB } from 'aws-sdk'
import { google } from 'googleapis'
import compact from 'lodash/compact'
import toLower from 'lodash/toLower'
import has from 'lodash/has'
import difference from 'lodash/difference'
import concat from 'lodash/concat'
import chunk from 'lodash/chunk'

class RestrictedDomains {
  static async isRestricted (emailAddress) {
    const parsedAddress = parseOneAddress(emailAddress)

    const documentClient = new DynamoDB.DocumentClient()
    const result = await documentClient.get({
      TableName: process.env.DYNAMODB_RESTRICTED_DOMAINS,
      Key: { DomainName: toLower(parsedAddress.domain) }
    }).promise()
    return has(result, 'Item')
  }

  async allDomains () {
    const documentClient = new DynamoDB.DocumentClient()
    const result = await documentClient.scan({
      TableName: process.env.DYNAMODB_RESTRICTED_DOMAINS
    }).promise()
    return result.Items.map(item => item.DomainName)
  }

  async googleSheetDomains () {
    const client = new google.auth.JWT({
      email: process.env.GOOGLE_CLIENT_EMAIL,
      key: `-----BEGIN PRIVATE KEY-----\n${process.env.GOOGLE_PRIVATE_KEY}\n-----END PRIVATE KEY-----\n`,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    })

    const sheets = google.sheets({ version: 'v4', auth: client })
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_RESTRICTED_DOMAINS_SHEET,
      range: "'Okta self-service prevention'!A2:A" // Column A except header, sheet name requires single quotes
    })
    if (typeof response.data.values === 'undefined') {
      throw new Error('Restricted Domains Google sheet returned empty response.')
    }
    return compact(response.data.values.map(item => toLower(item[0])))
  }

  async syncDomainsFromGoogle () {
    const [googleDomains, currentDomains] = await Promise.all([
      this.googleSheetDomains(),
      this.allDomains()
    ])
    const items = concat(
      difference(googleDomains, currentDomains).map(domain => dynamoDbRequest('put', domain)),
      difference(currentDomains, googleDomains).map(domain => dynamoDbRequest('delete', domain))
    )
    if (items.length) {
      const documentClient = new DynamoDB.DocumentClient()
      await Promise.all(chunk(items, 20).map(batch => documentClient.batchWrite({
        RequestItems: {
          [process.env.DYNAMODB_RESTRICTED_DOMAINS]: batch
        }
      }).promise()))
    }
  }
}

const dynamoDbRequest = (type, domain) => {
  switch (type) {
    case 'put':
      return {
        PutRequest: { Item: { DomainName: domain } }
      }
    case 'delete':
      return { DeleteRequest: { Key: { DomainName: domain } } }
  }
}

export default RestrictedDomains
