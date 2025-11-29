# Webhook Backend - Production Ready Setup

## Overview

This is a complete, production-ready WhatsApp webhook backend that integrates with Meta's WhatsApp Cloud API. The system supports:

- Real-time WebSocket communication with the frontend
- Multi-tenant architecture (each user has their own WhatsApp credentials)
- Secure webhook signature verification
- Automatic flow execution based on incoming messages
- Message status tracking and updates
- Typing indicators for better UX

## Architecture

### Servers
The application runs **TWO separate servers**:

1. **HTTP Server (Port 3000)**: Handles webhook requests and REST API
2. **WebSocket Server (Port 3001)**: Handles real-time communication with frontend

### Key Components

- `index.ts` - Main server with webhook endpoints
- `lib/socket.ts` - WebSocket server for real-time events
- `lib/meta.ts` - WhatsApp message processing and webhook handling
- `lib/flow-executor.ts` - Flow execution engine
- `lib/prisma.ts` - Database client

## Features Implemented

### ✅ Webhook Verification (GET /meta/webhook)
- Verifies Meta webhook subscription requests
- Uses `META_VERIFY_TOKEN` for authentication
- Returns the challenge parameter for successful verification

### ✅ Webhook Handler (POST /meta/webhook)
- **Signature Verification**: Validates `x-hub-signature-256` header using `META_APP_SECRET`
- **Message Processing**: Handles incoming WhatsApp messages
- **Status Updates**: Processes message delivery status updates
- **Multi-tenant Support**: Resolves user by `metaPhoneNumberId`

### ✅ WebSocket Real-Time Events
Four types of events are emitted to the frontend:

1. **`message:new`**: When a new message (inbound or outbound) is created
2. **`typing:start`**: Before flow execution begins
3. **`typing:stop`**: After flow execution completes
4. **`message:status`**: When message status changes (Sent → Delivered → Read)

### ✅ Flow Execution
- Automatically finds and executes matching flows
- Supports trigger-based and session-based routing
- Handles all node types: message, options, conditions, API calls, delays, etc.
- Pauses on options nodes and resumes on user response

### ✅ Message Saving
- Saves all inbound and outbound messages to database
- Links messages to sessions and contacts
- Stores full payload for debugging

### ✅ Security
- HMAC SHA-256 signature verification for webhooks
- Environment-based configuration
- CORS protection for WebSocket connections

## Environment Variables

Required variables (see `.env.example`):

```env
# Database
DATABASE_URL="postgresql://..."
DIRECT_URL="postgresql://..."

# Webhook Security (for verification only)
META_VERIFY_TOKEN="your-verify-token"
META_APP_SECRET="your-app-secret"

# Server Configuration
PORT=3000
WEBSOCKET_PORT=3001
FRONTEND_URL="http://localhost:3000"

# Environment
NODE_ENV="development"
```

**IMPORTANT**: User-specific credentials (Access Token, Phone Number ID, Business Account ID) are stored in the **database per user**, NOT in environment variables.

## How It Works

### 1. Incoming Message Flow

```
Meta sends webhook → Signature verification → Find user by phoneNumberId →
Create/find contact → Save incoming message → Emit message:new →
Find matching flow → Execute flow → Send responses → Emit typing indicators
```

### 2. User Resolution

The system is **multi-tenant**. When Meta sends a webhook:

1. Extract `phone_number_id` from metadata
2. Query database: `User.findFirst({ where: { metaPhoneNumberId } })`
3. Use that user's credentials for sending messages

### 3. Message Sending

When `sendMessage()` is called:

1. Fetch user's `metaAccessToken` and `metaPhoneNumberId` from database
2. Make request to Meta Graph API
3. Save outbound message to database
4. Emit `message:new` event

### 4. WebSocket Integration

Frontend connects to `ws://localhost:3001`:

```javascript
const socket = io("ws://localhost:3001");

// Join a conversation
socket.emit("join:conversation", contactId);

// Listen for events
socket.on("message:new", ({ message, contactId }) => {
  // Update UI with new message
});

socket.on("typing:start", ({ contactId }) => {
  // Show typing indicator
});

socket.on("typing:stop", ({ contactId }) => {
  // Hide typing indicator
});

socket.on("message:status", ({ messageId, status, contactId }) => {
  // Update message status in UI
});
```

## Testing

### Test Webhook Verification

```bash
curl "http://localhost:3000/meta/webhook?hub.mode=subscribe&hub.verify_token=YOUR_TOKEN&hub.challenge=test"
```

Expected: Returns `"test"`

### Test Health Endpoint

```bash
curl http://localhost:3000/health
```

Expected: `{"status":"ok"}`

### Test WebSocket Connection

