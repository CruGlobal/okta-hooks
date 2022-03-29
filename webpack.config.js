const webpack = require('webpack')
const slsw = require('serverless-webpack')
const nodeExternals = require('webpack-node-externals')
const RollbarSourceMapPlugin = require('rollbar-sourcemap-webpack-plugin')
const childProcess = require('child_process')

function git (command) {
  return childProcess.execSync(`git ${command}`, { encoding: 'utf8' }).trim()
}

module.exports = (async () => {
  const version = git('rev-parse --short HEAD')
  return {
    entry: slsw.lib.entries,
    target: 'node',
    devtool: 'source-map',
    mode: slsw.lib.webpack.isLocal ? 'development' : 'production',
    externals: [nodeExternals()],
    performance: {
      hints: false
    },
    plugins: [
      new webpack.EnvironmentPlugin({
        SOURCEMAP_VERSION: version
      }),
      process.env.CI
        ? new RollbarSourceMapPlugin({
          accessToken: process.env.ROLLBAR_ACCESS_TOKEN,
          publicPath: '/var/task',
          version: version
        })
        : false
    ].filter(Boolean)
  }
})()
