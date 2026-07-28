import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { HermesBridgeConfig } from "./config.js";
import { executeHermesBridgeTask } from "./executor.js";
import {
  hashHermesBridgeRequest,
  MemoryHermesBridgeIdempotencyStore,
  type HermesBridgeIdempotencyStore,
} from "./idempotency-store.js";
import { createHermesBridgeResult, normalizeHermesBridgeRequest } from "./schema.js";
import type { HermesBridgeResult } from "./types.js";

type HandlerParams = {
  resolveConfig: () => HermesBridgeConfig;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  idempotencyStore?: HermesBridgeIdempotencyStore;
  resolveIdempotencyStore?: () => HermesBridgeIdempotencyStore;
  subagent?: PluginRuntime["subagent"];
  executeTask?: typeof executeHermesBridgeTask;
};

function getHeader(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return raw;
}

function writeJson(res: ServerResponse, statusCode: number, payload: HermesBridgeResult): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function statusCodeForResult(result: HermesBridgeResult): number {
  if (result.ok) {
    return 200;
  }
  if (result.error?.type === "cleanup_store_unavailable") {
    return 503;
  }
  return result.status === "needs_confirmation" || result.status === "running" ? 409 : 404;
}

function isRetryableExecutionResult(result: HermesBridgeResult): boolean {
  return (
    result.status === "running" &&
    (result.error?.type === "cleanup_in_progress" ||
      result.error?.type === "cleanup_store_unavailable")
  );
}

function errorResult(params: {
  status: HermesBridgeResult["status"];
  type: string;
  message: string;
}): HermesBridgeResult {
  return createHermesBridgeResult({
    ok: false,
    mode: "mock",
    status: params.status,
    summary: params.message,
    error: {
      type: params.type,
      message: params.message,
    },
  });
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (Buffer.byteLength(body, "utf8") > maxBytes) {
      throw new Error("request_too_large");
    }
  }
  return body;
}

