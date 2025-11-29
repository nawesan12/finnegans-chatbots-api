# Complete Webhook Backend Integration Guide

**This is THE ONLY file you need. Everything for webhook backend implementation is here.**

---

## 🎯 What You Need To Build

A Node.js/Express server that:
1. Receives WhatsApp messages from Meta webhook
2. Executes flows using our flow-executor
3. Sends WebSocket events for real-time frontend updates
4. Saves all messages to shared PostgreSQL database

---

## 📦 Required Dependencies

```bash
npm install express socket.io @prisma/client
npm install -D prisma typescript @types/node @types/express
```

---

## 🗄️ Database (SHARED with Frontend)

**Same database, same Prisma schema**. Copy these from frontend:

### 1. Copy Prisma Files
```bash
# Copy from frontend project
cp ../finnegans-chatbots/prisma/schema.prisma ./prisma/
cp -r ../finnegans-chatbots/prisma/migrations ./prisma/
```

### 2. Environment Variables
```env
# Database (shared with frontend)
DATABASE_URL="postgresql://user:password@localhost:5432/finnegans_chatbots"

# Server Configuration
FRONTEND_URL="http://localhost:3000"
WEBSOCKET_PORT=3001
PORT=3000

# Webhook Security (Meta verification)
META_VERIFY_TOKEN="your-webhook-verify-token"
META_APP_SECRET="your-app-secret-from-meta-dashboard"
```

**IMPORTANT**: WhatsApp API credentials (Access Token, Phone Number ID, Business Account ID) are stored **in the database per user**, NOT in environment variables. Each user has their own credentials in the `User` table.

### 3. Generate Prisma Client
```bash
npx prisma generate
```

---

## 🚀 Complete Server Implementation

### File Structure
```
webhook-backend/
├── src/
│   ├── server.ts           # Main server
│   ├── webhook.ts          # Webhook handler
│   ├── flow-executor.ts    # COPY from frontend
│   ├── flow-schema.ts      # COPY from frontend
│   ├── meta.ts             # COPY from frontend
│   └── socket.ts           # WebSocket server
├── prisma/
│   ├── schema.prisma       # COPY from frontend
│   └── migrations/         # COPY from frontend
├── package.json
├── tsconfig.json
└── .env
```

---

## 📋 Step-by-Step Implementation

### STEP 1: Copy Files from Frontend

Copy these EXACT files from the frontend project:

```bash
# From frontend /src/lib/ to webhook-backend /src/
cp ../finnegans-chatbots/src/lib/flow-executor.ts ./src/
cp ../finnegans-chatbots/src/lib/flow-schema.ts ./src/
cp ../finnegans-chatbots/src/lib/meta.ts ./src/
cp ../finnegans-chatbots/src/lib/prisma.ts ./src/
cp ../finnegans-chatbots/src/lib/safe-clone.ts ./src/
```

**IMPORTANT**: These files must be EXACT copies. They contain the flow execution logic.

---

### STEP 2: Create WebSocket Server

**`src/socket.ts`**:
```typescript
import { Server } from "socket.io";
import http from "http";

let io: Server | null = null;

export function initializeSocketServer(httpServer: http.Server) {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.FRONTEND_URL || "http://localhost:3000",
      credentials: true,
    },
  });

  io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);

    socket.on("join:conversation", (contactId: string) => {
      socket.join(`conversation:${contactId}`);
      console.log(`Socket ${socket.id} joined conversation:${contactId}`);
    });

    socket.on("leave:conversation", (contactId: string) => {
      socket.leave(`conversation:${contactId}`);
      console.log(`Socket ${socket.id} left conversation:${contactId}`);
    });

    socket.on("disconnect", () => {
      console.log("Client disconnected:", socket.id);
    });
  });

  return io;
}

export function getSocketServer() {
  if (!io) {
    throw new Error("Socket server not initialized");
  }
  return io;
}

// Helper functions to emit events
export function emitMessageNew(contactId: string, message: any) {
  if (io) {
    io.to(`conversation:${contactId}`).emit("message:new", {
      message,
      contactId,
    });
  }
}

export function emitTypingStart(contactId: string) {
  if (io) {
    io.to(`conversation:${contactId}`).emit("typing:start", { contactId });
  }
}

export function emitTypingStop(contactId: string) {
  if (io) {
    io.to(`conversation:${contactId}`).emit("typing:stop", { contactId });
  }
}

export function emitMessageStatus(contactId: string, messageId: string, waMessageId: string, status: string) {
  if (io) {
    io.to(`conversation:${contactId}`).emit("message:status", {
      messageId,
      waMessageId,
      status,
      contactId,
    });
  }
}
```

