import type {
  Contact,
  Flow,
  Prisma,
  Session as PrismaSession,
} from "@prisma/client";

import prisma from "./prisma";
import { executeFlow, FlowSendMessageError } from "./flow-executor";

type SessionWithRelations = PrismaSession & {
  flow: Flow;
  contact: Contact;
};

/* ===== Tipos del webhook de Meta (simplificados y seguros) ===== */
type WAMessageType =
  | "text"
  | "interactive"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker"
  | "unknown";

interface WAButtonReply {
  id: string;
  title: string;
}

interface WAListReply {
  id: string;
  title: string;
  description?: string;
}

interface WAInteractive {
  type: "button" | "list";
  button_reply?: WAButtonReply;
  list_reply?: WAListReply;
}

interface WAMedia {
  id: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
}

type WAImage = WAMedia;
type WAVideo = WAMedia;
interface WAAudio extends WAMedia {
  voice?: boolean;
}
interface WADocument extends WAMedia {
  filename?: string;
}
type WASticker = WAMedia;

interface WAMessage {
  id: string;
  from: string;
  timestamp?: string;
  type?: WAMessageType;
  text?: { body?: string };
  interactive?: WAInteractive;
  image?: WAImage;
  video?: WAVideo;
  audio?: WAAudio;
  document?: WADocument;
  sticker?: WASticker;
}

interface WAStatusError {
  code?: number | string;
  title?: string;
  message?: string;
  error_data?: { details?: string };
}

interface WAStatusConversation {
  id?: string;
  origin?: { type?: string };
}

interface WAStatus {
  id?: string;
  status?: string;
  timestamp?: string;
  recipient_id?: string;
  conversation?: WAStatusConversation;
  pricing?: { billable?: boolean; pricing_model?: string };
  errors?: WAStatusError[];
}

interface WAContactProfile {
  name?: string;
}

interface WAContact {
  wa_id?: string;
  profile?: WAContactProfile;
  display_phone_number?: string;
  phone_number?: string;
  name?: string;
}

interface WAChangeValue {
  messages?: WAMessage[];
  statuses?: WAStatus[];
  metadata: {
    phone_number_id: string;
    display_phone_number?: string;
    wa_id?: string;
    whatsapp_business_account_id?: string;
  };
  contacts?: WAContact[];
  errors?: WAStatusError[];
}

interface WAEntry {
  changes?: { value?: WAChangeValue }[];
}

export interface MetaWebhookEvent {
  object?: string;
  entry?: WAEntry[];
}

interface WAStandaloneChangeEvent {
  field?: string;
  value?: WAChangeValue;
}

export type MetaWebhookPayload = MetaWebhookEvent | WAStandaloneChangeEvent;

export type ManualFlowTriggerOptions = {
  flowId: string;
  from: string;
  message: string;
  name?: string | null;
  variables?: Record<string, unknown> | null;
  incomingMeta?: {
    type?: string | null;
    rawText?: string | null;
    interactive?: {
      type?: string | null;
      id?: string | null;
      title?: string | null;
    } | null;
    image?: Record<string, unknown> | null;
    video?: Record<string, unknown> | null;
    audio?: Record<string, unknown> | null;
    document?: Record<string, unknown> | null;
    sticker?: Record<string, unknown> | null;
  } | null;
};

export type ManualFlowTriggerResult =
  | {
      success: true;
      flowId: string;
      contactId: string;
      sessionId: string;
    }
  | {
      success: false;
      error: string;
      status?: number;
    };

/* ===== Utilidades ===== */
const toLcTrim = (s?: string) => (s ?? "").trim().toLowerCase();

const DEFAULT_TRIGGER = "default";

const stripDiacritics = (value: string) =>
  value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

const normalizeTrigger = (value?: string | null): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return stripDiacritics(trimmed).toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
};

const isWhatsappChannel = (channel?: string | null): boolean => {
  if (channel === null || channel === undefined) {
    return true;
  }
  const trimmed = channel.trim();
  if (!trimmed) {
    return true;
  }
  return trimmed.toLowerCase() === "whatsapp";
};

const normalizePhone = (value?: string | null): string | null => {
  if (!value) return null;
  const digits = value.replace(/[^0-9]/g, "");
  return digits.length ? digits : null;
};

const isPrismaError = (value: unknown, code: string): boolean => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as { code?: unknown };
  return typeof candidate.code === "string" && candidate.code === code;
};

type FlowMatchContext = {
  fullText: string | null;
  interactiveTitle: string | null;
  interactiveId: string | null;
};

const toRecordIfObject = (
  value: unknown,
): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
};

const collectKeywordCandidates = (
  text: string | null,
  interactiveTitle: string | null,
  interactiveId: string | null,
) => {
  const candidates = new Set<string>();
  const push = (value: string | null) => {
    const normalized = normalizeTrigger(value);
    if (!normalized) return;
    candidates.add(normalized);
    for (const part of normalized.split(/\s+/u)) {
      if (part) candidates.add(part);
    }
  };

  push(text);
  push(interactiveTitle);
  push(interactiveId);

  return candidates;
};

