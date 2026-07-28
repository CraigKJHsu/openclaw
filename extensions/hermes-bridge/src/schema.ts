export type HermesBridgePriority = "high" | "low" | "normal";
export type HermesBridgeProtocolVersion = "1.0" | "2.0";

export type HermesBridgeExecutionIdentity = {
  delegationId?: string;
  attemptId?: string;
  contractFingerprint?: string;
  project?: string;
  topicId?: string;
};

export type HermesBridgeExecutionRouting = {
  executorBackend?: "codex" | "hermes" | "openclaw";
  executorProfile?: string;
  backendAgentId?: string;
};

export type HermesBridgeExecutionPolicy = {
  approvalGrantId?: string;
  externalEffectBudget: number;
  workspacePolicy?: "dedicated" | "shared-readonly";
  sessionPolicy?: "ephemeral" | "persistent";
  credentialRefs: string[];
};

export type HermesBridgeRequest = {
  protocolVersion: HermesBridgeProtocolVersion;
  taskId: string;
  requestedBy: "hermes";
  intent: string;
  priority: HermesBridgePriority;
  requiresConfirmation: boolean;
  allowedTools: string[];
  input: Record<string, unknown>;
  dryRun: boolean;
  identity: HermesBridgeExecutionIdentity;
  routing: HermesBridgeExecutionRouting;
  policy: HermesBridgeExecutionPolicy;
  requestId?: string;
  idempotencyKey?: string;
};

export type HermesBridgeResultStatus =
  | "accepted"
  | "blocked"
  | "failed"
  | "needs_confirmation"
  | "running"
  | "succeeded";

export type HermesBridgeArtifact = {
  type: string;
  name?: string;
  uri?: string;
  value?: unknown;
};

export type HermesBridgeAuditEvent = {
  step: string;
  message: string;
  at: string;
};

export type HermesBridgeError = {
  type: string;
  message: string;
};

export type HermesBridgeResult = {
  ok: boolean;
  requestId?: string;
  idempotencyKey?: string;
  taskId?: string;
  mode: "live" | "mock";
  status: HermesBridgeResultStatus;
  summary: string;
  artifacts: HermesBridgeArtifact[];
  auditLog: HermesBridgeAuditEvent[];
  protocolVersion?: HermesBridgeProtocolVersion;
  executionIdentity?: {
    delegationId: string;
    attemptId: string;
    contractFingerprint: string;
  };
  backendExecution?: {
    executorBackend: "openclaw";
    backendRunId: string;
    backendAgentId: string;
    sessionKey: string;
  };
  output?: unknown;
  error?: HermesBridgeError;
};

export type HermesBridgeValidationResult =
  | { ok: true; request: HermesBridgeRequest }
  | { ok: false; error: HermesBridgeError };

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPriority(value: unknown): HermesBridgePriority {
  return value === "high" || value === "low" ? value : "normal";
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const items: string[] = [];
  for (const item of value) {
    const normalized = readString(item);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    items.push(normalized);
  }
  return items;
}

function readProtocolVersion(value: unknown): HermesBridgeProtocolVersion {
  return value === "2.0" ? "2.0" : "1.0";
}

function readExecutorBackend(
  value: unknown,
): HermesBridgeExecutionRouting["executorBackend"] | undefined {
  return value === "codex" || value === "hermes" || value === "openclaw" ? value : undefined;
}