---

### STEP 3: Create Webhook Handler

**🔑 How WhatsApp Credentials Work**

Unlike traditional single-tenant systems, this is a **multi-tenant system** where:
- Each user has their own WhatsApp Business Account
- Credentials are stored **in the database** (NOT environment variables)
- The webhook resolves which user owns the incoming message by matching `phoneNumberId`

**Credential Flow:**
1. **Incoming Webhook**: Meta sends `phone_number_id` in the webhook
2. **User Resolution**: Query database to find user with that `metaPhoneNumberId`
3. **Message Sending**: When sending, `sendMessage()` fetches `metaAccessToken` and `metaPhoneNumberId` from that user's DB record

**Database Fields (User table):**
- `metaAccessToken` - Access token for WhatsApp Cloud API
- `metaPhoneNumberId` - Phone Number ID (identifies which WhatsApp number)
- `metaBusinessAccountId` - Business Account ID
- `metaPhonePin` - PIN for phone number registration
- `metaAppSecret` - App secret for webhook signature verification
- `metaVerifyToken` - Token for webhook verification

**`src/webhook.ts`**:
```typescript
import { Request, Response } from "express";
import crypto from "crypto";
import prisma from "./prisma";
import { executeFlow } from "./flow-executor";
import { sendMessage } from "./meta";
import { emitMessageNew, emitTypingStart, emitTypingStop, emitMessageStatus } from "./socket";

// Trigger matching logic
function matchesTrigger(messageText: string | null, triggerKeyword: string): boolean {
  if (!messageText || !triggerKeyword) return false;

  const stripDiacritics = (text: string) =>
    text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  const normalize = (text: string) => {
    try {
      return stripDiacritics(text.trim()).toLowerCase();
    } catch {
      return text.trim().toLowerCase();
    }
  };

  const normalizedMessage = normalize(messageText);
  const normalizedKeyword = normalize(triggerKeyword);

  if (normalizedKeyword === "default") {
    return true;
  }

  if (normalizedMessage === normalizedKeyword ||
      normalizedMessage.includes(normalizedKeyword)) {
    return true;
  }

  const words = normalizedMessage.split(/\s+/);
  return words.includes(normalizedKeyword);
}

// Webhook verification (GET)
export async function handleWebhookVerification(req: Request, res: Response) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) {
    console.log("Webhook verified");
    return res.status(200).send(challenge);
  }

  return res.status(403).send("Forbidden");
}

// Main webhook handler (POST)
export async function handleWebhook(req: Request, res: Response) {
  try {
    // Verify signature
    const signature = req.headers["x-hub-signature-256"] as string;
    if (!signature || !verifySignature(req.body, signature)) {
      console.error("Invalid webhook signature");
      return res.status(403).send("Forbidden");
    }

    const body = req.body;

    // Extract webhook data
    if (body.object !== "whatsapp_business_account") {
      return res.status(200).send("OK");
    }

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages") continue;

        const value = change.value;
        const phoneNumberId = value.metadata?.phone_number_id;

        // Handle message status updates
        if (value.statuses) {
          await handleStatusUpdates(value.statuses);
        }

        // Handle incoming messages
        if (value.messages) {
          await handleIncomingMessages(value.messages, phoneNumberId);
        }
      }
    }

    return res.status(200).send("OK");
  } catch (error) {
    console.error("Webhook error:", error);
    return res.status(500).send("Internal Server Error");
  }
}

function verifySignature(body: any, signature: string): boolean {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) return false;

  const hash = crypto
    .createHmac("sha256", appSecret)
    .update(JSON.stringify(body))
    .digest("hex");

  return signature === `sha256=${hash}`;
}

async function handleStatusUpdates(statuses: any[]) {
  for (const status of statuses) {
    const { id, status: whatsappStatus } = status;

    const statusMap: Record<string, string> = {
      sent: "Sent",
      delivered: "Delivered",
      read: "Read",
      failed: "Failed",
    };

    const mappedStatus = statusMap[whatsappStatus] || "Pending";

    // Update message in database
    const message = await prisma.message.updateMany({
      where: { waMessageId: id },
      data: {
        status: mappedStatus,
        statusUpdatedAt: new Date(),
      },
    });

    // Get message to emit status update
    const updatedMessage = await prisma.message.findFirst({
      where: { waMessageId: id },
      select: { id: true, contactId: true },
    });

    if (updatedMessage) {
      emitMessageStatus(
        updatedMessage.contactId,
        updatedMessage.id,
        id,
        mappedStatus
      );
    }
  }
}

async function handleIncomingMessages(messages: any[], phoneNumberId: string) {
  for (const message of messages) {
    try {
      const { from, id: waMessageId, text, type, interactive } = message;

      // Find user by phone number ID
      const user = await prisma.user.findFirst({
        where: { metaPhoneNumberId: phoneNumberId },
      });

      if (!user) {
        console.error(`No user found for phone number ID: ${phoneNumberId}`);
        continue;
      }

      // Find or create contact
      let contact = await prisma.contact.findFirst({
        where: { userId: user.id, phone: from },
      });

      if (!contact) {
        contact = await prisma.contact.create({
          data: {
            phone: from,
            userId: user.id,
          },
        });
      }

      // Extract message text
      const messageText = text?.body || interactive?.button_reply?.title || interactive?.list_reply?.title || null;

      // Save incoming message to database
      const savedMessage = await prisma.message.create({
        data: {
          waMessageId,
          direction: "inbound",
          type: type || "text",
          content: messageText,
          payload: message as any,
          status: "Delivered",
          contactId: contact.id,
          userId: user.id,
        },
      });

      // Emit WebSocket event for new message
      emitMessageNew(contact.id, savedMessage);

      // Find active flows
      const activeFlows = await prisma.flow.findMany({
        where: {
          userId: user.id,
          status: "Active",
        },
      });

      // Check for existing session or matching trigger
      let flowExecuted = false;
      for (const flow of activeFlows) {
        let session = await prisma.session.findUnique({
          where: {
            contactId_flowId: {
              contactId: contact.id,
              flowId: flow.id,
            },
          },
          include: {
            flow: {
              select: {
                definition: true,
                userId: true,
                name: true,
              },
            },
            contact: {
              select: { phone: true },
            },
          },
        });

        const shouldExecute =
          session?.status === "Paused" ||
          session?.status === "Active" ||
          matchesTrigger(messageText, flow.trigger);

        if (shouldExecute) {
          if (!session) {
            session = await prisma.session.create({
              data: {
                contactId: contact.id,
                flowId: flow.id,
                status: "Active",
                context: {},
              },
              include: {
                flow: {
                  select: {
                    definition: true,
                    userId: true,
                    name: true,
                  },
                },
                contact: {
                  select: { phone: true },
                },
              },
            });
          }

          // Update message with session ID
          await prisma.message.update({
            where: { id: savedMessage.id },
            data: { sessionId: session.id },
          });

          // Emit typing indicator
          emitTypingStart(contact.id);

          try {
            // Execute flow
            await executeFlow(
              session,
              messageText,
              sendMessage,
              {
                type: type || "text",
                rawText: messageText,
                interactive: interactive ? {
                  type: interactive.type,
                  id: interactive.button_reply?.id || interactive.list_reply?.id || null,
                  title: interactive.button_reply?.title || interactive.list_reply?.title || null,
                } : null,
              }
            );

            console.log(`Flow executed successfully for contact ${contact.phone}`);
          } catch (error) {
            console.error(`Flow execution failed:`, error);

            await prisma.session.update({
              where: { id: session.id },
              data: { status: "Errored" },
            });
          } finally {
            // Stop typing indicator
            emitTypingStop(contact.id);
          }

          flowExecuted = true;
          break; // Only execute first matching flow
        }
      }

      if (!flowExecuted) {
        console.log(`No matching flow for message from ${contact.phone}`);
      }
    } catch (error) {
      console.error("Error processing message:", error);
    }
  }
}
```