const findBestMatchingFlow = (flows: Flow[], context: FlowMatchContext) => {
  if (!flows.length) {
    return null;
  }

  const keywordCandidates = collectKeywordCandidates(
    context.fullText,
    context.interactiveTitle,
    context.interactiveId,
  );
  const normalizedText = normalizeTrigger(context.fullText);
  const normalizedInteractiveTitle = normalizeTrigger(context.interactiveTitle);
  const normalizedInteractiveId = normalizeTrigger(context.interactiveId);

  let bestFlow: Flow | null = null;
  let bestScore = -1;
  let bestUpdatedAt = 0;

  const toTimestamp = (value: Date | string) => {
    const result =
      value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(result) ? result : 0;
  };

  for (const flow of flows) {
    const normalizedTrigger = normalizeTrigger(flow.trigger);
    const isDefaultTrigger = normalizedTrigger === DEFAULT_TRIGGER;

    let matchesTrigger = false;
    if (normalizedTrigger && !isDefaultTrigger) {
      if (keywordCandidates.has(normalizedTrigger)) {
        matchesTrigger = true;
      } else if (normalizedText && normalizedText.includes(normalizedTrigger)) {
        matchesTrigger = true;
      } else if (
        normalizedInteractiveTitle &&
        normalizedInteractiveTitle.includes(normalizedTrigger)
      ) {
        matchesTrigger = true;
      } else if (
        normalizedInteractiveId &&
        normalizedInteractiveId === normalizedTrigger
      ) {
        matchesTrigger = true;
      }
    }

    let score = 0;
    if (matchesTrigger) {
      score += 6;
      if (normalizedTrigger && normalizedText === normalizedTrigger) {
        score += 2;
      }
      if (
        normalizedTrigger &&
        normalizedInteractiveTitle === normalizedTrigger
      ) {
        score += 1;
      }
      if (normalizedTrigger && normalizedInteractiveId === normalizedTrigger) {
        score += 1;
      }
    }
    if (!matchesTrigger && isDefaultTrigger) score += 1;

    if (score <= 0) {
      continue;
    }

    const updatedAt = toTimestamp(flow.updatedAt);

    if (
      score > bestScore ||
      (score === bestScore && updatedAt > bestUpdatedAt)
    ) {
      bestScore = score;
      bestFlow = flow;
      bestUpdatedAt = updatedAt;
    }
  }

  if (bestFlow) {
    return bestFlow;
  }

  const defaultFlows = flows
    .filter((flow) => normalizeTrigger(flow.trigger) === DEFAULT_TRIGGER)
    .sort((a, b) => toTimestamp(b.updatedAt) - toTimestamp(a.updatedAt));

  if (defaultFlows.length) {
    return defaultFlows[0];
  }

  return flows[0] ?? null;
};

const BROADCAST_SUCCESS_STATUSES = new Set(["Sent", "Delivered", "Read"]);
const BROADCAST_FAILURE_STATUSES = new Set(["Failed"]);

const WHATSAPP_STATUS_MAP: Record<string, string> = {
  sent: "Sent",
  delivered: "Delivered",
  read: "Read",
  failed: "Failed",
  undelivered: "Failed",
  deleted: "Failed",
  warning: "Warning",
  pending: "Pending",
  queued: "Pending",
};

type ContactIndexEntry = { name: string | null };

function mapWhatsappStatus(rawStatus?: string | null): string | null {
  if (!rawStatus) return null;
  const normalized = rawStatus.trim().toLowerCase();
  const mapped = WHATSAPP_STATUS_MAP[normalized];
  if (mapped) return mapped;
  const capitalized = rawStatus.trim();
  if (!capitalized) return null;
  return capitalized.charAt(0).toUpperCase() + capitalized.slice(1);
}

function extractStatusError(errors?: WAStatusError[] | null): string | null {
  if (!errors?.length) return null;
  const [first] = errors;
  if (!first) return null;

  const details =
    typeof first.error_data === "object" && first.error_data
      ? (first.error_data as { details?: string }).details
      : undefined;
  if (typeof details === "string" && details.trim()) {
    return details.trim();
  }

  if (typeof first.message === "string" && first.message.trim()) {
    return first.message.trim();
  }

  if (typeof first.title === "string" && first.title.trim()) {
    return first.title.trim();
  }

  if (typeof first.code === "string" || typeof first.code === "number") {
    return `Error code ${String(first.code)}`;
  }

  return null;
}

