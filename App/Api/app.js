const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
require('dotenv').config();

const app = express();

app.use(helmet());
app.use(cors());
app.use(compression());
app.use(morgan('combined'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    uptime: process.uptime()
  });
});

// API routes placeholder
app.get('/api/v2/status', (req, res) => {
  res.json({ 
    status: 'operational',
    services: {
      api: 'running',
      database: 'connected',
      realtime: 'running'
    }
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.originalUrl });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