---

### STEP 4: Create Main Server

**`src/server.ts`**:
```typescript
import express from "express";
import http from "http";
import { initializeSocketServer } from "./socket";
import { handleWebhook, handleWebhookVerification } from "./webhook";

const app = express();
const httpServer = http.createServer(app);

// Initialize WebSocket server
initializeSocketServer(httpServer);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Webhook routes
app.get("/webhook", handleWebhookVerification);
app.post("/webhook", handleWebhook);

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
const WS_PORT = process.env.WEBSOCKET_PORT || 3001;

// Start HTTP server for webhook
app.listen(PORT, () => {
  console.log(`Webhook server running on port ${PORT}`);
});

// Start WebSocket server
httpServer.listen(WS_PORT, () => {
  console.log(`WebSocket server running on port ${WS_PORT}`);
});
```

---

## 🔐 Environment Setup

**`.env`**:
```env
# Database (SHARED with frontend)
DATABASE_URL="postgresql://user:password@localhost:5432/finnegans_chatbots"

# Meta Webhook
META_VERIFY_TOKEN="your-webhook-verify-token"
META_APP_SECRET="your-meta-app-secret"

# Frontend URL for CORS
FRONTEND_URL="http://localhost:3000"

# Ports
PORT=3000
WEBSOCKET_PORT=3001

# Node Environment
NODE_ENV="development"
```