function parseStatusTimestamp(timestamp?: string | null): Date | null {
  if (!timestamp) return null;
  const numeric = Number(timestamp);
  if (Number.isFinite(numeric) && numeric > 0) {
    // WhatsApp timestamps are seconds
    return new Date(numeric * 1000);
  }
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function adjustBroadcastAggregates(
  broadcastId: string,
  previousStatus?: string | null,
  nextStatus?: string | null,
) {
  if (!nextStatus || previousStatus === nextStatus) {
    return;
  }

  const prevSuccess = previousStatus
    ? BROADCAST_SUCCESS_STATUSES.has(previousStatus)
    : false;
  const nextSuccess = BROADCAST_SUCCESS_STATUSES.has(nextStatus);
  const prevFailure = previousStatus
    ? BROADCAST_FAILURE_STATUSES.has(previousStatus)
    : false;
  const nextFailure = BROADCAST_FAILURE_STATUSES.has(nextStatus);

  let successDelta = 0;
  let failureDelta = 0;

  if (nextSuccess && !prevSuccess) {
    successDelta += 1;
  } else if (!nextSuccess && prevSuccess) {
    successDelta -= 1;
  }

  if (nextFailure && !prevFailure) {
    failureDelta += 1;
  } else if (!nextFailure && prevFailure) {
    failureDelta -= 1;
  }

  if (!successDelta && !failureDelta) {
    return;
  }

  const data: Prisma.BroadcastUpdateInput = {};

  if (successDelta > 0) {
    data.successCount = { increment: successDelta };
  } else if (successDelta < 0) {
    data.successCount = { decrement: Math.abs(successDelta) };
  }

  if (failureDelta > 0) {
    data.failureCount = { increment: failureDelta };
  } else if (failureDelta < 0) {
    data.failureCount = { decrement: Math.abs(failureDelta) };
  }

  try {
    await prisma.broadcast.update({ where: { id: broadcastId }, data });
  } catch (error) {
    console.error("Failed to update broadcast aggregates:", error);
  }
}

function indexWhatsappContacts(
  contacts?: WAContact[] | null,
): Map<string, ContactIndexEntry> {
  const map = new Map<string, ContactIndexEntry>();
  if (!Array.isArray(contacts)) {
    return map;
  }

  for (const contact of contacts) {
    const waId = typeof contact?.wa_id === "string" ? contact.wa_id.trim() : "";
    if (!waId) continue;

    const profileName =
      typeof contact?.profile?.name === "string"
        ? contact.profile.name.trim()
        : undefined;
    const fallbackName =
      typeof contact?.name === "string" ? contact.name.trim() : undefined;
    const name =
      profileName && profileName.length > 0
        ? profileName
        : fallbackName && fallbackName.length > 0
          ? fallbackName
          : null;

    map.set(waId, { name });
  }

  return map;
}

async function resolveUserForPhoneNumber(phoneNumberId: string) {
  const normalizedId = phoneNumberId.trim();

  if (!normalizedId) {
    return null;
  }

  const user = await prisma.user.findFirst({
    where: { metaPhoneNumberId: normalizedId },
  });

  return user ?? null;
}

const LOG_STATUS_MAP: Record<string, string> = {
  Active: "In Progress",
  Paused: "In Progress",
  Completed: "Completed",
  Errored: "Error",
};

async function recordSessionSnapshot(sessionId: string) {
  const sessionSnapshot = await prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      status: true,
      context: true,
      contactId: true,
      flowId: true,
    },
  });

  if (!sessionSnapshot) {
    return;
  }

  const logStatus =
    LOG_STATUS_MAP[sessionSnapshot.status] ??
    sessionSnapshot.status ??
    "In Progress";

  try {
    await prisma.log.create({
      data: {
        status: logStatus,
        context: sessionSnapshot.context ?? {},
        contactId: sessionSnapshot.contactId,
        flowId: sessionSnapshot.flowId,
      },
    });
  } catch (error) {
    console.error("Failed to persist session snapshot:", error);
  }
}

type ContactResolutionOptions = {
  name?: string | null;
  alternatePhones?: string[];
};

async function getOrCreateContactForUser(
  userId: string,
  phone: string,
  options: ContactResolutionOptions = {},
): Promise<Contact> {
  const trimmedPrimary = phone.trim();
  const normalizedPrimary = normalizePhone(trimmedPrimary) ?? trimmedPrimary;

  const searchPhones = new Set<string>();
  if (normalizedPrimary) {
    searchPhones.add(normalizedPrimary);
  }
  if (trimmedPrimary && trimmedPrimary !== normalizedPrimary) {
    searchPhones.add(trimmedPrimary);
  }

  for (const candidate of options.alternatePhones ?? []) {
    if (typeof candidate !== "string") continue;
    const trimmedCandidate = candidate.trim();
    if (!trimmedCandidate) continue;
    const normalizedCandidate =
      normalizePhone(trimmedCandidate) ?? trimmedCandidate;
    searchPhones.add(normalizedCandidate);
    if (normalizedCandidate !== trimmedCandidate) {
      searchPhones.add(trimmedCandidate);
    }
  }

  const searchList = Array.from(searchPhones).filter((value) => value.length);
  if (!searchList.length) {
    throw new Error("Unable to resolve contact phone number");
  }

  const canonicalPhone = normalizedPrimary || searchList[0];

  let contact = await prisma.contact.findFirst({
    where: {
      userId,
      OR: searchList.map((value) => ({ phone: value })),
    },
  });

  const normalizedName =
    typeof options.name === "string" && options.name.trim().length
      ? options.name.trim()
      : null;

  if (!contact) {
    try {
      contact = await prisma.contact.create({
        data: {
          userId,
          phone: canonicalPhone,
          ...(normalizedName ? { name: normalizedName } : {}),
        },
      });
    } catch (error) {
      if (isPrismaError(error, "P2002")) {
        contact = await prisma.contact.findFirst({
          where: {
            userId,
            OR: searchList.map((value) => ({ phone: value })),
          },
        });
      } else {
        throw error;
      }
    }
  }

  if (!contact) {
    throw new Error("Failed to resolve contact for user");
  }

  if (contact.phone !== canonicalPhone) {
    try {
      contact = await prisma.contact.update({
        where: { id: contact.id },
        data: { phone: canonicalPhone },
      });
    } catch (error) {
      console.error("Failed to normalize contact phone", contact.id, error);
    }
  }

  if (normalizedName && contact.name?.trim() !== normalizedName) {
    try {
      contact = await prisma.contact.update({
        where: { id: contact.id },
        data: { name: normalizedName },
      });
    } catch (error) {
      console.error("Failed to update contact name", contact.id, error);
    }
  }

  return contact;
}

