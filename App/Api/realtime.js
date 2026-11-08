const http = require('http');
const { Server } = require('socket.io');

const server = http.createServer();
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
  
  socket.on('heartbeat', () => {
    socket.emit('heartbeat', { timestamp: Date.now() });
  });
});

const port = process.env.PORT || 3001;
server.listen(port, () => {
  console.log('Realtime server running on port ' + port);
});
