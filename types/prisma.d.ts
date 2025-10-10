declare module "@prisma/client" {
  export interface User {
    id: string;
    email: string;
    password: string;
    name?: string | null;
    createdAt: Date | string;
    updatedAt: Date | string;
    metaAccessToken?: string | null;
    metaAppSecret?: string | null;
    metaPhoneNumberId?: string | null;
    metaVerifyToken?: string | null;
    metaBusinessAccountId?: string | null;
  }

  export interface Contact {
    id: string;
    phone: string;
    name?: string | null;
    createdAt: Date | string;
    updatedAt: Date | string;
    userId: string;
    notes?: string | null;
  }

  export interface Flow {
    id: string;
    name: string;
    trigger: string;
    status: string;
    definition: unknown;
    channel: string;
    createdAt: Date | string;
    updatedAt: Date | string;
    userId: string;
    metaFlowId?: string | null;
    metaFlowMetadata?: unknown;
    metaFlowRevisionId?: string | null;
    metaFlowStatus?: string | null;
    metaFlowToken?: string | null;
    metaFlowVersion?: string | null;
  }

  export interface Session {
    id: string;
    status: string;
    currentNodeId?: string | null;
    context?: unknown;
    createdAt: Date | string;
    updatedAt: Date | string;
    contactId: string;
    flowId: string;
  }

  export interface Broadcast {
    id: string;
    title?: string | null;
    body: string;
    filterTag?: string | null;
    status: string;
    totalRecipients: number;
    successCount: number;
    failureCount: number;
    createdAt?: Date;
    updatedAt?: Date;
    userId: string;
    flowId?: string | null;
  }

  export interface BroadcastRecipient {
    id: string;
    status: string;
    error?: string | null;
    sentAt?: Date | null;
    createdAt?: Date;
    broadcastId: string;
    contactId: string;
    conversationId?: string | null;
    messageId?: string | null;
    statusUpdatedAt?: Date | null;
  }

  export interface Log {
    id: string;
    status: string;
    context?: unknown;
    createdAt?: Date;
    updatedAt?: Date;
    contactId: string;
    flowId: string;
  }

  export namespace Prisma {
    export type JsonValue = unknown;
    export type JsonObject = Record<string, unknown>;
    export type InputJsonValue = unknown;
    export type SessionUpdateInput = Record<string, unknown>;
    export type BroadcastUpdateInput = Record<string, unknown>;
    export type BroadcastRecipientUpdateInput = Record<string, unknown>;
    export const JsonNull: null;
  }

  export const Prisma: {
    JsonNull: null;
  };

  export class PrismaClient {
    constructor(options?: Record<string, unknown>);
    [key: string]: any;
    $transaction<T>(fn: (client: PrismaClient) => Promise<T>): Promise<T>;
    $disconnect(): Promise<void>;
  }

  export { PrismaClient };
}
