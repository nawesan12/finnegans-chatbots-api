import { Prisma } from "@prisma/client";
import { sanitizeFlowDefinition, } from "./flow-schema";
import prisma from "./prisma";
export class FlowSendMessageError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.name = "FlowSendMessageError";
        this.status = status;
    }
}
const DEFAULT_TRIGGER_KEYWORD = "default";
const stripDiacritics = (value) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const normalizeTrigger = (value) => {
    if (!value)
        return null;
    const trimmed = value.trim();
    if (!trimmed)
        return null;
    try {
        return stripDiacritics(trimmed).toLowerCase();
    }
    catch {
        return trimmed.toLowerCase();
    }
};
const collectNormalizedParts = (value) => {
    const result = new Set();
    if (!value) {
        return result;
    }
    result.add(value);
    for (const part of value.split(/\s+/u)) {
        if (part) {
            result.add(part);
        }
    }
    return result;
};
const normalizeTemplateComponentType = (value) => {
    const base = (value ?? "").trim();
    if (!base)
        return "body";
    return base.toLowerCase();
};
const buildTemplateMessageComponents = (params, tplFn) => {
    const grouped = new Map();
    params.forEach((param) => {
        const type = normalizeTemplateComponentType(param.component);
        const subType = (param.subType ?? "").trim();
        const index = typeof param.index === "number" && Number.isFinite(param.index)
            ? param.index
            : undefined;
        const key = `${type}::${subType.toLowerCase()}::${index ?? ""}`;
        if (!grouped.has(key)) {
            const component = {
                type,
                parameters: [],
            };
            if (subType) {
                component.subType = subType.toLowerCase();
            }
            if (typeof index === "number") {
                component.index = index;
            }
            grouped.set(key, component);
        }
        const component = grouped.get(key);
        const resolved = tplFn(param.value ?? "");
        component.parameters.push({ type: "text", text: resolved });
    });
    return Array.from(grouped.values()).map((component) => ({
        ...component,
        parameters: component.parameters.map((parameter) => ({
            type: parameter.type,
            text: parameter.text,
        })),
    }));
};
// This function is now stateful and operates on a session
export async function executeFlow(session, messageText, sendMessage, incomingMeta = null) {
    const SAFE_MAX_STEPS = 500;
    const MAX_DELAY_MS = 60_000; // cap delays to 60s/server safety
    const API_TIMEOUT_MS = 15_000;
    const flow = sanitizeFlowDefinition(session.flow.definition);
    const nodes = flow.nodes.map((node) => ({
        ...node,
        data: node.data ?? {},
    }));
    const edges = flow.edges;
    let inboundPayload = {
        text: messageText ?? "",
        type: incomingMeta?.type ?? "text",
        raw: incomingMeta?.rawText ?? messageText,
        interactiveId: incomingMeta?.interactive?.id ?? null,
        interactiveType: incomingMeta?.interactive?.type ?? null,
        interactiveTitle: incomingMeta?.interactive?.title ?? null,
        image: incomingMeta?.image ?? null,
        video: incomingMeta?.video ?? null,
        audio: incomingMeta?.audio ?? null,
        document: incomingMeta?.document ?? null,
        sticker: incomingMeta?.sticker ?? null,
    };
    // Fast indices
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const outgoingBySource = new Map();
    for (const e of edges) {
        if (!e.source || !e.target)
            continue;
        const arr = outgoingBySource.get(e.source) ?? [];
        arr.push(e);
        outgoingBySource.set(e.source, arr);
    }
    // Context bag
    const context = session.context ?? {};
    const toLc = (s) => (s ?? "").trim().toLowerCase();
    const toLcUnderscore = (value) => {
        const normalized = toLc(value);
        if (!normalized)
            return "opt";
        return normalized.replace(/\s+/g, "_");
    };
    const nowIso = () => new Date().toISOString();
    const HISTORY_LIMIT = 50;
    const ensureMeta = () => {
        if (!context._meta || typeof context._meta !== "object") {
            context._meta = { history: [] };
        }
        else if (!Array.isArray(context._meta.history)) {
            context._meta.history = [];
        }
        return context._meta;
    };
    const pushHistory = (entry) => {
        const meta = ensureMeta();
        meta.history.push(entry);
        if (meta.history.length > HISTORY_LIMIT) {
            meta.history.splice(0, meta.history.length - HISTORY_LIMIT);
        }
    };
    const recordInbound = (payload) => {
        const text = payload.text ?? "";
        const ts = nowIso();
        const trimmed = text.trim();
        const normalized = toLc(trimmed);
        const historyPayload = { text };
        if (payload.optionIndex !== undefined) {
            historyPayload.optionIndex = payload.optionIndex;
        }
        if (payload.matchedOption !== undefined) {
            historyPayload.matchedOption = payload.matchedOption;
        }
        if (payload.interactiveId !== undefined) {
            historyPayload.interactiveId = payload.interactiveId;
        }
        if (payload.interactiveType !== undefined) {
            historyPayload.interactiveType = payload.interactiveType;
        }
        if (payload.interactiveTitle !== undefined) {
            historyPayload.interactiveTitle = payload.interactiveTitle;
        }
        if (payload.image !== undefined) {
            historyPayload.image = payload.image;
        }
        if (payload.video !== undefined) {
            historyPayload.video = payload.video;
        }
        if (payload.audio !== undefined) {
            historyPayload.audio = payload.audio;
        }
        if (payload.document !== undefined) {
            historyPayload.document = payload.document;
        }
        if (payload.sticker !== undefined) {
            historyPayload.sticker = payload.sticker;
        }
        pushHistory({
            direction: "in",
            type: payload.type ?? "text",
            timestamp: ts,
            payload: historyPayload,
        });
        context.lastInteractionAt = ts;
        context.lastInboundAt = ts;
        context.lastInboundType = payload.type ?? "text";
        context.lastUserMessage = text;
        context.lastUserMessageTrimmed = trimmed;
        context.lastUserMessageNormalized = normalized;
        context.lastUserMessageAt = ts;
        context.input = text;
        context.lastInput = text;
        context.lastInputTrimmed = trimmed;
        context.lastInputNormalized = normalized;
        if (payload.raw !== undefined) {
            context.lastUserMessageRaw = payload.raw;
        }
        if (payload.interactiveId !== undefined) {
            context.lastInteractiveId = payload.interactiveId;
        }
        if (payload.interactiveType !== undefined) {
            context.lastInteractiveType = payload.interactiveType;
        }
        if (payload.interactiveTitle !== undefined) {
            context.lastInteractiveTitle = payload.interactiveTitle;
        }
        const mediaPayload = {};
        if (payload.image) {
            mediaPayload.image = payload.image;
        }
        if (payload.video) {
            mediaPayload.video = payload.video;
        }
        if (payload.audio) {
            mediaPayload.audio = payload.audio;
        }
        if (payload.document) {
            mediaPayload.document = payload.document;
        }
        if (payload.sticker) {
            mediaPayload.sticker = payload.sticker;
        }
        context.lastUserMedia = Object.keys(mediaPayload).length
            ? mediaPayload
            : null;
        if (payload.optionIndex !== undefined) {
            context.lastSelectedOptionIndex = payload.optionIndex;
        }
        else if (payload.matchedOption === null) {
            context.lastSelectedOptionIndex = null;
        }
        if (payload.matchedOption !== undefined) {
            context.lastSelectedOption = payload.matchedOption;
            context.lastOptionMatched = payload.matchedOption != null;
        }
        const previousInputs = Array.isArray(context.inputHistory)
            ? [...context.inputHistory]
            : [];
        previousInputs.push({ text, timestamp: ts });
        if (previousInputs.length > HISTORY_LIMIT) {
            previousInputs.splice(0, previousInputs.length - HISTORY_LIMIT);
        }
        context.inputHistory = previousInputs;
        const count = typeof context.messageCount === "number" &&
            Number.isFinite(context.messageCount)
            ? context.messageCount
            : 0;
        context.messageCount = count + 1;
    };
    const recordOutbound = (type, payload) => {
        const ts = nowIso();
        const historyPayload = {};
        const textValue = payload["text"];
        if (textValue !== undefined) {
            const textString = typeof textValue === "string" ? textValue : String(textValue);
            historyPayload.text = textString;
            context.lastBotMessage = textString;
        }
        const optionsValue = payload["options"];
        if (Array.isArray(optionsValue)) {
            const normalizedOptions = optionsValue.map((opt) => String(opt));
            historyPayload.options = normalizedOptions;
            if (type === "options") {
                context.lastBotOptions = normalizedOptions;
            }
        }
        else if (optionsValue !== undefined) {
            historyPayload.options = optionsValue;
        }
        else if (type === "options") {
            context.lastBotOptions = [];
        }
        const mediaTypeValue = payload["mediaType"];
        if (mediaTypeValue !== undefined) {
            historyPayload.mediaType = mediaTypeValue;
        }
        const urlValue = payload["url"];
        if (urlValue !== undefined) {
            historyPayload.url = urlValue;
        }
        const captionValue = payload["caption"];
        if (captionValue !== undefined) {
            historyPayload.caption = captionValue;
        }
        if (type === "flow") {
            historyPayload.flow = { ...payload };
            const flowBody = payload["body"];
            if (typeof flowBody === "string" && flowBody.trim()) {
                context.lastBotMessage = flowBody;
            }
        }
        if (type === "template") {
            if (payload["template"]) {
                historyPayload.template = payload["template"];
                const templateName = typeof payload["template"]?.name === "string"
                    ? payload["template"].name
                    : null;
                if (templateName) {
                    context.lastBotMessage = templateName;
                }
            }
            if (payload["parameters"]) {
                historyPayload.parameters = payload["parameters"];
            }
            if (payload["components"]) {
                historyPayload.components = payload["components"];
            }
        }
        pushHistory({
            direction: "out",
            type,
            timestamp: ts,
            payload: historyPayload,
        });
        context.lastInteractionAt = ts;
        context.lastOutboundAt = ts;
        context.lastBotMessageAt = ts;
        context.lastBotMessageType = type;
        if (type === "media") {
            const mediaEntry = {};
            if (typeof mediaTypeValue === "string") {
                mediaEntry.mediaType = mediaTypeValue;
            }
            if (typeof urlValue === "string") {
                mediaEntry.url = urlValue;
            }
            if (typeof captionValue === "string") {
                mediaEntry.caption = captionValue;
            }
            context.lastBotMedia = mediaEntry;
        }
    };
    // --- tiny helpers ---
    const getFromPath = (obj, path) => path.split(".").reduce((acc, key) => {
        if (acc === null ||
            acc === undefined ||
            (typeof acc !== "object" && typeof acc !== "function")) {
            return undefined;
        }
        return acc[key];
    }, obj);
    const setByPath = (obj, path, val) => {
        const parts = path.split(".");
        let cur = obj;
        for (let i = 0; i < parts.length - 1; i++) {
            const key = parts[i];
            const next = cur[key];
            if (typeof next === "object" && next !== null) {
                cur = next;
            }
            else {
                const fresh = {};
                cur[key] = fresh;
                cur = fresh;
            }
        }
        cur[parts[parts.length - 1]] = val;
    };
    const tpl = (s) => (s ?? "").replace(/\{\{\s*([\w.[\]0-9]+)\s*\}\}/g, (_m, key) => {
        const v = getFromPath({ context }, key) ?? getFromPath(context, key);
        return v == null ? "" : String(v);
    });
    const safeEvalBool = (expr, ctx) => {
        // Basic sanitization—reject clearly unsafe tokens
        if (/[;{}]|process|global|window|document|require|import|\beval\b/g.test(expr)) {
            throw new Error("Unsafe expression");
        }
        const fn = new Function("context", `return !!(${expr})`);
        return !!fn(ctx);
    };
    const chooseFirstEdge = (sourceId) => (outgoingBySource.get(sourceId) ?? [])[0];
    const edgeForCondition = (sourceId, res) => (outgoingBySource.get(sourceId) ?? []).find((e) => e.sourceHandle === (res ? "true" : "false"));
    const edgeForOption = (sourceId, handleId) => (outgoingBySource.get(sourceId) ?? []).find((e) => e.sourceHandle === handleId);
    const updateSession = async ({ status, currentNodeId, context: patchContext, }) => {
        const data = {};
        if (status !== undefined) {
            data.status = status;
        }
        if (currentNodeId !== undefined) {
            data.currentNodeId = currentNodeId;
        }
        if (patchContext !== undefined) {
            data.context =
                patchContext === null
                    ? Prisma.JsonNull
                    : patchContext;
        }
        await prisma.session.update({
            where: { id: session.id },
            data,
        });
    };
    const apiCall = async (url, init) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
        try {
            const res = await fetch(url, { ...init, signal: ctrl.signal });
            const txt = await res.text();
            try {
                return JSON.parse(txt);
            }
            catch {
                return txt;
            }
        }
        finally {
            clearTimeout(t);
        }
    };
    // --- Find starting node ---
    let currentNode;
    if (session.currentNodeId && session.status === "Paused") {
        const paused = nodeById.get(session.currentNodeId);
        if (!paused) {
            console.error(`Node ${session.currentNodeId} not found in flow ${session.flowId}`);
            await updateSession({ status: "Errored", context });
            return;
        }
        if (paused.type === "options") {
            // Resume from options
            const optionsData = paused.data;
            const normalizedOptions = Array.isArray(optionsData.options)
                ? optionsData.options
                : [];
            const interactiveId = inboundPayload?.interactiveId
                ? toLc(inboundPayload.interactiveId)
                : null;
            let idx = -1;
            if (interactiveId) {
                idx = normalizedOptions.findIndex((opt, optionIndex) => {
                    const optionId = toLcUnderscore(opt);
                    if (interactiveId === optionId)
                        return true;
                    // Fallback: buttons created before id normalisation may use opt-{index}
                    return interactiveId === `opt-${optionIndex}`;
                });
            }
            if (idx === -1) {
                idx = normalizedOptions.findIndex((opt) => toLc(opt) === toLc(messageText ?? ""));
            }
            const matchedOption = idx !== -1 ? (normalizedOptions[idx] ?? null) : null;
            const baseInbound = {
                ...(inboundPayload ?? { text: messageText ?? "" }),
                type: "option-selection",
                matchedOption,
            };
            baseInbound.optionIndex = idx !== -1 ? idx : undefined;
            inboundPayload = baseInbound;
            let nextId;
            if (idx !== -1) {
                nextId = edgeForOption(paused.id, `opt-${idx}`)?.target;
            }
            else {
                nextId = edgeForOption(paused.id, "no-match")?.target;
            }
            currentNode = nextId
                ? nodeById.get(nextId)
                : undefined;
            if (nextId && !currentNode) {
                console.error(`Next node ${nextId} not found (resume)`);
                await updateSession({ status: "Errored", context });
                return;
            }
            await updateSession({ status: "Active", context });
        }
        else {
            currentNode = paused;
        }
    }
    else {
        // New / active session: match trigger with normalized keywords
        const normalizedInput = normalizeTrigger(messageText ?? null);
        const inputTokens = collectNormalizedParts(normalizedInput);
        const triggerNodes = nodes.filter((node) => node.type === "trigger");
        let matchedTrigger = null;
        let defaultTrigger = null;
        for (const triggerNode of triggerNodes) {
            const keywordRaw = triggerNode.data?.keyword ?? null;
            const normalizedKeyword = normalizeTrigger(keywordRaw);
            if (!normalizedKeyword) {
                continue;
            }
            if (normalizedKeyword === DEFAULT_TRIGGER_KEYWORD) {
                if (!defaultTrigger) {
                    defaultTrigger = triggerNode;
                }
                continue;
            }
            if (normalizedInput &&
                (normalizedInput === normalizedKeyword ||
                    normalizedInput.includes(normalizedKeyword))) {
                matchedTrigger = triggerNode;
                break;
            }
            if (inputTokens.has(normalizedKeyword)) {
                matchedTrigger = triggerNode;
                break;
            }
        }
        if (!matchedTrigger && defaultTrigger) {
            matchedTrigger = defaultTrigger;
        }
        if (matchedTrigger) {
            currentNode = matchedTrigger;
            context.triggerMessage = messageText ?? undefined;
        }
        else {
            console.log(`No trigger for "${messageText}" in flow ${session.flowId}`);
            return;
        }
    }
    if (inboundPayload && (session.status === "Paused" || currentNode)) {
        recordInbound(inboundPayload);
    }
    // --- Main loop ---
    const visited = new Set();
    let steps = 0;
    try {
        while (currentNode) {
            if (steps++ > SAFE_MAX_STEPS) {
                await updateSession({ status: "Errored", context });
                console.error("Guard limit reached");
                return;
            }
            if (visited.has(currentNode.id)) {
                await updateSession({ status: "Errored", context });
                console.error("Loop detected at", currentNode.id);
                return;
            }
            visited.add(currentNode.id);
            await updateSession({ currentNodeId: currentNode.id, context });
            let nextNodeId;
            switch (currentNode.type) {
                case "trigger":
                    // no-op
                    break;
                case "message": {
                    const data = currentNode.data;
                    if (data.useTemplate) {
                        const templateName = data.templateName?.trim();
                        const templateLanguage = data.templateLanguage?.trim();
                        if (!templateName || !templateLanguage) {
                            throw new FlowSendMessageError("Missing template name or language for WhatsApp template message", 400);
                        }
                        const templateParams = Array.isArray(data.templateParameters)
                            ? data.templateParameters
                            : [];
                        const components = buildTemplateMessageComponents(templateParams, tpl);
                        const sendResult = await sendMessage(session.flow.userId, session.contact.phone, {
                            type: "template",
                            template: {
                                name: templateName,
                                language: templateLanguage,
                                ...(components.length ? { components } : {}),
                            },
                        });
                        if (!sendResult?.success) {
                            console.error("Failed to send template message to", session.contact.phone, sendResult?.error ?? "");
                            const message = sendResult?.error?.trim().length
                                ? sendResult.error
                                : "Failed to send WhatsApp template message";
                            throw new FlowSendMessageError(message, sendResult?.status);
                        }
                        recordOutbound("template", {
                            template: {
                                name: templateName,
                                language: templateLanguage,
                            },
                            parameters: templateParams.map((param) => ({
                                component: typeof param.component === "string" && param.component.trim()
                                    ? param.component.trim().toUpperCase()
                                    : "BODY",
                                subType: typeof param.subType === "string" && param.subType.trim()
                                    ? param.subType.trim().toUpperCase()
                                    : null,
                                index: typeof param.index === "number" &&
                                    Number.isFinite(param.index)
                                    ? param.index
                                    : null,
                                value: tpl(param.value ?? ""),
                                raw: param.value ?? "",
                            })),
                            components,
                        });
                        break;
                    }
                    const text = tpl(data.text);
                    const sendResult = await sendMessage(session.flow.userId, session.contact.phone, {
                        type: "text",
                        text,
                    });
                    if (!sendResult?.success) {
                        console.error("Failed to send text message to", session.contact.phone, sendResult?.error ?? "");
                        const message = sendResult?.error?.trim().length
                            ? sendResult.error
                            : "Failed to send WhatsApp text message";
                        throw new FlowSendMessageError(message, sendResult?.status);
                    }
                    recordOutbound("text", { text });
                    break;
                }
                case "options": {
                    const data = currentNode.data;
                    const text = tpl(data.text ?? "");
                    const options = data.options ?? [];
                    const sendResult = await sendMessage(session.flow.userId, session.contact.phone, {
                        type: "options",
                        text,
                        options,
                    });
                    if (!sendResult?.success) {
                        console.error("Failed to send options message to", session.contact.phone, sendResult?.error ?? "");
                        const message = sendResult?.error?.trim().length
                            ? sendResult.error
                            : "Failed to send WhatsApp options message";
                        throw new FlowSendMessageError(message, sendResult?.status);
                    }
                    recordOutbound("options", { text, options });
                    await updateSession({ status: "Paused", context });
                    return; // wait for user input
                }
                case "delay": {
                    const data = currentNode.data;
                    const ms = Math.min(Math.max(0, (data.seconds ?? 0) * 1000), MAX_DELAY_MS);
                    if (ms > 0)
                        await new Promise((r) => setTimeout(r, ms));
                    break;
                }
                case "condition": {
                    const data = currentNode.data;
                    const expr = String(data.expression ?? "false");
                    let res = false;
                    try {
                        res = safeEvalBool(expr, { ...context });
                    }
                    catch (e) {
                        console.error("Condition error:", e);
                        res = false;
                    }
                    nextNodeId = edgeForCondition(currentNode.id, res)?.target;
                    break;
                }
                case "api": {
                    const data = currentNode.data;
                    const method = String(data.method || "GET").toUpperCase();
                    const url = tpl(data.url);
                    const headersObj = data.headers ?? {};
                    // Interpolate headers
                    const headers = Object.fromEntries(Object.entries(headersObj).map(([k, v]) => [
                        k,
                        typeof v === "string" ? tpl(v) : v,
                    ]));
                    const init = { method, headers };
                    if (method !== "GET" && method !== "HEAD") {
                        init.body = tpl(data.body ?? "");
                    }
                    try {
                        const result = await apiCall(url, init);
                        setByPath(context, data.assignTo ?? "apiResult", result);
                    }
                    catch (e) {
                        console.error("API error:", e);
                        setByPath(context, data.assignTo ?? "apiResult", {
                            error: "API call failed",
                        });
                    }
                    break;
                }
                case "assign": {
                    const data = currentNode.data;
                    const key = data.key ?? "";
                    if (key)
                        setByPath(context, key, tpl(String(data.value ?? "")));
                    break;
                }
                case "media": {
                    const data = currentNode.data;
                    const mediaPayload = {
                        mediaType: data.mediaType,
                        id: data.id ? tpl(data.id) : undefined,
                        url: data.url ? tpl(data.url) : undefined,
                        caption: data.caption ? tpl(data.caption) : undefined,
                    };
                    const sendResult = await sendMessage(session.flow.userId, session.contact.phone, { type: "media", ...mediaPayload });
                    if (!sendResult?.success) {
                        console.error("Failed to send media message to", session.contact.phone, sendResult?.error ?? "");
                        const message = sendResult?.error?.trim().length
                            ? sendResult.error
                            : "Failed to send WhatsApp media message";
                        throw new FlowSendMessageError(message, sendResult?.status);
                    }
                    recordOutbound("media", mediaPayload);
                    break;
                }
                case "whatsapp_flow": {
                    const data = currentNode.data;
                    const headerText = tpl(data.header ?? "").trim();
                    const bodyText = tpl(data.body ?? "");
                    const footerText = tpl(data.footer ?? "").trim();
                    const ctaText = tpl(data.cta ?? "").trim();
                    if (!bodyText.trim()) {
                        throw new FlowSendMessageError("WhatsApp Flow body cannot be empty.", 400);
                    }
                    const metaFlowId = session.flow.metaFlowId?.trim() ?? null;
                    const metaFlowToken = session.flow.metaFlowToken?.trim() ?? null;
                    const metaFlowVersion = session.flow.metaFlowVersion?.trim() ?? undefined;
                    if (!metaFlowId || !metaFlowToken) {
                        throw new FlowSendMessageError("Flow is not synchronized with Meta. Save the flow to sync identifiers.", 400);
                    }
                    const sendResult = await sendMessage(session.flow.userId, session.contact.phone, {
                        type: "flow",
                        flow: {
                            name: session.flow.name,
                            id: metaFlowId,
                            token: metaFlowToken,
                            version: metaFlowVersion,
                            header: headerText || undefined,
                            body: bodyText,
                            footer: footerText || undefined,
                            cta: ctaText || undefined,
                        },
                    });
                    if (!sendResult?.success) {
                        console.error("Failed to send WhatsApp Flow message to", session.contact.phone, sendResult?.error ?? "");
                        const message = sendResult?.error?.trim().length
                            ? sendResult.error
                            : "Failed to send WhatsApp Flow message";
                        throw new FlowSendMessageError(message, sendResult?.status);
                    }
                    recordOutbound("flow", {
                        header: headerText,
                        body: bodyText,
                        footer: footerText,
                        cta: ctaText,
                    });
                    break;
                }
                case "handoff": {
                    const data = currentNode.data;
                    context.handoffQueue = data.queue;
                    context.handoffNote = data.note ? tpl(data.note) : undefined;
                    await updateSession({ status: "Paused", context });
                    return; // agent picks up
                }
                case "goto": {
                    const data = currentNode.data;
                    nextNodeId = data.targetNodeId;
                    break;
                }
                case "end": {
                    const data = currentNode.data;
                    context.endReason = data.reason ?? "end";
                    await updateSession({
                        status: "Completed",
                        currentNodeId: null,
                        context,
                    });
                    return;
                }
                default:
                    console.warn(`Unhandled node type: ${currentNode.type}`);
            }
            // Determine next if not set explicitly
            if (!nextNodeId && currentNode.type !== "condition") {
                nextNodeId = chooseFirstEdge(currentNode.id)?.target;
            }
            if (!nextNodeId) {
                // No outgoing path → stop gracefully
                await updateSession({
                    status: "Completed",
                    currentNodeId: null,
                    context,
                });
                return;
            }
            const next = nodeById.get(nextNodeId);
            if (!next) {
                console.error(`Next node ${nextNodeId} not found`);
                await updateSession({ status: "Errored", context });
                return;
            }
            // Persist context between steps
            await updateSession({ context });
            currentNode = next;
        }
    }
    catch (err) {
        console.error("Flow execution error:", err);
        await updateSession({ status: "Errored", context });
        throw err;
    }
}
//# sourceMappingURL=flow-executor.js.map