async function ensureActiveSessionForFlow(
  contact: Contact,
  flow: Flow,
): Promise<SessionWithRelations> {
  let session = (await prisma.session.findUnique({
    where: { contactId_flowId: { contactId: contact.id, flowId: flow.id } },
    include: { flow: true, contact: true },
  })) as SessionWithRelations | null;

  if (!session) {
    session = (await prisma.session.create({
      data: { contactId: contact.id, flowId: flow.id, status: "Active" },
      include: { flow: true, contact: true },
    })) as SessionWithRelations;
    return session;
  }

  if (session.status === "Completed" || session.status === "Errored") {
    session = (await prisma.session.update({
      where: { id: session.id },
      data: { status: "Active", currentNodeId: null, context: {} },
      include: { flow: true, contact: true },
    })) as SessionWithRelations;
  } else if (!session.flow || !session.contact) {
    session = (await prisma.session.findUnique({
      where: { id: session.id },
      include: { flow: true, contact: true },
    })) as SessionWithRelations | null;

    if (!session) {
      session = (await prisma.session.create({
        data: { contactId: contact.id, flowId: flow.id, status: "Active" },
        include: { flow: true, contact: true },
      })) as SessionWithRelations;
    }
  }

  return session;
}

async function handleIncomingWhatsappMessage(
  userId: string,
  message: WAMessage,
  contactProfile: ContactIndexEntry | undefined,
) {
  const fromRaw = typeof message.from === "string" ? message.from : "";
  const from = fromRaw.trim();
  console.log(
    `Handling message ${message.id} from ${fromRaw || "unknown"} of type ${
      message.type
    }.`,
  );
  if (!from) {
    console.error("Received WhatsApp message without sender identifier.");
    return;
  }

  const interactiveTitle =
    message.interactive?.button_reply?.title ??
    message.interactive?.list_reply?.title ??
    null;
  const interactiveId =
    message.interactive?.button_reply?.id ??
    message.interactive?.list_reply?.id ??
    null;

  const textRaw = extractUserText(message);
  const fallbackText = interactiveTitle?.trim() ?? interactiveId?.trim() ?? null;

  if (!textRaw && !fallbackText) {
    console.log(
      `Ignoring message ${message.id} (no text could be extracted).`,
    );
    return;
  }

  const text = (textRaw ?? fallbackText ?? "").trim();
  if (!text) {
    console.log(`Ignoring message ${message.id} (resolved text is empty).`);
    return;
  }

  let contact: Contact;
  try {
    contact = await getOrCreateContactForUser(userId, from, {
      name: contactProfile?.name ?? null,
    });
  } catch (error) {
    console.error(`Failed to resolve contact for phone ${from}:`, error);
    return;
  }

  const existingSession = (await prisma.session.findFirst({
    where: {
      contactId: contact.id,
      status: { in: ["Active", "Paused"] },
    },
    include: { flow: true, contact: true },
    orderBy: { updatedAt: "desc" },
  })) as SessionWithRelations | null;

  let session: SessionWithRelations | null =
    existingSession && isWhatsappChannel(existingSession.flow?.channel ?? null)
      ? existingSession
      : null;

  let flow = session?.flow ?? null;

  if (flow && flow.status !== "Active") {
    session = null;
    flow = null;
  }

  if (!flow) {
    const availableFlowsRaw = await prisma.flow.findMany({
      where: { userId, status: "Active" },
      orderBy: { updatedAt: "desc" },
    });
    const availableFlows = availableFlowsRaw.filter((candidate: Flow) =>
      isWhatsappChannel(candidate.channel ?? null),
    );

    flow = findBestMatchingFlow(availableFlows, {
      fullText: text,
      interactiveTitle,
      interactiveId,
    });

    if (!flow) {
      console.error(
        `No active flow found for user ${userId} to handle message ${message.id}.`,
      );
      return;
    }
  }

  try {
    session = await ensureActiveSessionForFlow(contact, flow);
  } catch (error) {
    console.error(
      `Failed to create or resume session for contact ${contact.id}:`,
      error,
    );
    return;
  }

  if (!session) {
    console.error(
      `Session could not be resolved for contact ${contact.id}, skipping flow execution.`,
    );
    return;
  }

  const incomingMeta = {
    type: message.type ?? null,
    rawText: message.text?.body ?? textRaw ?? null,
    interactive: message.interactive
      ? {
          type: message.interactive.type ?? null,
          id:
            message.interactive.button_reply?.id ??
            message.interactive.list_reply?.id ??
            null,
          title:
            message.interactive.button_reply?.title ??
            message.interactive.list_reply?.title ??
            null,
        }
      : null,
    image: toRecordIfObject(message.image),
    video: toRecordIfObject(message.video),
    audio: toRecordIfObject(message.audio),
    document: toRecordIfObject(message.document),
    sticker: toRecordIfObject(message.sticker),
  };

  try {
    await executeFlow(
      session,
      text,
      (uid, to, payload) => sendMessage(uid, to, payload),
      incomingMeta,
    );
  } catch (error) {
    console.error(`Error executing flow for message ${message.id}:`, error);
    try {
      await prisma.session.update({
        where: { id: session.id },
        data: { status: "Errored" },
      });
    } catch (updateError) {
      console.error(
        `Failed to mark session ${session.id} as errored after execution failure:`,
        updateError,
      );
    }
  } finally {
    try {
      await recordSessionSnapshot(session.id);
    } catch (snapshotError) {
      console.error(
        `Failed to record session snapshot for ${session.id}:`,
        snapshotError,
      );
    }
  }
}