---

## 🧪 Testing

### 1. Test Webhook Verification
```bash
curl "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=your-webhook-verify-token&hub.challenge=test"
```

Expected: Returns "test"

### 2. Test WebSocket Connection

In browser console (frontend):
```javascript
const socket = io("ws://localhost:3001");
socket.on("connect", () => console.log("Connected!"));
socket.emit("join:conversation", "contact_id_here");
socket.on("message:new", (data) => console.log("New message:", data));
```

### 3. Test End-to-End Flow

1. Send WhatsApp message to your number
2. Check webhook backend logs - should see "Flow executed successfully"
3. Check frontend - message should appear instantly
4. Bot response should appear in frontend

---

## 📊 Database Schema Reference

Key tables you'll interact with:

### User
```typescript
{
  id: string
  email: string

  // Meta WhatsApp API credentials (stored per user)
  metaAccessToken: string           // Access token to send messages
  metaPhoneNumberId: string         // WhatsApp Business Phone Number ID
  metaBusinessAccountId: string     // WhatsApp Business Account ID
  metaPhonePin: string              // Phone number registration PIN
  metaVerifyToken: string           // Webhook verification token
  metaAppSecret: string             // App secret for signature verification
}
```

**How Credentials Work:**
1. Each user configures their own WhatsApp credentials in Settings
2. Credentials are stored in the database (NOT env variables)
3. When sending a message, `sendMessage(userId, to, payload)` fetches credentials from DB:
   ```typescript
   const user = await prisma.user.findUnique({
     where: { id: userId },
     select: {
       metaAccessToken: true,
       metaPhoneNumberId: true,
       metaPhonePin: true,
     },
   });
   ```
4. The webhook identifies the user by matching `phoneNumberId` from Meta webhook to `metaPhoneNumberId` in database

