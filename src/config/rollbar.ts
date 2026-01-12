import Rollbar from 'rollbar'

const environments = ['staging', 'production']
const rollbar = new Rollbar({
  // https://rollbar.com/docs/notifier/rollbar.js/#configuration-reference
  accessToken: process.env.ROLLBAR_ACCESS_TOKEN,
  // Enable rollbar on staging and production
  enabled: environments.includes(process.env.ENVIRONMENT ?? ''),
  captureUncaught: true,
  captureUnhandledRejections: true,
  payload: {
    environment: process.env.ENVIRONMENT,
    client: {
      javascript: {
        source_map_enabled: true,
        code_version: process.env.SOURCEMAP_VERSION,
        guess_uncaught_frames: true
      }
    }
  }
})

export default {
  error: (...args: Parameters<typeof rollbar.error>): Promise<unknown> =>
    new Promise((resolve) => rollbar.error(...args, resolve))
}
