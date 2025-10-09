import express, { type Request, type Response, type NextFunction } from "express";

import {
  processWebhookEvent,
  processManualFlowTrigger,
} from "./lib/meta";
import type {
  ManualFlowTriggerOptions,
  MetaWebhookEvent,
} from "./lib/meta";

const app = express();

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

const VERIFY_TOKEN =
  process.env.META_VERIFY_TOKEN ??
  process.env.WHATSAPP_VERIFY_TOKEN ??
  process.env.VERIFY_TOKEN ??
  "";

app.get("/health", (_req, res) => {
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
          typeof interactiveRaw.type === "string"
            ? interactiveRaw.type
            : null,
        id:
          typeof interactiveRaw.id === "string" ? interactiveRaw.id : null,
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

app.post("/meta/webhook", async (req: Request, res: Response) => {
  const payload = req.body as MetaWebhookEvent | undefined;

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

app.post("/flows/:flowId/trigger", async (req: Request, res: Response) => {
  const { flowId } = req.params;

  if (!flowId) {
    res.status(400).json({ error: "Flow ID is required" });
    return;
  }

  const { from, message, name, variables, incomingMeta } = req.body ?? {};

  if (typeof from !== "string" || !from.trim()) {
    res.status(400).json({ error: 'Field "from" must be a non-empty string' });
    return;
  }

  if (typeof message !== "string" && typeof message !== "undefined") {
    res.status(400).json({ error: 'Field "message" must be a string' });
    return;
  }

  if (typeof name !== "undefined" && typeof name !== "string") {
    res.status(400).json({ error: 'Field "name" must be a string when provided' });
    return;
  }

  if (typeof variables !== "undefined" && !isRecord(variables)) {
    res.status(400).json({ error: 'Field "variables" must be an object when provided' });
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
    res.status(500).json({ error: "Failed to trigger flow" });
  }
});

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