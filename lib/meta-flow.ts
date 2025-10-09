import type { Prisma } from "@prisma/client";

import prisma from "./prisma";
import { GRAPH_VERSION, META_API_TIMEOUT_MS } from "./meta";

export type MetaFlowIdentifiers = {
  id: string;
  token: string | null;
  version: string | null;
  revisionId: string | null;
  status: string | null;
  raw: unknown;
};

export class MetaFlowError extends Error {
  status?: number;
  details?: unknown;

  constructor(
    message: string,
    options?: { status?: number; details?: unknown },
  ) {
    super(message);
    this.name = "MetaFlowError";
    if (options?.status) {
      this.status = options.status;
    }
    if (options?.details !== undefined) {
      this.details = options.details;
    }
  }
}

type MetaCredentials = { accessToken: string; wabaId: string };

type FlowPayload = {
  name: string;
  definition: Prisma.JsonValue | null | undefined;
  status?: string | null;
};

type RequestResult = { json: unknown };

const ensureCredentials = async (userId: string): Promise<MetaCredentials> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      metaAccessToken: true,
      metaBusinessAccountId: true,
    },
  });

  const accessToken = user?.metaAccessToken?.trim() ?? "";
  const wabaId = user?.metaBusinessAccountId?.trim() ?? "";

  if (!accessToken || !wabaId) {
    throw new MetaFlowError(
      "Missing Meta credentials. Configure Access Token and Business Account ID in Settings.",
      { status: 400 },
    );
  }

  return { accessToken, wabaId };
};

const normalizeStatus = (status?: string | null): string | undefined => {
  if (!status) return undefined;
  const normalized = status.trim().toUpperCase();
  if (!normalized) return undefined;
  return normalized;
};

const buildRequestBody = (payload: FlowPayload) => {
  const definition =
    payload.definition && typeof payload.definition === "object"
      ? payload.definition
      : {};

  return {
    name: payload.name,
    flow_json: definition,
    status: normalizeStatus(payload.status),
  };
};

const performRequest = async (
  credentials: MetaCredentials,
  method: "POST" | "PUT" | "DELETE",
  body: Record<string, unknown>,
): Promise<RequestResult> => {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${credentials.wabaId}/flows`;
  const headers = {
    Authorization: `Bearer ${credentials.accessToken}`,
    "Content-Type": "application/json",
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), META_API_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const raw = await response.text();
    let json: unknown;
    if (raw) {
      try {
        json = JSON.parse(raw);
      } catch {
        json = raw;
      }
    }

    if (!response.ok) {
      const graphMessage =
        typeof json === "object" && json !== null && "error" in json
          ? ((json as { error?: { message?: string; error_user_msg?: string } })
              .error?.error_user_msg ??
            (json as { error?: { message?: string } }).error?.message)
          : undefined;
      const message =
        (typeof graphMessage === "string" && graphMessage.trim()) ||
        response.statusText ||
        "Meta Flow API request failed";

      throw new MetaFlowError(message, {
        status: response.status,
        details: json,
      });
    }

    return { json };
  } catch (error) {
    if (error instanceof MetaFlowError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new MetaFlowError("Meta Flow API request timed out", {
        status: 504,
      });
    }
    throw new MetaFlowError("Meta Flow API request failed", { details: error });
  } finally {
    clearTimeout(timeout);
  }
};

const toIdentifiers = (payload: unknown): MetaFlowIdentifiers => {
  const source =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};

  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
    return null;
  };

  const id = pick("id", "flow_id");
  if (!id) {
    throw new MetaFlowError("Meta Flow response missing id", {
      status: 502,
      details: payload,
    });
  }

  return {
    id,
    token: pick("token", "flow_token"),
    version: pick("version", "flow_version"),
    revisionId: pick("revision_id", "flow_revision_id"),
    status: pick("status", "flow_status"),
    raw: payload,
  };
};

export const createMetaFlow = async (
  userId: string,
  payload: FlowPayload,
): Promise<MetaFlowIdentifiers> => {
  const credentials = await ensureCredentials(userId);
  const body = buildRequestBody(payload);
  const result = await performRequest(credentials, "POST", body);
  return toIdentifiers(result.json);
};

export const updateMetaFlow = async (
  userId: string,
  flowId: string,
  payload: FlowPayload,
): Promise<MetaFlowIdentifiers> => {
  if (!flowId?.trim()) {
    throw new MetaFlowError("Missing remote flow id for update", {
      status: 400,
    });
  }
  const credentials = await ensureCredentials(userId);
  const body = { ...buildRequestBody(payload), id: flowId };
  const result = await performRequest(credentials, "PUT", body);
  return toIdentifiers(result.json);
};

export const deleteMetaFlow = async (
  userId: string,
  flowId: string,
): Promise<void> => {
  if (!flowId?.trim()) {
    throw new MetaFlowError("Missing remote flow id for delete", {
      status: 400,
    });
  }
  const credentials = await ensureCredentials(userId);
  await performRequest(credentials, "DELETE", { id: flowId });
};
