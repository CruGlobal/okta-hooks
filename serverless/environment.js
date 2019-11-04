'use strict'

module.exports = () => {
  // Use dotenv to load local development overrides
  require('dotenv').config()
  return {
    ENVIRONMENT: process.env['ENVIRONMENT'] || 'development',
    ROLLBAR_ACCESS_TOKEN: process.env['ROLLBAR_ACCESS_TOKEN'] || '',
    OKTA_SHARED_SECRET: process.env['OKTA_SHARED_SECRET'] || 'sharingiscaring',
    OKTA_CLIENT_ORGURL: process.env['OKTA_CLIENT_ORGURL'] || 'https://cru.oktapreview.com/',
    OKTA_CLIENT_TOKEN: process.env['OKTA_CLIENT_TOKEN'] || 'secret',
    GOOGLE_CLIENT_EMAIL: process.env['GOOGLE_CLIENT_EMAIL'] || 'wilbur@example.com',
    GOOGLE_PRIVATE_KEY: process.env['GOOGLE_PRIVATE_KEY'] || '-----BEGIN PRIVATE KEY-----\nMIIEvA\n',
    GOOGLE_RESTRICTED_DOMAINS_SHEET: process.env['GOOGLE_RESTRICTED_DOMAINS_SHEET'] || 'google_sheet_id',
    GLOBAL_REGISTRY_TOKEN: process.env['GLOBAL_REGISTRY_TOKEN'] || 'secret',
    GLOBAL_REGISTRY_URL: process.env['GLOBAL_REGISTRY_URL'] || 'https://backend.global-registry.org'
  }
}
