import { Prisma } from "@prisma/client";
import { z } from "zod";

import { sanitizeFlowDefinition, type FlowDefinition } from "./flow-schema";
import prisma from "./prisma";

export class FlowValidationError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "FlowValidationError";
    this.status = status;
  }
}

const flowStatusSchema = z.enum(["Draft", "Active", "Paused", "Archived"]);
const flowChannelSchema = z.enum(["whatsapp"]);

const metaFlowUpsertSchema = z
  .object({
    id: z.string().max(200).optional().nullable(),
    token: z.string().max(200).optional().nullable(),
    version: z.string().max(60).optional().nullable(),
    revisionId: z.string().max(120).optional().nullable(),
    status: z.string().max(40).optional().nullable(),
    metadata: z.unknown().optional(),
  })
  .strict();

export const flowCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  trigger: z.string().trim().min(1).max(120),
  status: flowStatusSchema.optional(),
  channel: flowChannelSchema.optional(),
  definition: z.unknown().optional(),
  metaFlow: metaFlowUpsertSchema.optional(),
});

export const flowUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    trigger: z.string().trim().min(1).max(120).optional(),
    status: flowStatusSchema.optional(),
    channel: flowChannelSchema.optional(),
    definition: z.unknown().optional(),
    metaFlow: z.union([metaFlowUpsertSchema, z.null()]).optional(),
  })
  .superRefine((value, ctx) => {
    if (!Object.keys(value).length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one field must be provided",
      });
    }

    if (
      value.metaFlow &&
      typeof value.metaFlow === "object" &&
      !Array.isArray(value.metaFlow) &&
      Object.keys(value.metaFlow).length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Meta flow update requires at least one field",
        path: ["metaFlow"],
      });
    }
  });

export type FlowCreateInput = z.infer<typeof flowCreateSchema>;
export type FlowUpdateInput = z.infer<typeof flowUpdateSchema>;
export type MetaFlowUpsertInput = z.infer<typeof metaFlowUpsertSchema>;

const flowSelect = {
  id: true,
  userId: true,
  name: true,
  trigger: true,
  status: true,
  channel: true,
  definition: true,
  metaFlowId: true,
  metaFlowToken: true,
  metaFlowVersion: true,
  metaFlowRevisionId: true,
  metaFlowStatus: true,
  metaFlowMetadata: true,
  createdAt: true,
  updatedAt: true,
} as const;

type FlowRecord = {
  id: string;
  userId: string;
  name: string;
  trigger: string;
  status: string;
  channel: string;
  definition: unknown;
  metaFlowId?: string | null;
  metaFlowToken?: string | null;
  metaFlowVersion?: string | null;
  metaFlowRevisionId?: string | null;
  metaFlowStatus?: string | null;
  metaFlowMetadata?: unknown;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type MetaFlowSummary = {
  id: string | null;
  token: string | null;
  version: string | null;
  revisionId: string | null;
  status: string | null;
  metadata: unknown;
};

export type FlowResource = {
  id: string;
  userId: string;
  name: string;
  trigger: string;
  status: string;
  channel: string;
  definition: FlowDefinition;
  metaFlow: MetaFlowSummary;
  createdAt: string;
  updatedAt: string;
};

const hasOwn = <T extends object>(source: T, key: keyof any) =>
  Object.prototype.hasOwnProperty.call(source, key);

const normalizeOptionalString = (value: string | null | undefined): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return value ?? null;
};

const isPrismaError = (value: unknown, code: string): boolean => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as { code?: unknown };
  return typeof candidate.code === "string" && candidate.code === code;
};

const toJsonValue = (value: unknown): Prisma.JsonValue => {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw new FlowValidationError(
      "Meta flow metadata must be JSON serializable",
      400,
    );
  }
};

const cloneJson = <T>(value: T): T => {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
};

const toIsoString = (value: Date | string): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  return new Date().toISOString();
};

const toFlowResource = (flow: FlowRecord): FlowResource => ({
  id: flow.id,
  userId: flow.userId,
  name: flow.name,
  trigger: flow.trigger,
  status: flow.status,
  channel: flow.channel,
  definition: sanitizeFlowDefinition(flow.definition),
  metaFlow: {
    id: flow.metaFlowId ?? null,
    token: flow.metaFlowToken ?? null,
    version: flow.metaFlowVersion ?? null,
    revisionId: flow.metaFlowRevisionId ?? null,
    status: flow.metaFlowStatus ?? null,
    metadata: cloneJson(flow.metaFlowMetadata ?? null),
  },
  createdAt: toIsoString(flow.createdAt),
  updatedAt: toIsoString(flow.updatedAt),
});

