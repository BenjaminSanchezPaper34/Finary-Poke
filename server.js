const express = require('express');
const cors = require('cors');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { 
  CallToolRequestSchema, 
  ListToolsRequestSchema 
} = require('@modelcontextprotocol/sdk/types.js');

/**
 * Serverless-optimized MCP SSE Server for Vercel
 * 
 * FIXES:
 * 1. Global Error Monitoring: Captures crashes that otherwise show as generic 500s.
 * 2. Header Reliability: Improved header handling and flushing for Vercel/NGINX.
 * 3. Proactive Cleanup: Explicit session deletion on connection closure.
 * 
 * NOTE: In-memory Maps like 'transports' are instance-specific. 
 * If a POST /messages request hits a different Vercel instance than the 
 * original GET /sse, it will return a 404. For high-scale production, 
 * use Redis (Upstash) to share session state.
 */

// --- Global Error Monitoring ---
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception thrown:', err);
});

const app = express();
app.use(cors());

// MCP Server Setup
const server = new Server(
  { name: 'finary-poke-server', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'get_finary_data',
        description: 'Fetch data from Finary account',
        inputSchema: {
          type: 'object',
          properties: {
            account_id: { type: 'string' },
          },
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'get_finary_data') {
    return {
      content: [{ type: 'text', text: `Fetching Finary data for: ${request.params.arguments.account_id}` }],
    };
  }
  throw new Error('Tool not found');
});

const transports = new Map();

/**
 * SSE endpoint
 */
app.get('/sse', async (req, res) => {
  console.log('New SSE connection');
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); 
  
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  const transport = new SSEServerTransport('/messages', res);
  transports.set(transport.sessionId, transport);
  
  res.on('close', () => {
    console.log(`Closing session: ${transport.sessionId}`);
    transports.delete(transport.sessionId);
  });

  try {
    await server.connect(transport);
  } catch (error) {
    console.error('SSE Connection Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }
});

/**
 * Message endpoint
 */
app.post('/messages', express.json(), async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);
  
  if (transport) {
    try {
      await transport.handlePostMessage(req, res);
    } catch (error) {
      console.error(`Message Error (${sessionId}):`, error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to handle message' });
      }
    }
  } else {
    console.warn(`Session not found: ${sessionId}`);
    res.status(404).json({ 
      error: 'Session not found', 
      message: 'The session may have expired or routed to a different server instance.' 
    });
  }
});

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Local server: http://localhost:${PORT}`));
}

module.exports = app;
