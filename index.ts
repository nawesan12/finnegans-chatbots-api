import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { ZodError } from "zod";

import { processWebhookEvent, processManualFlowTrigger } from "./lib/meta";
import type {
  ManualFlowTriggerOptions,
  ManualFlowTriggerResult,
  MetaWebhookPayload,
} from "./lib/meta";
import {
  createFlowForUser,
  getFlowById,
  updateFlowById,
  FlowValidationError,
  type FlowCreateInput,
  type FlowResource,
  type FlowUpdateInput,
} from "./lib/flow-service";

type ManualFlowTriggerRequestBody = {
  from?: string;
  message?: string;
  name?: string;
  variables?: Record<string, unknown>;
  incomingMeta?: ManualFlowTriggerOptions["incomingMeta"];
};

type FlowSuccessResponse = { success: true; flow: FlowResource };
type FlowErrorResponse = { success: false; error: string };

const app = express();

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

const VERIFY_TOKEN =
  process.env.META_VERIFY_TOKEN ??
  process.env.WHATSAPP_VERIFY_TOKEN ??
  process.env.VERIFY_TOKEN ??
  "";

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

app.get("/meta/webhook", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && typeof challenge === "string") {
    if (!VERIFY_TOKEN || token !== VERIFY_TOKEN) {
      res.sendStatus(403);
      return;
    }

    res.status(200).send(challenge);
    return;
  }

  res.status(400).send("Invalid verification request");
});

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const sanitizeIncomingMeta = (
  raw: unknown,
): ManualFlowTriggerOptions["incomingMeta"] => {
  if (!isRecord(raw)) {
    return null;
  }

  const interactiveRaw = raw.interactive;
  const interactive = isRecord(interactiveRaw)
    ? {
        type:
          typeof interactiveRaw.type === "string" ? interactiveRaw.type : null,
        id: typeof interactiveRaw.id === "string" ? interactiveRaw.id : null,
        title:
          typeof interactiveRaw.title === "string"
            ? interactiveRaw.title
            : null,
      }
    : null;

  const sanitizeMedia = (value: unknown) => (isRecord(value) ? value : null);

  return {
    type: typeof raw.type === "string" ? raw.type : null,
    rawText: typeof raw.rawText === "string" ? raw.rawText : null,
    interactive,
    image: sanitizeMedia(raw.image),
    video: sanitizeMedia(raw.video),
    audio: sanitizeMedia(raw.audio),
    document: sanitizeMedia(raw.document),
    sticker: sanitizeMedia(raw.sticker),
  };
};

const isPrismaError = (value: unknown, code: string): boolean => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as { code?: unknown };
  return typeof candidate.code === "string" && candidate.code === code;
};

const handleFlowRouteError = (
  error: unknown,
  res: Response<FlowErrorResponse>,
  action: string,
) => {
  if (error instanceof ZodError) {
    const message =
      error.issues?.[0]?.message ?? error.message ?? "Invalid flow payload";
    res.status(400).json({ success: false, error: message });
    return;
  }

  if (error instanceof FlowValidationError) {
    res.status(error.status).json({ success: false, error: error.message });
    return;
  }

  if (isPrismaError(error, "P2002")) {
    res.status(409).json({
      success: false,
      error: "A flow with the provided Meta Flow ID already exists",
    });
    return;
  }

  console.error(`Failed to ${action}:`, error);
  res.status(500).json({ success: false, error: "Failed to persist flow" });
};

app.post("/meta/webhook", async (req: Request, res: Response) => {
  const payload = req.body as MetaWebhookPayload | undefined;

  if (!payload || typeof payload !== "object") {
    res.status(400).json({ error: "Invalid webhook payload" });
    return;
  }

  try {
    await processWebhookEvent(payload);
    res.sendStatus(200);
  } catch (error) {
    console.error("Failed to process webhook event:", error);
    res.status(500).json({ error: "Failed to process webhook event" });
  }
});

