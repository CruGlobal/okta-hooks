const webpack = require('webpack')
const RollbarSourceMapPlugin = require('rollbar-sourcemap-webpack-plugin')
const path = require('path')
const TerserPlugin = require('terser-webpack-plugin')
const childProcess = require('child_process')

function git (command) {
  return childProcess.execSync(`git ${command}`, { encoding: 'utf8' }).trim()
}
const version = git('rev-parse --short HEAD')

module.exports = {
    mode: 'production',
    target: 'node',
    entry: {
        registration: './hooks/inline/registration.js',
        verification: './hooks/event/verification.js',
        events: './hooks/event/events.js',
        create: './sns/user/lifecycle/create.js',
        status_change: './sns/user/lifecycle/status-change.js',
        update_profile: './sns/user/account/update-profile.js',
        sync_restricted_domains: './schedule/sync-restricted-domains.js',
        sync_missing_okta_users: './schedule/sync-missing-okta-users.js'
    },
    output: {
        path: path.resolve(__dirname, 'dist'),
        chunkFormat: false,
        library: {
            type: 'commonjs2'
        }
    },
    module: {
        rules: [{
            exclude: [
                /datadog-lambda-js/,
                /dd-trace/
            ]
        }]
    },
    devtool: 'source-map',
    optimization: {
        minimize: true,
        minimizer: [
            new TerserPlugin({
                extractComments: false,
                terserOptions: {
                    format: {
                        comments: false
                    }
                }
            })
        ]
    },
    plugins: [
        new webpack.EnvironmentPlugin({
            SOURCEMAP_VERSION: version
        }),
        process.env.CI
            ? new RollbarSourceMapPlugin({
                accessToken: process.env.ROLLBAR_ACCESS_TOKEN,
                ignoreErrors: true,
                publicPath: '/var/task',
                version
            })
            : false
    ].filter(Boolean),
    ignoreWarnings: [
        {
            message: /aws-crt/
        }
    ]
}