export function createHermesBridgeHttpHandler(params: HandlerParams) {
  const fallbackIdempotencyStore =
    params.idempotencyStore ?? new MemoryHermesBridgeIdempotencyStore();
  const inFlightRequests = new Map<
    string,
    {
      requestHash: string;
      finalized: Promise<{ result: HermesBridgeResult; statusCode: number }>;
    }
  >();
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const config = params.resolveConfig();
    if (!config.enabled) {
      writeJson(
        res,
        404,
        errorResult({
          status: "blocked",
          type: "disabled",
          message: "Hermes bridge is disabled.",
        }),
      );
      return true;
    }
    if (req.method !== "POST") {
      writeJson(
        res,
        405,
        errorResult({
          status: "blocked",
          type: "method_not_allowed",
          message: "Hermes bridge accepts POST requests only.",
        }),
      );
      return true;
    }

    const expectedToken = params.env?.[config.sharedSecretEnv];
    if (!expectedToken) {
      writeJson(
        res,
        503,
        errorResult({
          status: "failed",
          type: "missing_secret",
          message: `Hermes bridge token env var is not configured: ${config.sharedSecretEnv}`,
        }),
      );
      return true;
    }
    if (getHeader(req, "x-openclaw-hermes-token") !== expectedToken) {
      writeJson(
        res,
        401,
        errorResult({
          status: "blocked",
          type: "invalid_token",
          message: "Invalid Hermes bridge token.",
        }),
      );
      return true;
    }

    let parsed: unknown;
    try {
      const body = await readBody(req, config.maxRequestBytes);
      parsed = JSON.parse(body || "{}");
    } catch (error) {
      const type =
        error instanceof Error && error.message === "request_too_large"
          ? "request_too_large"
          : "invalid_json";
      writeJson(
        res,
        type === "request_too_large" ? 413 : 400,
        errorResult({
          status: "blocked",
          type,
          message:
            type === "request_too_large"
              ? "Hermes bridge request body is too large."
              : "Hermes bridge request body must be valid JSON.",
        }),
      );
      return true;
    }

    const normalized = normalizeHermesBridgeRequest(parsed);
    if (!normalized.ok) {
      writeJson(
        res,
        400,
        errorResult({
          status: "failed",
          type: normalized.error.type,
          message: normalized.error.message,
        }),
      );
      return true;
    }
    const request = normalized.request;
    const requestHash = hashHermesBridgeRequest(request);
    const claimOwnerId = request.idempotencyKey ? randomUUID() : undefined;
    let recoveredLease = false;
    let idempotencyStore: HermesBridgeIdempotencyStore | undefined;
    if (request.idempotencyKey) {
      try {
        idempotencyStore =
          params.idempotencyStore ?? params.resolveIdempotencyStore?.() ?? fallbackIdempotencyStore;
      } catch (error) {
        writeJson(
          res,
          503,
          createHermesBridgeResult({
            ok: false,
            request,
            mode: "mock",
            status: "failed",
            summary: "Hermes bridge idempotency store is temporarily unavailable.",
            error: {
              type: "idempotency_store_unavailable",
              message:
                error instanceof Error
                  ? error.message
                  : "Hermes bridge idempotency store is temporarily unavailable.",
            },
          }),
        );
        return true;
      }
      let claim;
      try {
        claim = idempotencyStore.claim(request.idempotencyKey, requestHash, {
          ownerId: claimOwnerId!,
          leaseMs: Math.max(config.maxLiveRuntimeSeconds * 1_000 + 90_000, 180_000),
        });
      } catch (error) {
        writeJson(
          res,
          503,
          createHermesBridgeResult({
            ok: false,
            request,
            mode: "mock",
            status: "failed",
            summary: "Hermes bridge idempotency store is temporarily unavailable.",
            error: {
              type: "idempotency_store_unavailable",
              message:
                error instanceof Error
                  ? error.message
                  : "Hermes bridge idempotency store is temporarily unavailable.",
            },
          }),
        );
        return true;
      }
      if (claim.status === "completed") {
        writeJson(res, statusCodeForResult(claim.entry.result), claim.entry.result);
        return true;
      }
      if (claim.status === "conflict") {
        writeJson(
          res,
          409,
          createHermesBridgeResult({
            ok: false,
            request,
            mode: "mock",
            status: "blocked",
            summary: "Idempotency key was already used for a different request.",
            error: {
              type: "idempotency_conflict",
              message: "Idempotency key was already used for a different request.",
            },
          }),
        );
        return true;
      }
      if (claim.status === "pending") {
        const inFlight = inFlightRequests.get(request.idempotencyKey);
        if (!inFlight || inFlight.requestHash !== requestHash) {
          writeJson(
            res,
            409,
            createHermesBridgeResult({
              ok: false,
              request,
              mode: "mock",
              status: "blocked",
              summary: "The idempotent request is already executing in another Gateway process.",
              error: {
                type: "idempotency_in_progress",
                message:
                  "The idempotent request is already executing; retry to replay its completed result.",
              },
            }),
          );
          return true;
        }
        const finalized = await inFlight.finalized;
        writeJson(res, finalized.statusCode, finalized.result);
        return true;
      }
      recoveredLease = claim.recovered;
    }

    const execute = async (): Promise<HermesBridgeResult> => {
      try {
        return await (params.executeTask ?? executeHermesBridgeTask)({
          config,
          request,
          subagent: params.subagent,
          recoveredLease,
          cleanupStore: idempotencyStore,
        });
      } catch (error) {
        return createHermesBridgeResult({
          ok: false,
          request,
          mode: "live",
          status: "failed",
          summary: error instanceof Error ? error.message : "Hermes bridge execution failed.",
          error: {
            type: "task_execution_failed",
            message: error instanceof Error ? error.message : "Hermes bridge execution failed.",
          },
        });
      }
    };
    if (!request.idempotencyKey) {
      const result = await execute();
      writeJson(res, statusCodeForResult(result), result);
      return true;
    }

    let resolveFinalized:
      | ((response: { result: HermesBridgeResult; statusCode: number }) => void)
      | undefined;
    const finalized = new Promise<{
      result: HermesBridgeResult;
      statusCode: number;
    }>((resolve) => {
      resolveFinalized = resolve;
    });
    inFlightRequests.set(request.idempotencyKey, {
      requestHash,
      finalized,
    });
    void (async () => {
      const result = await execute();
      try {
        if (isRetryableExecutionResult(result)) {
          idempotencyStore!.release(request.idempotencyKey!, requestHash, claimOwnerId!);
        } else {
          idempotencyStore!.set(request.idempotencyKey!, { requestHash, result }, claimOwnerId);
        }
        resolveFinalized?.({ result, statusCode: statusCodeForResult(result) });
      } catch (error) {
        const persistenceFailure = createHermesBridgeResult({
          ok: false,
          request,
          mode: result.mode,
          status: "failed",
          summary: "Hermes bridge could not persist the idempotent result.",
          error: {
            type: "idempotency_persistence_failed",
            message:
              error instanceof Error
                ? error.message
                : "Hermes bridge could not persist the idempotent result.",
          },
        });
        resolveFinalized?.({
          result: persistenceFailure,
          statusCode: 503,
        });
      }
    })();
    try {
      const response = await finalized;
      writeJson(res, response.statusCode, response.result);
      return true;
    } finally {
      const current = inFlightRequests.get(request.idempotencyKey);
      if (current?.finalized === finalized) {
        inFlightRequests.delete(request.idempotencyKey);
      }
    }
  };
}