async function processBroadcastStatuses(userId: string, statuses: WAStatus[]) {
  for (const status of statuses) {
    if (!status) continue;

    const messageId =
      typeof status.id === "string" && status.id.trim().length > 0
        ? status.id.trim()
        : null;

    if (!messageId) continue;

    try {
      const recipient = await prisma.broadcastRecipient.findFirst({
        where: {
          messageId,
          broadcast: { userId },
        },
        select: { id: true, status: true, broadcastId: true },
      });

      if (!recipient) {
        continue;
      }

      const nextStatus = mapWhatsappStatus(status.status ?? null);
      const statusTimestamp = parseStatusTimestamp(status.timestamp ?? null);
      const conversationId =
        typeof status.conversation?.id === "string" &&
        status.conversation.id.trim().length > 0
          ? status.conversation.id.trim()
          : null;

      const updateData: Prisma.BroadcastRecipientUpdateInput = {
        statusUpdatedAt: statusTimestamp ?? new Date(),
      };

      if (nextStatus) {
        updateData.status = nextStatus;
        if (!BROADCAST_FAILURE_STATUSES.has(nextStatus)) {
          updateData.error = null;
        }
      }

      if (conversationId) {
        updateData.conversationId = conversationId;
      }

      if (BROADCAST_FAILURE_STATUSES.has(nextStatus ?? "")) {
        const errorMessage =
          extractStatusError(status.errors ?? null) ??
          "Meta reported delivery failure";
        updateData.error = errorMessage;
      }

      await prisma.broadcastRecipient.update({
        where: { id: recipient.id },
        data: updateData,
      });

      await adjustBroadcastAggregates(
        recipient.broadcastId,
        recipient.status,
        nextStatus,
      );
    } catch (error) {
      console.error(
        "Failed to process broadcast status update for message:",
        messageId,
        error,
      );
    }
  }
}

/**
 * Extrae un texto legible del mensaje entrante para usarlo en el matching de flujos.
 * Prioriza el contenido explícito (cuerpo del texto, caption de media, título de interactivo).
 * Para media sin texto, devuelve un placeholder como `[image]` o el nombre del archivo.
 */
function extractUserText(msg: WAMessage): string | null {
  if (!msg) return null;

  switch (msg.type) {
    case "text":
      return msg.text?.body?.trim() || null;

    case "interactive": {
      const buttonTitle = msg.interactive?.button_reply?.title?.trim();
      if (buttonTitle) {
        return buttonTitle;
      }

      const listTitle = msg.interactive?.list_reply?.title?.trim();
      if (listTitle) {
        return listTitle;
      }

      const fallbackId =
        msg.interactive?.button_reply?.id?.trim() ??
        msg.interactive?.list_reply?.id?.trim() ??
        null;

      return fallbackId;
    }

    case "image":
      return msg.image?.caption || "[image]";

    case "video":
      return msg.video?.caption || "[video]";

    case "audio":
      return "[audio]";

    case "document":
      return msg.document?.caption || msg.document?.filename || "[document]";

    case "sticker":
      return "[sticker]";

    case "unknown":
      console.warn("Received a message of unknown type:", msg);
      return "[unknown_message]";

    default:
      // Si el tipo no es uno de los anteriores, es posible que sea un tipo
      // nuevo o no manejado. Devolvemos null para que sea ignorado por defecto.
      console.warn(`Received message with unhandled type: "${msg.type}".`, msg);
      return null;
  }
}

/* ====== Procesador de Webhook ====== */
const extractWebhookChangeValues = (
  payload: MetaWebhookPayload,
): WAChangeValue[] => {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const changeValues: WAChangeValue[] = [];

  const entries =
    "entry" in payload && Array.isArray(payload.entry) ? payload.entry : null;

  if (entries?.length) {
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const changes = Array.isArray(entry.changes) ? entry.changes : [];
      for (const change of changes) {
        const value = change?.value;
        if (value && typeof value === "object") {
          changeValues.push(value as WAChangeValue);
        }
      }
    }

    return changeValues;
  }

  const standaloneValue =
    "value" in payload && payload.value && typeof payload.value === "object"
      ? payload.value
      : null;

  if (standaloneValue) {
    changeValues.push(standaloneValue as WAChangeValue);
  }

  return changeValues;
};

export async function processWebhookEvent(data: MetaWebhookPayload) {
  if (process.env.NODE_ENV === "development") {
    console.log("Received webhook event:", JSON.stringify(data, null, 2));
  } else {
    console.log("Received webhook event.");
  }

  const changeValues = extractWebhookChangeValues(data);

  if (!changeValues.length) {
    console.warn("Received webhook event without changes to process.");
    return;
  }

  for (const val of changeValues) {
    const phoneNumberId = val?.metadata?.phone_number_id;
    if (!phoneNumberId) continue;

    // Resolvemos el “owner” del número
    const user = await resolveUserForPhoneNumber(phoneNumberId);
    if (!user) {
      console.error("User not found for phone number ID:", phoneNumberId);
      continue;
    }

    const statuses = Array.isArray(val?.statuses) ? val.statuses : [];
    if (statuses.length) {
      await processBroadcastStatuses(user.id, statuses);
    }

    const messages = Array.isArray(val?.messages) ? val.messages : [];
    if (!messages.length) continue;

    const contactIndex = indexWhatsappContacts(val?.contacts);

    // Procesamos cada mensaje (Meta puede agruparlos)
    for (const msg of messages) {
      try {
        const profile = msg.from ? contactIndex.get(msg.from) : undefined;
        await handleIncomingWhatsappMessage(user.id, msg, profile);
      } catch (error) {
        console.error(`Unhandled error processing message ${msg.id}:`, error);
      }
    }
  }
}

