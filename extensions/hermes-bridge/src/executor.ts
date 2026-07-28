import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { HermesBridgeConfig, HermesBridgeMode } from "./config.js";
import {
  HermesBridgeCleanupPendingError,
  HermesBridgeCleanupStoreUnavailableError,
  type HermesBridgeIdempotencyStore,
} from "./idempotency-store.js";
import { createAuditEvent, createHermesBridgeResult } from "./schema.js";
import { getHermesBridgeTask } from "./task-registry.js";
import type { HermesBridgeRequest, HermesBridgeResult } from "./types.js";

type ExecuteParams = {
  config: HermesBridgeConfig;
  request: HermesBridgeRequest;
  subagent?: PluginRuntime["subagent"];
  recoveredLease?: boolean;
  cleanupStore?: HermesBridgeIdempotencyStore;
};

const unavailableSubagent = new Proxy({} as PluginRuntime["subagent"], {
  get() {
    return async () => {
      throw new Error("OpenClaw subagent runtime is unavailable.");
    };
  },
});

function readBridgeStatus(output: unknown): HermesBridgeResult["status"] | undefined {
  if (!output || typeof output !== "object" || !("bridgeStatus" in output)) {
    return undefined;
  }
  const status = output.bridgeStatus;
  return status === "accepted" ||
    status === "blocked" ||
    status === "failed" ||
    status === "needs_confirmation" ||
    status === "running" ||
    status === "succeeded"
    ? status
    : undefined;
}

function readBridgeSummary(output: unknown): string | undefined {
  if (!output || typeof output !== "object" || !("bridgeSummary" in output)) {
    return undefined;
  }
  return typeof output.bridgeSummary === "string" && output.bridgeSummary.trim()
    ? output.bridgeSummary.trim()
    : undefined;
}

function reject(params: {
  request?: HermesBridgeRequest;
  type: string;
  message: string;
  status?: HermesBridgeResult["status"];
  mode?: HermesBridgeMode;
}): HermesBridgeResult {
  return createHermesBridgeResult({
    ok: false,
    request: params.request,
    mode: params.mode ?? "mock",
    status: params.status ?? "blocked",
    summary: params.message,
    error: {
      type: params.type,
      message: params.message,
    },
    auditLog: [createAuditEvent("rejected", params.message)],
  });
}

export async function executeHermesBridgeTask({
  config,
  request,
  subagent,
  recoveredLease = false,
  cleanupStore,
}: ExecuteParams): Promise<HermesBridgeResult> {
  const task = getHermesBridgeTask(request.taskId);
  if (!task) {
    return reject({
      request,
      type: "unknown_task",
      message: `Unknown Hermes bridge task: ${request.taskId}`,
      status: "failed",
    });
  }
  if (!config.allowedTasks.includes(request.taskId)) {
    return reject({
      request,
      type: "task_not_allowed",
      message: `Hermes bridge task is not allowlisted: ${request.taskId}`,
    });
  }
  if (task.requiresDryRun && !request.dryRun) {
    return reject({
      request,
      type: "dry_run_required",
      message: `Hermes bridge task requires dryRun=true: ${request.taskId}`,
      status: "blocked",
    });
  }
  if (!request.dryRun && (config.mode !== "live" || task.mockOnly)) {
    const realMockTask = task.mockOnly && config.mode === "live" && config.hermesMode === "real";
    return reject({
      request,
      type: realMockTask
        ? "real_task_unavailable"
        : task.mockOnly
          ? "dry_run_required"
          : "live_mode_required",
      message: realMockTask
        ? `Hermes bridge task has no live executor: ${request.taskId}`
        : task.mockOnly
          ? `Hermes bridge task requires dryRun=true: ${request.taskId}`
          : `Hermes bridge live mode is required for non-dry-run task: ${request.taskId}`,
      status: "blocked",
      mode: config.mode,
    });
  }
  const configDeniedTools = task.requiredTools.filter(
    (tool) => !config.allowedTools.includes(tool),
  );
  const requestDeniedTools = task.requiredTools.filter(
    (tool) => !request.allowedTools.includes(tool),
  );
  if (configDeniedTools.length > 0 || requestDeniedTools.length > 0) {
    const missing = Array.from(new Set([...configDeniedTools, ...requestDeniedTools])).toSorted();
    return reject({
      request,
      type: "tool_not_allowed",
      message: `Hermes bridge task requires unallowlisted tool(s): ${missing.join(", ")}`,
    });
  }
  if (task.dangerous && !request.requiresConfirmation) {
    return reject({
      request,
      type: "confirmation_required",
      message: `Hermes bridge task requires explicit confirmation: ${request.taskId}`,
      status: "needs_confirmation",
    });
  }
  if (!request.dryRun && request.protocolVersion !== "2.0") {
    return reject({
      request,
      type: "protocol_v2_required",
      message: `Hermes bridge live task requires protocolVersion=2.0: ${request.taskId}`,
      status: "blocked",
      mode: config.mode,
    });
  }

  if (!task.mockOnly && !subagent) {
    return reject({
      request,
      type: "subagent_runtime_unavailable",
      message: "OpenClaw subagent runtime is unavailable for this live task.",
      status: "failed",
      mode: config.mode,
    });
  }
  const effectiveMode: HermesBridgeMode = task.mockOnly ? "mock" : config.mode;
  let output: unknown;
  try {
    output = await task.execute({
      request,
      mode: effectiveMode,
      config,
      subagent: subagent ?? unavailableSubagent,
      recoveredLease,
      cleanupStore,
    });
  } catch (error) {
    if (error instanceof HermesBridgeCleanupPendingError) {
      return reject({
        request,
        type: "cleanup_in_progress",
        message:
          "Cleanup from an earlier execution generation is still pending; retry after cleanup completes.",
        status: "running",
        mode: effectiveMode,
      });
    }
    if (error instanceof HermesBridgeCleanupStoreUnavailableError) {
      return reject({
        request,
        type: "cleanup_store_unavailable",
        message: error.message,
        status: "running",
        mode: effectiveMode,
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    return reject({
      request,
      type: "task_execution_failed",
      message: `Hermes bridge task execution failed: ${message}`,
      status: "failed",
      mode: effectiveMode,
    });
  }
  const backendExecution =
    output &&
    typeof output === "object" &&
    "backendExecution" in output &&
    output.backendExecution &&
    typeof output.backendExecution === "object"
      ? (output.backendExecution as HermesBridgeResult["backendExecution"])
      : undefined;
  const bridgeStatus = readBridgeStatus(output);
  return createHermesBridgeResult({
    ok: true,
    request,
    mode: effectiveMode,
    status: bridgeStatus ?? "succeeded",
    summary:
      readBridgeSummary(output) ??
      task.successSummary ??
      `Hermes bridge task succeeded: ${request.taskId}`,
    output,
    backendExecution,
    auditLog: [
      createAuditEvent("accepted", `Accepted Hermes task ${request.taskId}.`),
      createAuditEvent(
        "executed",
        `Executed Hermes task ${request.taskId} in ${effectiveMode} mode.`,
      ),
    ],
  });
}
