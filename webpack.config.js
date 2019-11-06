const webpack = require('webpack')
const slsw = require('serverless-webpack')
const nodeExternals = require('webpack-node-externals')
const RollbarSourceMapPlugin = require('rollbar-sourcemap-webpack-plugin')
const CopyWebpackPlugin = require('copy-webpack-plugin')
const sourcemapVersion = require('child_process').execSync('git rev-parse --short HEAD').toString().trim()
const { find, get } = require('lodash')

module.exports = {
  entry: slsw.lib.entries,
  target: 'node',
  devtool: 'source-map',
  externals: [nodeExternals()],
  mode: slsw.lib.webpack.isLocal ? 'development' : 'production',
  performance: {
    hints: false
  },
  plugins: [
    new webpack.EnvironmentPlugin({
      SOURCEMAP_VERSION: sourcemapVersion
    }),
    {
      // Copies files mentioned in serverless.yml package.include to serverless package
      apply: compiler => {
        const handler = `${Object.keys(compiler.options.entry)[0]}.handler`
        const config = find(slsw.lib.serverless.service.functions, val => val.handler === handler)
        const includePaths = get(config, 'package.include', [])
        if (includePaths.length) {
          new CopyWebpackPlugin(includePaths).apply(compiler)
        }
      }
    },
    new RollbarSourceMapPlugin({
      accessToken: process.env.ROLLBAR_ACCESS_TOKEN,
      publicPath: '/var/task',
      version: sourcemapVersion
    })
  ]
}
