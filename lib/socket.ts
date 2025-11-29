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
export function emitMessageNew(contactId: string, message: unknown) {
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

export function emitMessageStatus(
  contactId: string,
  messageId: string,
  waMessageId: string,
  status: string,
) {
  if (io) {
    io.to(`conversation:${contactId}`).emit("message:status", {
      messageId,
      waMessageId,
      status,
      contactId,
    });
  }
}
