'use strict'

module.exports = () => {
  // Use dotenv to load local development overrides
  require('dotenv').config()
  return {
    ENVIRONMENT: process.env['ENVIRONMENT'] || 'development',
    ROLLBAR_ACCESS_TOKEN: process.env['ROLLBAR_ACCESS_TOKEN'] || '',
    OKTA_SHARED_SECRET: process.env['OKTA_SHARED_SECRET'] || 'sharingiscaring'
  }
}