```javascript
const socket = io("ws://localhost:3001");
socket.on("connect", () => console.log("Connected!"));
socket.emit("join:conversation", "contact_id_here");
```

## Production Deployment

### Prerequisites

1. Set all environment variables
2. Configure Meta App with webhook URL: `https://your-domain.com/meta/webhook`
3. Use wss:// for WebSocket in production
4. Set `NODE_ENV=production`

### Checklist

- [x] Webhook signature verification enabled
- [x] WebSocket CORS configured for production domain
- [x] SSL certificates for wss://
- [x] Database migrations applied
- [x] Environment variables set
- [x] Health check endpoint working
- [x] Error logging configured
- [x] Multi-tenant user resolution working
- [x] Real-time events emitting correctly

## Database Schema

### Key Tables

**User**: Stores per-user Meta credentials
- `metaAccessToken` - Access token for sending messages
- `metaPhoneNumberId` - Phone Number ID (identifies WhatsApp number)
- `metaBusinessAccountId` - Business Account ID
- `metaAppSecret` - App secret (optional per-user override)
- `metaVerifyToken` - Verify token (optional per-user override)

**Contact**: WhatsApp contacts per user
- `phone` - Contact's WhatsApp number
- `userId` - Foreign key to User

**Message**: All messages (inbound and outbound)
- `waMessageId` - WhatsApp message ID
- `direction` - "in" or "out"
- `type` - "text", "interactive", "media", etc.
- `content` - Message text content
- `status` - "Sent", "Delivered", "Read", "Failed"
- `contactId` - Foreign key to Contact
- `sessionId` - Foreign key to Session (if part of flow)

**Session**: Flow execution sessions
- `status` - "Active", "Paused", "Completed", "Errored"
- `currentNodeId` - Current node in flow
- `context` - Flow variables and state
- `contactId` - Foreign key to Contact
- `flowId` - Foreign key to Flow

**Flow**: Chatbot flows
- `trigger` - Keyword to start flow
- `status` - "Active", "Draft", "Inactive"
- `definition` - Flow graph (nodes and edges)
- `channel` - "whatsapp" (default)
- `userId` - Foreign key to User

## API Endpoints

### GET /health
Health check endpoint
```bash
curl http://localhost:3000/health
```

### GET /meta/webhook
Webhook verification (Meta calls this)
```bash
curl "http://localhost:3000/meta/webhook?hub.mode=subscribe&hub.verify_token=TOKEN&hub.challenge=CHALLENGE"
```

### POST /meta/webhook
Webhook handler (Meta sends messages here)
- Requires `x-hub-signature-256` header
- Validates signature against `META_APP_SECRET`
- Processes incoming messages and status updates

### POST /flows/:flowId/trigger
Manually trigger a flow
```bash
curl -X POST http://localhost:3000/flows/FLOW_ID/trigger \
  -H "Content-Type: application/json" \
  -d '{"from": "1234567890", "message": "Hello"}'
```

## Troubleshooting

### Webhook Not Receiving Messages

1. Check Meta webhook configuration in Developer Dashboard
2. Verify `META_VERIFY_TOKEN` matches Meta settings
3. Check `META_APP_SECRET` is correct
4. Look for signature verification errors in logs
5. Ensure webhook URL is publicly accessible (use ngrok for local testing)

### WebSocket Not Connecting

1. Verify `WEBSOCKET_PORT` is correct
2. Check `FRONTEND_URL` for CORS
3. Use wss:// in production, ws:// in development
4. Check firewall allows WebSocket port

### Flow Not Executing

1. Verify flow status is "Active"
2. Check flow trigger matches user message
3. Verify user has `metaAccessToken` and `metaPhoneNumberId` in database
4. Review flow execution logs
5. Check session status in database

### Messages Not Saving

1. Verify database connection
2. Check Prisma schema matches database
3. Review message creation errors in logs

## Security Notes

- Always use HTTPS in production
- Webhook signature verification is **REQUIRED** in production
- Never commit `.env` file to git
- Rotate `META_APP_SECRET` regularly
- Use environment variables for all secrets
- Enable rate limiting for webhook endpoint in production

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Setup environment variables
cp .env.example .env
# Edit .env with your values

# 3. Generate Prisma client
npx prisma generate

# 4. Run migrations
npx prisma migrate deploy

# 5. Start development server
npm run dev

# 6. In another terminal, test the webhook
curl "http://localhost:3000/meta/webhook?hub.mode=subscribe&hub.verify_token=YOUR_TOKEN&hub.challenge=test"
```

## Support

- Check logs for detailed error messages
- All webhook events are logged to console
- Use `NODE_ENV=development` for verbose Prisma query logging
- Review database for session and message state

---

**Version**: 1.0.0
**Status**: Production Ready ✅
**Last Updated**: November 2025
