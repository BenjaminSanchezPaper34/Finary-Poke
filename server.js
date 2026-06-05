const express = require('express');
const cors = require('cors');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { 
  CallToolRequestSchema, 
  ListToolsRequestSchema 
} = require('@modelcontextprotocol/sdk/types.js');

const app = express();
app.use(cors());

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

// SSE Transport setup
let transport;

app.get('/sse', async (req, res) => {
  console.log('New SSE connection');
  transport = new SSEServerTransport('/messages', res);
  await server.connect(transport);
});

// The /messages endpoint needs express.json() middleware to parse the body
// before calling handlePostMessage.
app.post('/messages', express.json(), async (req, res) => {
  console.log('Received message:', req.body);
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).send('No active SSE connection');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MCP Server running on http://localhost:${PORT}`);
  console.log(`SSE endpoint: http://localhost:${PORT}/sse`);
  console.log(`Message endpoint: http://localhost:${PORT}/messages`);
});