const prepareMetaFlowCreate = (payload?: MetaFlowUpsertInput) => {
  if (!payload) {
    return {} as Record<string, unknown>;
  }

  const result: Record<string, unknown> = {};

  const id = normalizeOptionalString(payload.id);
  const token = normalizeOptionalString(payload.token);
  const version = normalizeOptionalString(payload.version);
  const revisionId = normalizeOptionalString(payload.revisionId);
  const status = normalizeOptionalString(payload.status);

  if (id !== null) result.metaFlowId = id;
  if (token !== null) result.metaFlowToken = token;
  if (version !== null) result.metaFlowVersion = version;
  if (revisionId !== null) result.metaFlowRevisionId = revisionId;
  if (status !== null) result.metaFlowStatus = status;

  if (hasOwn(payload, "metadata")) {
    result.metaFlowMetadata = payload.metadata == null ? null : toJsonValue(payload.metadata);
  }

  return result;
};

const prepareMetaFlowUpdate = (
  payload: MetaFlowUpsertInput | null | undefined,
): Record<string, unknown> => {
  if (payload === null) {
    return {
      metaFlowId: null,
      metaFlowToken: null,
      metaFlowVersion: null,
      metaFlowRevisionId: null,
      metaFlowStatus: null,
      metaFlowMetadata: null,
    };
  }

  if (!payload) {
    return {};
  }

  const update: Record<string, unknown> = {};

  if (hasOwn(payload, "id")) {
    update.metaFlowId = normalizeOptionalString(payload.id);
  }
  if (hasOwn(payload, "token")) {
    update.metaFlowToken = normalizeOptionalString(payload.token);
  }
  if (hasOwn(payload, "version")) {
    update.metaFlowVersion = normalizeOptionalString(payload.version);
  }
  if (hasOwn(payload, "revisionId")) {
    update.metaFlowRevisionId = normalizeOptionalString(payload.revisionId);
  }
  if (hasOwn(payload, "status")) {
    update.metaFlowStatus = normalizeOptionalString(payload.status);
  }
  if (hasOwn(payload, "metadata")) {
    update.metaFlowMetadata = payload.metadata == null ? null : toJsonValue(payload.metadata);
  }

  return update;
};

async function ensureUserExists(userId: string): Promise<string> {
  const normalized = userId.trim();
  if (!normalized) {
    throw new FlowValidationError("User ID is required", 400);
  }

  const user = await prisma.user.findUnique({
    where: { id: normalized },
    select: { id: true },
  });

  if (!user) {
    throw new FlowValidationError("User not found", 404);
  }

  return normalized;
}

export async function createFlowForUser(
  userId: string,
  payload: FlowCreateInput,
): Promise<FlowResource> {
  const normalizedUserId = await ensureUserExists(userId);

  const parsed = flowCreateSchema.parse(payload ?? {});
  const sanitizedDefinition = sanitizeFlowDefinition(parsed.definition);
  const definitionValue = toJsonValue(sanitizedDefinition);

  const data: Record<string, unknown> = {
    name: parsed.name,
    trigger: parsed.trigger,
    status: parsed.status ?? "Draft",
    channel: parsed.channel ?? "whatsapp",
    definition: definitionValue,
    user: { connect: { id: normalizedUserId } },
    ...prepareMetaFlowCreate(parsed.metaFlow),
  };

  const created = (await prisma.flow.create({
    data,
    select: flowSelect,
  })) as FlowRecord;

  return toFlowResource(created);
}

export async function updateFlowById(
  flowId: string,
  payload: FlowUpdateInput,
): Promise<FlowResource | null> {
  const normalizedId = flowId.trim();
  if (!normalizedId) {
    throw new FlowValidationError("Flow ID is required", 400);
  }

  const parsed = flowUpdateSchema.parse(payload ?? {});
  const data: Record<string, unknown> = {};

  if (hasOwn(parsed, "name")) {
    data.name = parsed.name;
  }
  if (hasOwn(parsed, "trigger")) {
    data.trigger = parsed.trigger;
  }
  if (hasOwn(parsed, "status")) {
    data.status = parsed.status;
  }
  if (hasOwn(parsed, "channel")) {
    data.channel = parsed.channel;
  }
  if (hasOwn(parsed, "definition")) {
    data.definition = toJsonValue(sanitizeFlowDefinition(parsed.definition));
  }

  const metaFlowUpdate = prepareMetaFlowUpdate(parsed.metaFlow);
  Object.assign(data, metaFlowUpdate);

  try {
    const updated = (await prisma.flow.update({
      where: { id: normalizedId },
      data,
      select: flowSelect,
    })) as FlowRecord;

    return toFlowResource(updated);
  } catch (error) {
    if (isPrismaError(error, "P2025")) {
      return null;
    }
    throw error;
  }
}

export async function getFlowById(flowId: string): Promise<FlowResource | null> {
  const normalizedId = flowId.trim();
  if (!normalizedId) {
    throw new FlowValidationError("Flow ID is required", 400);
  }

  const flow = (await prisma.flow.findUnique({
    where: { id: normalizedId },
    select: flowSelect,
  })) as FlowRecord | null;

  return flow ? toFlowResource(flow) : null;
}