function readExternalEffectBudget(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function invalidRequest(message: string): HermesBridgeValidationResult {
  return {
    ok: false,
    error: {
      type: "invalid_request",
      message,
    },
  };
}

export function createAuditEvent(step: string, message: string): HermesBridgeAuditEvent {
  return {
    step,
    message,
    at: new Date(0).toISOString(),
  };
}

export function normalizeHermesBridgeRequest(raw: unknown): HermesBridgeValidationResult {
  const record = readObject(raw);
  const identity = readObject(record.identity);
  const routing = readObject(record.routing);
  const policy = readObject(record.policy);
  const taskId = readString(record.taskId);
  if (!taskId) {
    return invalidRequest("Hermes bridge request requires a string taskId.");
  }
  if (
    Object.hasOwn(record, "protocolVersion") &&
    record.protocolVersion !== "1.0" &&
    record.protocolVersion !== "2.0"
  ) {
    return invalidRequest("Hermes bridge request uses an unsupported protocolVersion.");
  }
  const protocolVersion = readProtocolVersion(record.protocolVersion);
  const requestId = readString(record.requestId);
  const explicitIdempotencyKey = readString(record.idempotencyKey);
  const idempotencyKey = explicitIdempotencyKey ?? requestId;
  if (protocolVersion === "2.0") {
    const requiredIdentity = [
      ["delegationId", readString(identity.delegationId)],
      ["attemptId", readString(identity.attemptId)],
      ["contractFingerprint", readString(identity.contractFingerprint)],
      ["project", readString(identity.project)],
      ["topicId", readString(identity.topicId)],
    ] as const;
    const missingIdentity = requiredIdentity.find(([, value]) => !value)?.[0];
    if (missingIdentity) {
      return invalidRequest(`Protocol v2 requires identity.${missingIdentity}.`);
    }
    if (
      !readExecutorBackend(routing.executorBackend) ||
      !readString(routing.executorProfile) ||
      !readString(routing.backendAgentId)
    ) {
      return invalidRequest(
        "Protocol v2 requires executorBackend, executorProfile, and backendAgentId routing.",
      );
    }
    if (
      typeof policy.externalEffectBudget !== "number" ||
      !Number.isSafeInteger(policy.externalEffectBudget) ||
      policy.externalEffectBudget < 0
    ) {
      return invalidRequest(
        "Protocol v2 requires externalEffectBudget as a non-negative safe integer.",
      );
    }
    if (policy.workspacePolicy !== "dedicated" && policy.workspacePolicy !== "shared-readonly") {
      return invalidRequest("Protocol v2 requires a recognized workspacePolicy.");
    }
    if (policy.sessionPolicy !== "ephemeral" && policy.sessionPolicy !== "persistent") {
      return invalidRequest("Protocol v2 requires a recognized sessionPolicy.");
    }
    if (
      !Array.isArray(policy.credentialRefs) ||
      policy.credentialRefs.some((value) => !readString(value))
    ) {
      return invalidRequest("Protocol v2 requires credentialRefs as a string array.");
    }
    if (!explicitIdempotencyKey) {
      return invalidRequest("Protocol v2 requires an idempotencyKey.");
    }
  }
  return {
    ok: true,
    request: {
      protocolVersion,
      taskId,
      requestedBy: "hermes",
      intent: readString(record.intent) ?? taskId,
      priority: readPriority(record.priority),
      requiresConfirmation: record.requiresConfirmation === true,
      allowedTools: readStringList(record.allowedTools),
      input: readObject(record.input),
      dryRun: record.dryRun !== false,
      identity: {
        ...(readString(identity.delegationId)
          ? { delegationId: readString(identity.delegationId) }
          : {}),
        ...(readString(identity.attemptId) ? { attemptId: readString(identity.attemptId) } : {}),
        ...(readString(identity.contractFingerprint)
          ? { contractFingerprint: readString(identity.contractFingerprint) }
          : {}),
        ...(readString(identity.project) ? { project: readString(identity.project) } : {}),
        ...(readString(identity.topicId) ? { topicId: readString(identity.topicId) } : {}),
      },
      routing: {
        ...(readExecutorBackend(routing.executorBackend)
          ? { executorBackend: readExecutorBackend(routing.executorBackend) }
          : {}),
        ...(readString(routing.executorProfile)
          ? { executorProfile: readString(routing.executorProfile) }
          : {}),
        ...(readString(routing.backendAgentId)
          ? { backendAgentId: readString(routing.backendAgentId) }
          : {}),
      },
      policy: {
        ...(readString(policy.approvalGrantId)
          ? { approvalGrantId: readString(policy.approvalGrantId) }
          : {}),
        externalEffectBudget: readExternalEffectBudget(policy.externalEffectBudget),
        ...(policy.workspacePolicy === "dedicated" || policy.workspacePolicy === "shared-readonly"
          ? { workspacePolicy: policy.workspacePolicy }
          : {}),
        ...(policy.sessionPolicy === "ephemeral" || policy.sessionPolicy === "persistent"
          ? { sessionPolicy: policy.sessionPolicy }
          : {}),
        credentialRefs: readStringList(policy.credentialRefs),
      },
      ...(requestId ? { requestId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
  };
}

export function createHermesBridgeResult(params: {
  ok: boolean;
  request?: Pick<
    HermesBridgeRequest,
    "idempotencyKey" | "identity" | "protocolVersion" | "requestId" | "taskId"
  >;
  mode?: "live" | "mock";
  status: HermesBridgeResultStatus;
  summary: string;
  output?: unknown;
  error?: HermesBridgeError;
  artifacts?: HermesBridgeArtifact[];
  auditLog?: HermesBridgeAuditEvent[];
  backendExecution?: HermesBridgeResult["backendExecution"];
}): HermesBridgeResult {
  return {
    ok: params.ok,
    ...(params.request?.requestId ? { requestId: params.request.requestId } : {}),
    ...(params.request?.idempotencyKey ? { idempotencyKey: params.request.idempotencyKey } : {}),
    ...(params.request?.taskId ? { taskId: params.request.taskId } : {}),
    mode: params.mode ?? "mock",
    status: params.status,
    summary: params.summary,
    artifacts: params.artifacts ?? [],
    auditLog: params.auditLog ?? [],
    ...(params.request ? { protocolVersion: params.request.protocolVersion } : {}),
    ...(params.request?.protocolVersion === "2.0"
      ? {
          executionIdentity: {
            delegationId: params.request.identity.delegationId!,
            attemptId: params.request.identity.attemptId!,
            contractFingerprint: params.request.identity.contractFingerprint!,
          },
        }
      : {}),
    ...(params.backendExecution ? { backendExecution: params.backendExecution } : {}),
    ...(params.output !== undefined ? { output: params.output } : {}),
    ...(params.error ? { error: params.error } : {}),
  };
}