### Contact
```typescript
{
  id: string
  phone: string               // WhatsApp number (from)
  userId: string
}
```

### Flow
```typescript
{
  id: string
  name: string
  trigger: string            // Keyword to match
  status: string             // "Active", "Draft", "Inactive"
  definition: Json           // Flow graph (ReactFlow format - see below)
  userId: string
}
```

#### Flow Definition Format (ReactFlow)

The `definition` field contains a ReactFlow graph with **nodes** and **edges**:

```typescript
{
  "nodes": [
    {
      "id": string,           // Unique node identifier
      "type": string,         // Node type: "trigger", "message", "options", etc.
      "data": {               // Node-specific data
        "name": string,       // Display name
        // ... type-specific fields
      },
      "position": { "x": number, "y": number }  // UI position (not used in execution)
    }
  ],
  "edges": [
    {
      "id": string,           // Unique edge identifier
      "source": string,       // Source node ID
      "target": string,       // Target node ID
      "sourceHandle": string | null,  // For branching (options: "opt-0", "opt-1", "no-match")
      "type": "smoothstep",
      "markerEnd": { "type": "arrowclosed" }
    }
  ]
}
```

#### Example: Options Node Flow

```json
{
  "nodes": [
    {
      "id": "n1",
      "type": "trigger",
      "data": {
        "name": "Start",
        "keyword": "Hola"
      },
      "position": { "x": 0, "y": 0 }
    },
    {
      "id": "n2",
      "type": "message",
      "data": {
        "name": "Welcome",
        "text": "Welcome! How can I help?",
        "useTemplate": false
      },
      "position": { "x": 0, "y": 168 }
    },
    {
      "id": "n3",
      "type": "options",
      "data": {
        "name": "Choose option",
        "text": "Please select an option:",
        "options": ["Option 1", "Option 2"]
      },
      "position": { "x": 0, "y": 336 }
    },
    {
      "id": "n4",
      "type": "message",
      "data": {
        "name": "Option 1 response",
        "text": "You chose option 1",
        "useTemplate": false
      },
      "position": { "x": -150, "y": 504 }
    },
    {
      "id": "n5",
      "type": "message",
      "data": {
        "name": "Option 2 response",
        "text": "You chose option 2",
        "useTemplate": false
      },
      "position": { "x": 150, "y": 504 }
    },
    {
      "id": "n6",
      "type": "end",
      "data": {
        "name": "End",
        "reason": "completed"
      },
      "position": { "x": 0, "y": 672 }
    }
  ],
  "edges": [
    { "id": "e1", "source": "n1", "target": "n2", "sourceHandle": null },
    { "id": "e2", "source": "n2", "target": "n3", "sourceHandle": null },
    { "id": "e3", "source": "n3", "target": "n4", "sourceHandle": "opt-0" },
    { "id": "e4", "source": "n3", "target": "n5", "sourceHandle": "opt-1" },
    { "id": "e5", "source": "n3", "target": "n5", "sourceHandle": "no-match" },
    { "id": "e6", "source": "n4", "target": "n6", "sourceHandle": null },
    { "id": "e7", "source": "n5", "target": "n6", "sourceHandle": null }
  ]
}
```

**Important:**
- **Options nodes MUST have a `text` field** - this is the message shown before the options
- **Edge routing**: Options use `sourceHandle` to route:
  - `"opt-0"` = First option selected
  - `"opt-1"` = Second option selected
  - `"opt-N"` = Nth option selected
  - `"no-match"` = User response didn't match any option
- **Condition nodes** use `sourceHandle: "true"` or `"false"`
- **All other nodes** use `sourceHandle: null`

### Session
```typescript
{
  id: string
  status: string             // "Active", "Paused", "Completed", "Errored"
  currentNodeId: string
  context: Json
  contactId: string
  flowId: string
}
```

### Message
```typescript
{
  id: string
  waMessageId: string        // WhatsApp message ID
  direction: string          // "inbound" or "outbound"
  type: string               // "text", "media", "interactive", etc
  content: string
  status: string             // "Sent", "Delivered", "Read", "Failed"
  contactId: string
  userId: string
  sessionId: string
}
```

