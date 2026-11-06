const path = require('path');

module.exports = {
  entry: './src/app.jsx', // Fixed: points to your actual file
  output: {
    path: path.resolve(__dirname, 'assets'),
    filename: 'bundle.js',
  },
  resolve: {
    extensions: ['.js', '.jsx'],
  },
  module: {
    rules: [
      {
        test: /\.jsx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            sourceType: 'unambiguous',
            presets: [
              ['@babel/preset-env', {
                targets: {
                  browsers: ['last 2 versions']
                }
              }],
              ['@babel/preset-react', {
                runtime: 'automatic'
              }]
            ],
          },
        },
      },
    ],
  },
  mode: 'development',
  devtool: 'source-map', // Added for easier debugging
};