const express = require('express');
const cors = require('cors');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { 
  CallToolRequestSchema, 
  ListToolsRequestSchema 
} = require('@modelcontextprotocol/sdk/types.js');

/**
 * Robust MCP SSE Server Implementation for Vercel Serverless
 */

const app = express();

// Standard Express middleware
app.use(cors());

// Create MCP Server instance
const server = new Server(
  {
    name: 'finary-poke-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define tools
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
      content: [
        {
          type: 'text',
          text: `Fetching Finary data for account: ${request.params.arguments.account_id}`,
        },
      ],
    };
  }
  throw new Error('Tool not found');
});

// Map to store active SSE transports by session ID
// Note: In serverless environments, this in-memory map will only persist 
// for the duration of the execution context's life.
const transports = new Map();

/**
 * SSE endpoint: Establishes a long-running connection
 */
app.get('/sse', async (req, res) => {
  console.log('New SSE connection requested');
  
  try {
    // Set headers explicitly for SSE to ensure compatibility
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable buffering on NGINX/Vercel
    
    // Check if flushHeaders exists (it should in Express)
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    // Create transport with the relative path for messages
    const transport = new SSEServerTransport('/messages', res);
    
    // Store the transport instance for later message routing
    transports.set(transport.sessionId, transport);
    
    // Handle connection closure
    res.on('close', () => {
      console.log(`SSE connection closed for session: ${transport.sessionId}`);
      transports.delete(transport.sessionId);
    });

    res.on('error', (err) => {
      console.error(`SSE response stream error for session ${transport.sessionId}:`, err);
      transports.delete(transport.sessionId);
    });

    // Connect the transport to the MCP server
    await server.connect(transport);
    console.log(`MCP Transport connected for session: ${transport.sessionId}`);
  } catch (error) {
    console.error('Failed to connect MCP transport or initialize SSE:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
  }
});

/**
 * Message endpoint: Receives POST requests for a specific session
 */
app.post('/messages', express.json(), async (req, res) => {
  const sessionId = req.query.sessionId;
  console.log(`Received message for session: ${sessionId}`);
  
  const transport = transports.get(sessionId);
  
  if (transport) {
    try {
      await transport.handlePostMessage(req, res);
    } catch (error) {
      console.error(`Error handling message for session ${sessionId}:`, error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to handle message', message: error.message });
      }
    }
  } else {
    console.warn(`No active SSE session found for ID: ${sessionId}`);
    res.status(404).json({ error: 'Session not found', sessionId });
  }
});

// For local development
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`MCP Server running on http://localhost:${PORT}`);
  });
}

// Export the app for Vercel
module.exports = app;
