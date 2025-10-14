import { z } from "zod";

export class FlowSanitizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowSanitizationError";
  }
}

export const waTextLimit = 4096;

export const BaseDataSchema = z.object({
  name: z.string().min(1).max(60).default(""),
});

export const TriggerDataSchema = BaseDataSchema.extend({
  keyword: z.string().min(1).max(64),
});

export const TemplateParameterSchema = z.object({
  component: z.string().min(1),
  type: z.literal("text").default("text"),
  value: z.string().max(1024).default(""),
  subType: z.string().max(60).optional(),
  index: z.number().int().min(0).optional(),
});

export const MessageDataSchema = BaseDataSchema.extend({
  text: z.string().max(waTextLimit).default(""),
  useTemplate: z.boolean().default(false),
  templateName: z.string().max(512).optional(),
  templateLanguage: z.string().max(24).optional(),
  templateParameters: z.array(TemplateParameterSchema).default([]),
}).superRefine((value, ctx) => {
  if (value.useTemplate) {
    if (!value.templateName?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Template name is required when using templates",
        path: ["templateName"],
      });
    }
    if (!value.templateLanguage?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Template language is required when using templates",
        path: ["templateLanguage"],
      });
    }
  } else {
    const trimmed = value.text?.trim?.() ?? "";
    if (!trimmed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Message text is required",
        path: ["text"],
      });
    }
  }
});

export const OptionsDataSchema = BaseDataSchema.extend({
  options: z.array(z.string().min(1).max(30)).min(2).max(10),
});

export const WhatsAppFlowDataSchema = BaseDataSchema.extend({
  header: z.string().max(60).optional(),
  body: z.string().min(1).max(1024),
  footer: z.string().max(60).optional(),
  cta: z.string().max(40).optional(),
});

export const DelayDataSchema = BaseDataSchema.extend({
  seconds: z.number().min(1).max(3600).default(1),
});

export const ConditionDataSchema = BaseDataSchema.extend({
  expression: z.string().min(1).max(500),
});

export const APICallDataSchema = BaseDataSchema.extend({
  url: z.string().url(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().default(""),
  assignTo: z.string().default("apiResult"),
});

export const AssignVarDataSchema = BaseDataSchema.extend({
  key: z.string().min(1).max(50),
  value: z.string().max(500),
});

export const MediaDataSchema = BaseDataSchema.extend({
  mediaType: z.enum(["image", "document", "video", "audio"]).default("image"),
  url: z.string().url().optional(),
  id: z.string().min(1).optional(),
  caption: z.string().max(1024).optional(),
}).superRefine((data, ctx) => {
  if (!data.url && !data.id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Either a media URL or a media ID must be provided.",
      path: ["url"],
    });
  }
});

export const HandoffDataSchema = BaseDataSchema.extend({
  queue: z.string().min(1),
  note: z.string().max(500).optional(),
});

export const EndDataSchema = BaseDataSchema.extend({
  reason: z.string().default("end"),
});

export const GoToDataSchema = BaseDataSchema.extend({
  targetNodeId: z.string().min(1),
});

export const flowNodeTypes = [
  "trigger",
  "message",
  "options",
  "delay",
  "condition",
  "api",
  "assign",
  "media",
  "whatsapp_flow",
  "handoff",
  "goto",
  "end",
] as const;

export type FlowNodeType = (typeof flowNodeTypes)[number];

const coordinateSchema = z.coerce.number().finite().catch(0);

const FlowNodeSchemaInternal = z
  .object({
    id: z.string().min(1),
    type: z.enum(flowNodeTypes),
    position: z
      .object({
        x: coordinateSchema.optional(),
        y: coordinateSchema.optional(),
      })
      .partial()
      .optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

const FlowEdgeSchemaInternal = z
  .object({
    id: z.string().min(1),
    source: z.string().min(1),
    target: z.string().min(1),
    sourceHandle: z.union([z.string(), z.null()]).optional(),
    targetHandle: z.union([z.string(), z.null()]).optional(),
  })
  .passthrough();

export const FlowDefinitionSchema = z
  .object({
    nodes: z.array(FlowNodeSchemaInternal).default([]),
    edges: z.array(FlowEdgeSchemaInternal).default([]),
  })
  .default({ nodes: [], edges: [] });

export type FlowNodePayload = z.infer<typeof FlowNodeSchemaInternal>;
export type FlowEdgePayload = z.infer<typeof FlowEdgeSchemaInternal>;
export type FlowDefinition = z.infer<typeof FlowDefinitionSchema>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const deepClone = <T>(value: T): T => {
  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(value);
    } catch {
      // ignore and fall back
    }
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as unknown as T;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, deepClone(entry)]),
    ) as T;
  }
  return value;
};

const ensureCoordinate = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const coerced = Number(value);
  return Number.isFinite(coerced) ? coerced : 0;
};

const parseFlowInput = (input: unknown): unknown => {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) {
      return {};
    }

    try {
      return JSON.parse(trimmed);
    } catch {
      throw new FlowSanitizationError(
        "Flow definition string must be valid JSON.",
      );
    }
  }

  return input ?? {};
};

export const sanitizeFlowDefinition = (input: unknown): FlowDefinition => {
  const parsed = FlowDefinitionSchema.parse(parseFlowInput(input));
  const nodes = parsed.nodes.map((node) => {
    const clone = deepClone(node);
    const position = isPlainObject(clone.position) ? clone.position : {};
    return {
      ...clone,
      id: String(clone.id),
      type: clone.type,
      data: isPlainObject(clone.data) ? deepClone(clone.data) : {},
      position: {
        x: ensureCoordinate((position as { x?: unknown }).x),
        y: ensureCoordinate((position as { y?: unknown }).y),
      },
    };
  });

  const edges = parsed.edges.map((edge) => {
    const clone = deepClone(edge);
    const normalizeHandle = (handle: unknown) => {
      if (typeof handle === "string") return handle;
      if (handle === null) return null;
      return undefined;
    };
    return {
      ...clone,
      id: String(clone.id),
      source: String(clone.source),
      target: String(clone.target),
      sourceHandle: normalizeHandle(clone.sourceHandle),
      targetHandle: normalizeHandle(clone.targetHandle),
    };
  });

  return { nodes, edges };
};

export const emptyFlowDefinition: FlowDefinition = { nodes: [], edges: [] };
