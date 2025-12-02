// Simple script to bundle mediasoup-client for browser
const browserify = require('browserify');
const fs = require('fs');

console.log('Bundling mediasoup-client for browser...');

browserify({
  entries: ['node_modules/mediasoup-client/lib/index.js'],
  standalone: 'mediasoup'
})
.transform('babelify', {
  presets: ['@babel/preset-env'],
  global: true
})
.bundle()
.pipe(fs.createWriteStream('public/mediasoup-client.min.js'))
.on('finish', () => {
  const size = fs.statSync('public/mediasoup-client.min.js').size;
  console.log(`✓ Built successfully! Size: ${(size / 1024 / 1024).toFixed(2)} MB`);
});

