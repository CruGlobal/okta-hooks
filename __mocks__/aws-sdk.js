const SNS = jest.fn()
SNS._publishMock = jest.fn()
SNS._publishPromiseMock = jest.fn()
SNS.mockImplementation(() => ({
  publish: SNS._publishMock
}))
SNS._publishMock.mockImplementation(() => ({
  promise: SNS._publishPromiseMock
}))

const DynamoDB = jest.fn()
DynamoDB._scanMock = jest.fn()
DynamoDB._scanPromiseMock = jest.fn()
DynamoDB.mockImplementation(() => ({
  scan: DynamoDB._scanMock
}))
DynamoDB._scanMock.mockImplementation(() => ({
  promise: DynamoDB._scanPromiseMock
}))

const DocumentClient = jest.fn()
DocumentClient._getMock = jest.fn()
DocumentClient._getPromiseMock = jest.fn()
DocumentClient._batchWriteMock = jest.fn()
DocumentClient._batchWritePromiseMock = jest.fn()
DocumentClient._scanMock = jest.fn()
DocumentClient._scanPromiseMock = jest.fn()
DocumentClient.mockImplementation(() => ({
  get: DocumentClient._getMock,
  batchWrite: DocumentClient._batchWriteMock,
  scan: DocumentClient._scanMock
}))
DocumentClient._getMock.mockImplementation(() => ({
  promise: DocumentClient._getPromiseMock
}))
DocumentClient._batchWriteMock.mockImplementation(() => ({
  promise: DocumentClient._batchWritePromiseMock
}))
DocumentClient._scanMock.mockImplementation(() => ({
  promise: DocumentClient._scanPromiseMock
}))
DynamoDB.DocumentClient = DocumentClient

const AWS = {
  DynamoDB,
  SNS
}

export { AWS as default, DynamoDB, SNS }
