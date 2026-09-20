const http = require('http');

const data = JSON.stringify({ text: 'test' });

const options = {
  hostname: 'localhost',
  port: 5001,
  path: '/extract_nouns',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  },
  timeout: 5000,
};

const req = http.request(options, (res) => {
  let body = '';
  res.on('data', (chunk) => (body += chunk));
  res.on('end', () => {
    console.log('STATUS:', res.statusCode);
    console.log('BODY:', body);
  });
});

req.on('error', (err) => {
  console.error('REQUEST ERROR:', err.message);
});

req.on('timeout', () => {
  console.error('REQUEST TIMEOUT');
  req.destroy();
});

req.write(data);
req.end();
