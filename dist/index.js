import express from "express";
import { ZodError } from "zod";
import crypto from "node:crypto";
import http from "node:http";
import { processWebhookEvent, processManualFlowTrigger } from "./lib/meta.js";
import { initializeSocketServer } from "./lib/socket.js";
import { createFlowForUser, getFlowById, updateFlowById, FlowValidationError, } from "./lib/flow-service";
const app = express();
const httpServer = http.createServer(app);
// Initialize WebSocket server
initializeSocketServer(httpServer);
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN ??
    process.env.WHATSAPP_VERIFY_TOKEN ??
    process.env.VERIFY_TOKEN ??
    "";
const APP_SECRET = process.env.META_APP_SECRET ??
    process.env.WHATSAPP_APP_SECRET ??
    "";
function verifyWebhookSignature(body, signature) {
    if (!APP_SECRET) {
        console.warn("META_APP_SECRET not configured - webhook signature verification disabled");
        return true;
    }
    const hash = crypto
        .createHmac("sha256", APP_SECRET)
        .update(JSON.stringify(body))
        .digest("hex");
    return signature === `sha256=${hash}`;
}
app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
});
app.get("/meta/webhook", (req, res) => {
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
const isRecord = (value) => {
    return typeof value === "object" && value !== null && !Array.isArray(value);
};
const sanitizeIncomingMeta = (raw) => {
    if (!isRecord(raw)) {
        return null;
    }
    const interactiveRaw = raw.interactive;
    const interactive = isRecord(interactiveRaw)
        ? {
            type: typeof interactiveRaw.type === "string" ? interactiveRaw.type : null,
            id: typeof interactiveRaw.id === "string" ? interactiveRaw.id : null,
            title: typeof interactiveRaw.title === "string"
                ? interactiveRaw.title
                : null,
        }
        : null;
    const sanitizeMedia = (value) => (isRecord(value) ? value : null);
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
const isPrismaError = (value, code) => {
    if (!value || typeof value !== "object") {
        return false;
    }
    const candidate = value;
    return typeof candidate.code === "string" && candidate.code === code;
};
const handleFlowRouteError = (error, res, action) => {
    if (error instanceof ZodError) {
        const message = error.issues?.[0]?.message ?? error.message ?? "Invalid flow payload";
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
app.post("/meta/webhook", async (req, res) => {
    const payload = req.body;
    if (!payload || typeof payload !== "object") {
        res.status(400).json({ error: "Invalid webhook payload" });
        return;
    }
    // Verify webhook signature
    const signature = req.headers?.["x-hub-signature-256"] || "";
    if (APP_SECRET && (!signature || !verifyWebhookSignature(payload, signature))) {
        console.error("Invalid webhook signature");
        res.status(403).json({ error: "Invalid signature" });
        return;
    }
    try {
        await processWebhookEvent(payload);
        res.sendStatus(200);
    }
    catch (error) {
        console.error("Failed to process webhook event:", error);
        res.status(500).json({ error: "Failed to process webhook event" });
    }
});
app.get("/flows/:flowId", async (req, res) => {
    const { flowId } = req.params;
    try {
        const flow = await getFlowById(flowId);
        if (!flow) {
            res.status(404).json({ success: false, error: "Flow not found" });
            return;
        }
        res.json({ success: true, flow });
    }
    catch (error) {
        handleFlowRouteError(error, res, "retrieve flow");
    }
});
app.post("/users/:userId/flows", async (req, res) => {
    const { userId } = req.params;
    try {
        const flow = await createFlowForUser(userId, req.body);
        res.status(201).json({ success: true, flow });
    }
    catch (error) {
        handleFlowRouteError(error, res, "create flow");
    }
});
app.put("/flows/:flowId", async (req, res) => {
    const { flowId } = req.params;
    try {
        const flow = await updateFlowById(flowId, req.body);
        if (!flow) {
            res.status(404).json({ success: false, error: "Flow not found" });
            return;
        }
        res.json({ success: true, flow });
    }
    catch (error) {
        handleFlowRouteError(error, res, "update flow");
    }
});
app.post("/flows/:flowId/trigger", async (req, res) => {
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
    const options = {
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
    }
    catch (error) {
        console.error("Failed to trigger flow manually:", error);
        res.status(500).json({
            success: false,
            error: "Failed to trigger flow",
            status: 500,
        });
    }
});
// Generic error handler
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((error, _req, res, _next) => {
    console.error("Unhandled error:", error);
    res.status(500).json({ error: "Internal server error" });
});
const portRaw = process.env.PORT ?? process.env.APP_PORT ?? "3000";
const port = Number.parseInt(portRaw, 10);
const listenPort = Number.isFinite(port) ? port : 3000;
const wsPortRaw = process.env.WEBSOCKET_PORT ?? process.env.WS_PORT ?? "3001";
const wsPort = Number.parseInt(wsPortRaw, 10);
const wsListenPort = Number.isFinite(wsPort) ? wsPort : 3001;
app.listen(listenPort, () => {
    console.log(`Webhook server listening on port ${listenPort}`);
});
httpServer.listen(wsListenPort, () => {
    console.log(`WebSocket server listening on port ${wsListenPort}`);
});
process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
});
export default app;
//# sourceMappingURL=index.js.map