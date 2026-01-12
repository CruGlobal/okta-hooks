import { parseOneAddress, ParsedMailbox } from 'email-addresses'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, ScanCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb'
import { auth, sheets } from '@googleapis/sheets'
import { compact, toLower, has, difference, concat, chunk, uniq } from 'lodash'

type DynamoDbRequestType = 'put' | 'delete'

interface DynamoDbPutRequest {
  PutRequest: { Item: { DomainName: string } }
}

interface DynamoDbDeleteRequest {
  DeleteRequest: { Key: { DomainName: string } }
}

type DynamoDbRequest = DynamoDbPutRequest | DynamoDbDeleteRequest

const dynamoDbRequest = (type: DynamoDbRequestType, domain: string): DynamoDbRequest => {
  switch (type) {
    case 'put':
      return {
        PutRequest: { Item: { DomainName: domain } }
      }
    case 'delete':
      return { DeleteRequest: { Key: { DomainName: domain } } }
  }
}

const getDocumentClient = () => {
  const client = new DynamoDBClient({})
  return DynamoDBDocumentClient.from(client)
}

class RestrictedDomains {
  static async isRestricted(emailAddress: string): Promise<boolean> {
    const parsedAddress = parseOneAddress(emailAddress) as ParsedMailbox | null

    if (!parsedAddress || !parsedAddress.domain) {
      return false
    }

    const documentClient = getDocumentClient()
    const result = await documentClient.send(
      new GetCommand({
        TableName: process.env.DYNAMODB_RESTRICTED_DOMAINS!,
        Key: { DomainName: toLower(parsedAddress.domain) }
      })
    )
    return has(result, 'Item')
  }

  async allDomains(): Promise<string[]> {
    const documentClient = getDocumentClient()
    const result = await documentClient.send(
      new ScanCommand({
        TableName: process.env.DYNAMODB_RESTRICTED_DOMAINS!
      })
    )
    return (result.Items ?? []).map((item) => item.DomainName as string)
  }

  async googleSheetDomains(): Promise<string[]> {
    const client = new auth.JWT({
      email: process.env.GOOGLE_CLIENT_EMAIL,
      key: `-----BEGIN PRIVATE KEY-----\n${process.env.GOOGLE_PRIVATE_KEY}\n-----END PRIVATE KEY-----\n`,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    })

    const googleSheets = sheets({ version: 'v4', auth: client })
    const response = await googleSheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_RESTRICTED_DOMAINS_SHEET,
      range: "'Okta self-service prevention'!A2:A" // Column A except header, sheet name requires single quotes
    })
    if (typeof response.data.values === 'undefined' || response.data.values === null) {
      throw new Error('Restricted Domains Google sheet returned empty response.')
    }
    return uniq(compact(response.data.values!.map((item) => toLower(item[0]))))
  }

  async syncDomainsFromGoogle(): Promise<void> {
    const [googleDomains, currentDomains] = await Promise.all([
      this.googleSheetDomains(),
      this.allDomains()
    ])
    const items = concat(
      difference(googleDomains, currentDomains).map((domain) => dynamoDbRequest('put', domain)),
      difference(currentDomains, googleDomains).map((domain) => dynamoDbRequest('delete', domain))
    )
    if (items.length) {
      const documentClient = getDocumentClient()
      await Promise.all(
        chunk(items, 20).map((batch) =>
          documentClient.send(
            new BatchWriteCommand({
              RequestItems: {
                [process.env.DYNAMODB_RESTRICTED_DOMAINS!]: batch
              }
            })
          )
        )
      )
    }
  }
}

export default RestrictedDomains