export async function processManualFlowTrigger(
  options: ManualFlowTriggerOptions,
): Promise<ManualFlowTriggerResult> {
  const { flowId } = options;
  const rawPhone = options.from?.trim() ?? "";
  const normalizedPhone = normalizePhone(rawPhone);

  if (!normalizedPhone) {
    return {
      success: false,
      status: 400,
      error: rawPhone.length
        ? "Invalid contact phone number"
        : "Missing contact phone number",
    };
  }

  const flow = await prisma.flow.findUnique({
    where: { id: flowId },
    include: { user: true },
  });

  if (!flow) {
    return { success: false, status: 404, error: "Flow not found" };
  }

  if (!isWhatsappChannel(flow.channel ?? null)) {
    return {
      success: false,
      status: 409,
      error: "Flow is not configured for WhatsApp",
    };
  }

  if (flow.status !== "Active") {
    return { success: false, status: 409, error: "Flow is not active" };
  }

  const trimmedMessage = options.message?.trim();
  const incomingRawText =
    typeof options.incomingMeta?.rawText === "string"
      ? options.incomingMeta.rawText.trim()
      : null;
  const interactiveTitle =
    typeof options.incomingMeta?.interactive?.title === "string"
      ? options.incomingMeta.interactive.title.trim()
      : null;
  const interactiveId =
    typeof options.incomingMeta?.interactive?.id === "string"
      ? options.incomingMeta.interactive.id.trim()
      : null;

  const candidateMessage =
    trimmedMessage && trimmedMessage.length > 0
      ? trimmedMessage
      : incomingRawText && incomingRawText.length > 0
        ? incomingRawText
        : interactiveTitle && interactiveTitle.length > 0
          ? interactiveTitle
          : interactiveId && interactiveId.length > 0
            ? interactiveId
            : null;

  if (!candidateMessage) {
    return { success: false, status: 400, error: "Message text is required" };
  }

  let contact: Contact;
  try {
    const alternates =
      rawPhone && rawPhone !== normalizedPhone ? [rawPhone] : [];
    contact = await getOrCreateContactForUser(flow.userId, normalizedPhone, {
      alternatePhones: alternates,
      name: options.name ?? null,
    });
  } catch (error) {
    console.error(
      `Failed to resolve contact for manual trigger on flow ${flow.id}:`,
      error,
    );
    return {
      success: false,
      status: 500,
      error: "Failed to resolve contact",
    };
  }

  let session: SessionWithRelations | null = null;
  try {
    session = await ensureActiveSessionForFlow(contact, flow);
  } catch (error) {
    console.error(
      `Failed to initialise session for contact ${contact.id} on flow ${flow.id}:`,
      error,
    );
    return {
      success: false,
      status: 500,
      error: "Unable to initialise session",
    };
  }

  if (!session) {
    return {
      success: false,
      status: 500,
      error: "Unable to initialise session",
    };
  }

  let activeSession: SessionWithRelations = session;

  const variables = options.variables;
  if (variables && Object.keys(variables).length > 0) {
    const currentContext =
      (activeSession.context as Record<string, unknown> | null) ?? {};
    const nextContext = {
      ...currentContext,
      ...variables,
    } as Prisma.JsonObject;
    activeSession = (await prisma.session.update({
      where: { id: activeSession.id },
      data: { context: nextContext },
      include: { flow: true, contact: true },
    })) as SessionWithRelations;
  }

  const incomingMeta =
    options.incomingMeta ??
    ({
      type: "text",
      rawText: candidateMessage,
      interactive: null,
    } as ManualFlowTriggerOptions["incomingMeta"]);

  try {
    await executeFlow(
      activeSession,
      candidateMessage,
      (uid, to, payload) => sendMessage(uid, to, payload),
      incomingMeta,
    );

    return {
      success: true,
      flowId: flow.id,
      contactId: contact.id,
      sessionId: activeSession.id,
    };
  } catch (error) {
    console.error("Manual flow trigger execution failed:", error);
    try {
      await prisma.session.update({
        where: { id: activeSession.id },
        data: { status: "Errored" },
      });
    } catch (updateError) {
      console.error("Failed to mark session as errored:", updateError);
    }
    const statusCode =
      error instanceof FlowSendMessageError && error.status
        ? error.status
        : 500;
    const errorMessage =
      error instanceof FlowSendMessageError && error.message
        ? error.message
        : "Failed to execute flow";
    return { success: false, status: statusCode, error: errorMessage };
  } finally {
    try {
      await recordSessionSnapshot(activeSession.id);
    } catch (snapshotError) {
      console.error("Failed to record manual session snapshot:", snapshotError);
    }
  }
}

/* ===== Envío de mensajes a WhatsApp (Graph API) ===== */
type SendMessagePayload =
  | { type: "text"; text: string }
  | {
      type: "media";
      mediaType: "image" | "video" | "audio" | "document";
      id?: string;
      url?: string;
      caption?: string;
    }
  | { type: "options"; text: string; options: string[] }
  | {
      type: "list";
      text: string;
      button: string;
      sections: Array<{
        title: string;
        rows: Array<{ id: string; title: string }>;
      }>;
    }
  | {
      type: "flow";
      flow: {
        name?: string | null;
        id: string;
        token: string;
        version?: string | null;
        header?: string | null;
        body: string;
        footer?: string | null;
        cta?: string | null;
      };
    }
  | {
      type: "template";
      template: {
        name: string;
        language: string;
        components?: Array<{
          type: string;
          subType?: string | null;
          index?: number | null;
          parameters?: Array<{ type: "text"; text: string }>;
        }>;
      };
    };

export type SendMessageResult =
  | { success: true; messageId?: string | null; conversationId?: string | null }
  | {
      success: false;
      error?: string;
      status?: number;
      details?: unknown;
    };

export const GRAPH_VERSION = "v23.0";
export const META_API_TIMEOUT_MS = 15000;

type SendMessageOptions = {
  allowListAttempted?: boolean;
};