---

## 🎨 WebSocket Events to Emit

### When Incoming Message Arrives
```typescript
emitMessageNew(contactId, savedMessage);
```

### Before Flow Execution
```typescript
emitTypingStart(contactId);
```

### After Flow Execution
```typescript
emitTypingStop(contactId);
```

### When Message Status Updates
```typescript
emitMessageStatus(contactId, messageId, waMessageId, status);
```

---

## ✅ Production Checklist

- [ ] Copy all required files from frontend
- [ ] Database connection working
- [ ] Prisma client generated
- [ ] Environment variables set
- [ ] Webhook signature verification enabled
- [ ] WebSocket CORS configured for production domain
- [ ] SSL certificates (wss:// not ws://)
- [ ] Error logging configured
- [ ] Health check endpoint working
- [ ] Test with real WhatsApp message
- [ ] Frontend shows real-time updates
- [ ] Messages saved to database
- [ ] Flow execution working

---

## 🐛 Troubleshooting

### Flow Not Executing
- Check flow status is "Active"
- Verify trigger keyword matches
- Check flow definition JSON is valid (must have `nodes` and `edges` arrays)
- **Options nodes must have `text` field** - without it, options won't display properly
- Verify edge `sourceHandle` values match expected format (`opt-0`, `opt-1`, `no-match` for options)
- Review executeFlow logs

### WebSocket Not Connecting
- Check CORS configuration
- Verify frontend URL in .env
- Check firewall allows WS_PORT
- Use wss:// in production

### Messages Not Saving
- Verify database connection
- Check Prisma schema matches
- Review message creation logs
- Verify contactId exists

### Signature Verification Failing
- Check META_APP_SECRET matches Meta dashboard
- Verify request body parsing
- Review webhook signature calculation

---

## 📚 Key Files to Copy from Frontend

**MUST COPY (EXACT copies)**:
1. `src/lib/flow-executor.ts` - Flow execution engine
2. `src/lib/flow-schema.ts` - Flow validation schemas
3. `src/lib/meta.ts` - WhatsApp message sending
4. `src/lib/prisma.ts` - Database client
5. `src/lib/safe-clone.ts` - Utility for flow execution
6. `prisma/schema.prisma` - Database schema
7. `prisma/migrations/` - All migration files

**Files You Create**:
1. `src/server.ts` - Main server (code above)
2. `src/webhook.ts` - Webhook handler (code above)
3. `src/socket.ts` - WebSocket server (code above)
4. `.env` - Environment variables

---

## 🚀 Quick Start Commands

```bash
# 1. Install dependencies
npm install express socket.io @prisma/client
npm install -D prisma typescript @types/node @types/express ts-node

# 2. Copy files from frontend
./copy-from-frontend.sh

# 3. Setup database
npx prisma generate
npx prisma migrate deploy

# 4. Start server
npm run dev
```

---

## 💡 Important Notes

1. **Database is SHARED** - Same PostgreSQL database as frontend
2. **Credentials are in DATABASE, not ENV** - Each user stores their Meta credentials (Access Token, Phone Number ID) in their User record. The webhook resolves users by `metaPhoneNumberId`, and `sendMessage()` fetches credentials from the database
3. **Flow files are EXACT copies** - Don't modify flow-executor.ts
4. **WebSocket runs on different port** - 3001 for WS, 3000 for webhook
5. **Signature verification is REQUIRED** - Don't skip in production
6. **One flow per message** - First matching flow executes, then breaks
7. **Multi-tenant architecture** - Each user has their own WhatsApp Business Account

---

**That's it! Everything you need is in this ONE file.**

Questions? Check:
- Frontend `src/lib/flow-executor.ts` for flow logic
- This file for webhook implementation
- Prisma schema for database structure

---

**Version**: 1.0.0
**Last Updated**: January 2025
**Status**: Complete ✅