app.get<{ flowId: string }, FlowSuccessResponse | FlowErrorResponse>(
  "/flows/:flowId",
  async (req, res) => {
    const { flowId } = req.params;

    try {
      const flow = await getFlowById(flowId);
      if (!flow) {
        res.status(404).json({ success: false, error: "Flow not found" });
        return;
      }

      res.json({ success: true, flow });
    } catch (error) {
      handleFlowRouteError(error, res, "retrieve flow");
    }
  },
);

app.post<
  { userId: string },
  FlowSuccessResponse | FlowErrorResponse,
  FlowCreateInput
>("/users/:userId/flows", async (req, res) => {
  const { userId } = req.params;

  try {
    const flow = await createFlowForUser(userId, req.body);
    res.status(201).json({ success: true, flow });
  } catch (error) {
    handleFlowRouteError(error, res, "create flow");
  }
});

app.put<
  { flowId: string },
  FlowSuccessResponse | FlowErrorResponse,
  FlowUpdateInput
>("/flows/:flowId", async (req, res) => {
  const { flowId } = req.params;

  try {
    const flow = await updateFlowById(flowId, req.body);
    if (!flow) {
      res.status(404).json({ success: false, error: "Flow not found" });
      return;
    }

    res.json({ success: true, flow });
  } catch (error) {
    handleFlowRouteError(error, res, "update flow");
  }
});

app.post<
  { flowId: string },
  ManualFlowTriggerResult,
  ManualFlowTriggerRequestBody
>(
  "/flows/:flowId/trigger",
  async (
    req: Request<
      { flowId: string },
      ManualFlowTriggerResult,
      ManualFlowTriggerRequestBody
    >,
    res: Response<ManualFlowTriggerResult>,
  ) => {
    const { flowId } = req.params;

    if (!flowId) {
      res
        .status(400)
        .json({ success: false, error: "Flow ID is required", status: 400 });
      return;
    }

    const { from, message, name, variables, incomingMeta } = req.body ?? {};

    if (typeof from !== "string" || !from.trim()) {
      res.status(400).json({
        success: false,
        error: 'Field "from" must be a non-empty string',
        status: 400,
      });
      return;
    }

    if (typeof message !== "string" && typeof message !== "undefined") {
      res.status(400).json({
        success: false,
        error: 'Field "message" must be a string',
        status: 400,
      });
      return;
    }

    if (typeof name !== "undefined" && typeof name !== "string") {
      res.status(400).json({
        success: false,
        error: 'Field "name" must be a string when provided',
        status: 400,
      });
      return;
    }

    if (typeof variables !== "undefined" && !isRecord(variables)) {
      res.status(400).json({
        success: false,
        error: 'Field "variables" must be an object when provided',
        status: 400,
      });
      return;
    }

    const options: ManualFlowTriggerOptions = {
      flowId,
      from,
      message: typeof message === "string" ? message : "",
      name: typeof name === "string" ? name : null,
      variables: isRecord(variables) ? variables : null,
      incomingMeta: sanitizeIncomingMeta(incomingMeta),
    };

    try {
      const result = await processManualFlowTrigger(options);

      if (result.success) {
        res.json(result);
        return;
      }

      res.status(result.status ?? 500).json(result);
    } catch (error) {
      console.error("Failed to trigger flow manually:", error);
      res.status(500).json({
        success: false,
        error: "Failed to trigger flow",
        status: 500,
      });
    }
  },
);

// Generic error handler
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", error);
  res.status(500).json({ error: "Internal server error" });
});

const portRaw = process.env.PORT ?? process.env.APP_PORT ?? "3000";
const port = Number.parseInt(portRaw, 10);
const listenPort = Number.isFinite(port) ? port : 3000;

app.listen(listenPort, () => {
  console.log(`Server listening on port ${listenPort}`);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});

export default app;