type MetaErrorPayload = {
  error?: {
    message?: string;
    error_user_msg?: string;
    code?: number;
    error_subcode?: number;
  };
};

type AllowListResult =
  | { success: true; details?: unknown }
  | { success: false; status?: number; error?: string; details?: unknown };

const RECIPIENT_NOT_ALLOWED_ERROR_CODE = 131030;

async function addRecipientToAllowList(
  accessToken: string,
  phoneNumberId: string,
  recipientPhone: string,
): Promise<AllowListResult> {
  const candidatePaths = ["recipients", "registered_whatsapp_users"] as const;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), META_API_TIMEOUT_MS);

  try {
    let lastError: AllowListResult | null = null;

    for (const path of candidatePaths) {
      const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/${path}`;

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: recipientPhone,
          }),
          signal: controller.signal,
        });

        const raw = await response.text().catch(() => "");
        let json: unknown;

        if (raw) {
          try {
            json = JSON.parse(raw);
          } catch {
            json = undefined;
          }
        }

        if (!response.ok) {
          const payload = json as MetaErrorPayload | undefined;
          const message =
            payload?.error?.error_user_msg?.trim() ||
            payload?.error?.message?.trim() ||
            raw ||
            response.statusText ||
            "Failed to add phone number to WhatsApp test allow list";

          console.error(
            "Failed to add phone number to WhatsApp allow list:",
            response.status,
            message,
          );

          const normalizedMessage =
            typeof message === "string" ? message.toLowerCase() : "";
          const isFallbackCandidate =
            (response.status === 400 || response.status === 404) &&
            (normalizedMessage.includes("unknown path components") ||
              normalizedMessage.includes("unsupported post request"));

          if (isFallbackCandidate) {
            console.warn(
              `Meta rejected allow list endpoint "${path}". Trying alternative endpoint...`,
            );
            lastError = {
              success: false,
              status: response.status,
              error: message,
              details: payload ?? json ?? raw,
            };
            continue;
          }

          return {
            success: false,
            status: response.status,
            error: message,
            details: payload ?? json ?? raw,
          };
        }

        console.info(
          "Successfully added phone number to WhatsApp allow list:",
          recipientPhone,
        );

        return { success: true, details: json ?? raw };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw error;
        }

        console.error(
          "Unexpected error while calling Meta allow list endpoint:",
          path,
          error,
        );
        lastError = {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Unknown error while registering recipient",
        };
      }
    }

    return (
      lastError ?? {
        success: false,
        error: "Meta did not accept any allow list endpoints",
      }
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.error(
        "Timed out while adding phone number to WhatsApp allow list",
        recipientPhone,
      );
      return {
        success: false,
        error: "Request to Meta timed out while registering the recipient",
      };
    }

    console.error(
      "Unexpected error while adding phone number to WhatsApp allow list:",
      recipientPhone,
      error,
    );
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Unknown error while registering recipient",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendMessage(
  userId: string,
  to: string,
  message: SendMessagePayload,
  options: SendMessageOptions = {},
): Promise<SendMessageResult> {
  const { allowListAttempted = false } = options;
  const normalizedTo = normalizePhone(to);

  if (!normalizedTo) {
    const errorMessage = "Invalid destination phone number";
    console.error(errorMessage, "for user:", userId, "value:", to);
    return { success: false, status: 400, error: errorMessage };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { metaAccessToken: true, metaPhoneNumberId: true },
  });

  const accessToken = user?.metaAccessToken?.trim() ?? null;
  const phoneNumberId = user?.metaPhoneNumberId?.trim() ?? null;

  if (!accessToken || !phoneNumberId) {
    const errorMessage = "Missing Meta API credentials";
    console.error(errorMessage, "for user:", userId);
    return { success: false, error: errorMessage };
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };

  // Construcción del cuerpo según tipo
  let body: Record<string, unknown> | undefined;
  switch (message.type) {
    case "text":
      body = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: normalizedTo,
        type: "text",
        text: { body: message.text, preview_url: false },
      };
      break;

    case "media": {
      if (!message.id && !message.url) {
        return {
          success: false,
          status: 400,
          error: "Media message must have either an id or a url",
        };
      }

      const allowed: Record<string, true> = {
        image: true,
        video: true,
        audio: true,
        document: true,
      };
      const mType = allowed[message.mediaType] ? message.mediaType : "image";

      const mediaObject: { id?: string; link?: string; caption?: string } = {};
      if (message.id) {
        mediaObject.id = message.id;
      } else if (message.url) {
        mediaObject.link = message.url;
      }

      if (message.caption) {
        mediaObject.caption = message.caption;
      }

      body = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: normalizedTo,
        type: mType,
        [mType]: mediaObject,
      };
      break;
    }

    case "list": {
      const sections = (message.sections || []).map((section) => ({
        title: section.title,
        rows: (section.rows || []).map((row) => ({
          id: row.id,
          title: row.title,
        })),
      }));

      body = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: normalizedTo,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: message.text },
          action: {
            button: message.button,
            sections,
          },
        },
      };
      break;
    }

    case "options": {
      // WhatsApp limita a 3 botones. Recortamos si es necesario.
      const opts = (message.options || []).slice(0, 3);
      body = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: normalizedTo,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: message.text },
          action: {
            buttons: opts.map((opt) => ({
              type: "reply",
              reply: {
                id: toLcTrim(opt).replace(/\s+/g, "_") || "opt",
                title: opt,
              },
            })),
          },
        },
      };
      break;
    }

    case "flow": {
      const flow = message.flow;
      const flowId = flow?.id?.trim();
      const flowToken = flow?.token?.trim();
      if (!flowId || !flowToken) {
        return {
          success: false,
          status: 400,
          error: "Missing WhatsApp Flow identifiers",
        };
      }

      const flowName = flow?.name?.trim() || "whatsapp_flow";
      const flowVersion = flow?.version?.trim();
      const header = flow?.header?.trim();
      const footer = flow?.footer?.trim();
      const bodyText = (flow?.body ?? "").trim();
      const cta = flow?.cta?.trim();

      const interactive: Record<string, unknown> = {
        type: "flow",
        flow: {
          name: flowName,
          id: flowId,
          token: flowToken,
          ...(flowVersion ? { version: flowVersion } : {}),
        },
      };

      if (header) {
        interactive.header = { type: "text", text: header };
      }
      if (bodyText) {
        interactive.body = { text: bodyText };
      }
      if (footer) {
        interactive.footer = { text: footer };
      }
      if (cta) {
        (interactive.flow as Record<string, unknown>).flow_cta = cta;
      }

      body = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: normalizedTo,
        type: "interactive",
        interactive,
      };
      break;
    }

    case "template": {
      const template = message.template;
      const templateName = template?.name?.trim();
      const templateLanguage = template?.language?.trim();
      if (!templateName || !templateLanguage) {
        return {
          success: false,
          status: 400,
          error: "Missing template name or language",
        };
      }

      const components = Array.isArray(template?.components)
        ? template.components
        : [];

      const normalizedComponents = components
        .map((component) => {
          const type = (component?.type ?? "").toString().trim().toLowerCase();
          if (!type) return null;

          const normalized: Record<string, unknown> = { type };

          const subType = (component?.subType ?? "")?.toString().trim();
          if (subType) {
            normalized.sub_type = subType.toLowerCase();
          }

          if (
            typeof component?.index === "number" &&
            Number.isFinite(component.index)
          ) {
            normalized.index = component.index;
          }

          const parameters = Array.isArray(component?.parameters)
            ? component.parameters
                .map((parameter) => {
                  if (!parameter || parameter.type !== "text") return null;
                  const textValue =
                    typeof parameter.text === "string" ? parameter.text : "";
                  return { type: "text", text: textValue };
                })
                .filter(
                  (entry): entry is { type: "text"; text: string } =>
                    entry !== null,
                )
            : [];

          if (parameters.length) {
            normalized.parameters = parameters;
          }

          return normalized;
        })
        .filter(
          (component): component is Record<string, unknown> =>
            component !== null,
        );

      const templatePayload: Record<string, unknown> = {
        name: templateName,
        language: { code: templateLanguage },
      };

      if (normalizedComponents.length) {
        templatePayload.components = normalizedComponents;
      }

      body = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: normalizedTo,
        type: "template",
        template: templatePayload,
      };
      break;
    }
  }

  // Llamada con timeout/abort
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), META_API_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body ?? {}),
      signal: ctrl.signal,
    });

    const raw = await res.text().catch(() => "");
    let json: unknown;

    if (raw) {
      try {
        json = JSON.parse(raw);
      } catch {
        json = undefined;
      }
    }

    if (!res.ok) {
      const errorPayload = json as MetaErrorPayload | undefined;
      const graphMessage =
        errorPayload?.error?.error_user_msg ?? errorPayload?.error?.message;
      const fallback = raw || res.statusText || "Meta API request failed";
      const errorMessage = graphMessage?.trim().length
        ? graphMessage
        : fallback;

      const lowerMessage = errorMessage?.toLowerCase() ?? "";
      const isAccessTokenError =
        res.status === 401 ||
        ((res.status === 400 || res.status === 403) &&
          (lowerMessage.includes("access token") ||
            lowerMessage.includes("session has expired")));

      const normalizedError = isAccessTokenError
        ? "Meta access token expired. Please reconnect WhatsApp in Settings."
        : errorMessage;

      const errorCode =
        typeof errorPayload?.error?.code === "number"
          ? errorPayload.error.code
          : null;

      if (
        res.status === 400 &&
        errorCode === RECIPIENT_NOT_ALLOWED_ERROR_CODE &&
        !allowListAttempted
      ) {
        console.warn(
          "Recipient phone number not in WhatsApp allow list. Attempting automatic registration.",
          normalizedTo,
        );

        const allowListResult = await addRecipientToAllowList(
          accessToken,
          phoneNumberId,
          normalizedTo,
        );

        if (allowListResult.success) {
          return sendMessage(userId, normalizedTo, message, {
            ...options,
            allowListAttempted: true,
          });
        }

        const registrationError =
          allowListResult.error ??
          "Meta rejected the number because it is not in the WhatsApp test allow list. Please add it manually from the Meta Developer Dashboard.";

        return {
          success: false,
          status: allowListResult.status ?? res.status,
          error: registrationError,
          details: {
            originalError: errorPayload,
            allowListAttempt: allowListResult.details ?? null,
          },
        };
      }

      console.error("Error sending message:", res.status, errorMessage);
      return {
        success: false,
        status: res.status,
        error: normalizedError,
        details: json,
      };
    }

    const response = json as
      | {
          messages?: Array<{ id?: string }>;
          contacts?: Array<{ wa_id?: string }>;
        }
      | undefined;
    const messageId =
      response?.messages?.find((m) => typeof m?.id === "string")?.id ?? null;

    return { success: true, messageId };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.error("Error sending message: request timeout");
      return { success: false, error: "Request to Meta timed out" };
    }
    console.error("Error sending message:", error);
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Unknown error while sending message",
    };
  } finally {
    clearTimeout(t);
  }
}
