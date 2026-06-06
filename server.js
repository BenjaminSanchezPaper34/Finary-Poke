const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { 
  CallToolRequestSchema, 
  ListToolsRequestSchema 
} = require('@modelcontextprotocol/sdk/types.js');

/**
 * MCP SSE Server optimized for persistent environments (Railway)
 * Integrated with Finary API (Unofficial) via Clerk Auth
 */

// --- Finary API Constants ---
const API_ROOT = 'https://api.finary.com';
const CLERK_ROOT = 'https://clerk.finary.com';

/**
 * Finary Client to manage Clerk session and authenticated requests
 */
class FinaryClient {
  constructor(sessionId, cookies) {
    this.sessionId = sessionId;
    this.cookies = cookies;
    this.jwt = null;
  }

  async refreshToken() {
    console.log('Attempting to refresh Finary JWT via Clerk...');
    if (!this.sessionId || !this.cookies) {
      throw new Error('FINARY_CLERK_SESSION_ID or FINARY_CLERK_COOKIES environment variables are missing.');
    }

    try {
      const response = await axios.post(
        `${CLERK_ROOT}/v1/client/sessions/${this.sessionId}/tokens`,
        {},
        {
          headers: {
            'Cookie': this.cookies,
            'Origin': 'https://app.finary.com',
            'Referer': 'https://app.finary.com',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36'
          }
        }
      );
      this.jwt = response.data.jwt;
      console.log('Finary JWT refreshed successfully');
    } catch (error) {
      console.error('Failed to refresh Finary token:', error.response?.data || error.message);
      throw new Error(`Auth refresh failed: ${error.message}`);
    }
  }

  async get(path, params = {}) {
    if (!this.jwt) await this.refreshToken();
    
    try {
      const response = await axios.get(`${API_ROOT}${path}`, {
        params,
        headers: { 
          'Authorization': `Bearer ${this.jwt}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36'
        }
      });
      return response.data;
    } catch (error) {
      // Retry once on 401
      if (error.response?.status === 401) {
        console.warn('401 Unauthorized, retrying after token refresh...');
        await this.refreshToken();
        const retryResponse = await axios.get(`${API_ROOT}${path}`, {
          params,
          headers: { 'Authorization': `Bearer ${this.jwt}` }
        });
        return retryResponse.data;
      }
      throw error;
    }
  }
}

// Global client instance
const finaryClient = new FinaryClient(
  process.env.FINARY_CLERK_SESSION_ID,
  process.env.FINARY_CLERK_COOKIES
);

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
        name: 'get_finary_portfolio',
        description: 'Fetch the general portfolio summary (net worth, total gains, etc.)',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_finary_investments',
        description: 'Fetch detailed investment holdings (stocks, funds, etc.)',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_finary_cryptos',
        description: 'Fetch detailed crypto holdings',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  
  try {
    let data;
    switch (name) {
      case 'get_finary_portfolio':
        data = await finaryClient.get('/users/me/portfolio');
        break;
      case 'get_finary_investments':
        data = await finaryClient.get('/users/me/portfolio/investments');
        break;
      case 'get_finary_cryptos':
        data = await finaryClient.get('/users/me/portfolio/cryptos');
        break;
      default:
        throw new Error('Tool not found');
    }
    
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  } catch (error) {
    console.error(`Error executing tool ${name}:`, error.message);
    return {
      isError: true,
      content: [{ type: 'text', text: `Failed to fetch data from Finary: ${error.message}` }],
    };
  }
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
  
  res.on('close', async () => {
    console.log(`Closing session: ${transport.sessionId}`);
    transports.delete(transport.sessionId);
    try {
      await transport.close();
    } catch (e) {
      console.error('Error closing transport:', e);
    }
  });

  try {
    await server.connect(transport);
  } catch (error) {
    console.error('SSE Connection Error:', error);
    transports.delete(transport.sessionId);
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
      message: 'The session may have expired.' 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
