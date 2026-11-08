const next = require('next');
const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev, dir: 'C:\\ByteBane Server\\App\\Affiliate' });
const handle = app.getRequestHandler();
app.prepare().then(() => {
  const server = require('http').createServer((req, res) => handle(req, res));
  server.listen(3002, () => console.log('Affiliate on 3002'));
});
