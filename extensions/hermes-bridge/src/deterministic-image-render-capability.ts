import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { jsonResult } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { Type } from "typebox";
import type { HermesBridgeConfig } from "./config.js";
import type { HermesBridgeRequest } from "./types.js";

export const DETERMINISTIC_IMAGE_RENDER_TOOL = "deterministic_image_render";
export const DETERMINISTIC_IMAGE_RENDER_AGENT = "missioncrew-content";

export type RenderGrant = {
  task_id: string;
  contract_fingerprint: string;
  allowed_asset_filenames: string[];
  authorized_source_path?: string;
  authorized_source_sha256?: string;
  receipt_scope_id: string;
};

const activeGrants = new Map<string, RenderGrant>();
const pendingRenders = new Map<string, Set<Promise<unknown>>>();
const SAFE_CONTENT_TOOLS = new Set([
  "read",
  "write",
  "web_search",
  "image_generate",
  DETERMINISTIC_IMAGE_RENDER_TOOL,
]);

export type DeterministicImageRenderReceipt = {
  target: "openclaw.deterministic_image_render.local_media";
  effectKey: string;
  state: "verified";
  readback: {
    attestedBy: "openclaw_deterministic_image_render_broker";
    taskId: string;
    ownerSessionKey: string;
    path: string;
    sha256: string;
    sourceSha256: string;
    mimeType: "image/png";
    dimensions: string;
    endedAt: number;
  };
};

function deterministicImageRenderReceiptTaskId(grant: RenderGrant): string {
  return `deterministic_image_render:${createHash("sha256")
    .update(`${grant.task_id}\0${grant.contract_fingerprint}`, "utf8")
    .digest("hex")}`;
}

export function peekDeterministicImageRenderReceipts(
  sessionKey: string,
  request: HermesBridgeRequest,
  config: HermesBridgeConfig,
): DeterministicImageRenderReceipt[] {
  const grant = readPersistedGrant(config, sessionKey);
  const input = record(request.input);
  if (
    !grant ||
    grant.task_id !== input?.delegatedTaskId ||
    grant.contract_fingerprint !== request.identity.contractFingerprint
  ) {
    return [];
  }
  // Polling is observational. Revoke only after the audited terminal is durable.
  return readRenderReceipts(config, sessionKey, grant);
}

export function recordDeterministicImageRenderReceipt(
  sessionKey: string,
  grant: RenderGrant,
  result: Record<string, unknown>,
  config: HermesBridgeConfig,
): DeterministicImageRenderReceipt {
  const active = activeGrants.get(sessionKey);
  const persisted = readPersistedGrant(config, sessionKey);
  if (
    !active ||
    active.receipt_scope_id !== grant.receipt_scope_id ||
    active.task_id !== grant.task_id ||
    active.contract_fingerprint !== grant.contract_fingerprint ||
    String(active.authorized_source_sha256 ?? "").toLowerCase() !==
      String(grant.authorized_source_sha256 ?? "").toLowerCase() ||
    persisted?.receipt_scope_id !== grant.receipt_scope_id
  ) {
    throw new Error("Deterministic image receipt scope is no longer active.");
  }
  const rawPath = String(result.path ?? "").trim();
  const outputPath = resolve(rawPath);
  const outputSha256 = String(result.sha256 ?? "").toLowerCase();
  const sourceSha256 = String(grant.authorized_source_sha256 ?? "").toLowerCase();
  const dimensions = String(result.dimensions ?? "").toLowerCase();
  if (
    result.success !== true ||
    !rawPath ||
    !/^[0-9a-f]{64}$/.test(outputSha256) ||
    !/^\d+x\d+$/.test(dimensions) ||
    !/^[0-9a-f]{64}$/.test(sourceSha256)
  ) {
    throw new Error("Deterministic image broker returned an incomplete receipt.");
  }
  const taskId = deterministicImageRenderReceiptTaskId(grant);
  const receipt: DeterministicImageRenderReceipt = {
    target: "openclaw.deterministic_image_render.local_media",
    effectKey: taskId,
    state: "verified",
    readback: {
      attestedBy: "openclaw_deterministic_image_render_broker",
      taskId,
      ownerSessionKey: sessionKey,
      path: outputPath,
      sha256: outputSha256,
      sourceSha256,
      mimeType: "image/png",
      dimensions,
      endedAt: Date.now(),
    },
  };
  // The owning gateway records this entire append synchronously, with no await:
  // parallel broker completions serialize on its JavaScript event loop.
  const receipts = [...readRenderReceipts(config, sessionKey, grant), receipt];
  persistJson(`${grantPath(config, sessionKey)}.receipts.json`, {
    scopeId: grant.receipt_scope_id,
    receipts,
  });
  return receipt;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function expandHome(path: string): string {
  return path === "~"
    ? homedir()
    : path.startsWith("~/")
      ? resolve(homedir(), path.slice(2))
      : path;
}

function grantPath(config: HermesBridgeConfig, sessionKey: string): string {
  const digest = createHash("sha256").update(sessionKey, "utf8").digest("hex");
  return `${expandHome(config.idempotencyDbPath)}.deterministic-image-render-grants/${digest}.json`;
}

function persistJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function persistGrant(config: HermesBridgeConfig, sessionKey: string, grant: RenderGrant): void {
  persistJson(grantPath(config, sessionKey), grant);
}

function readRenderReceipts(
  config: HermesBridgeConfig,
  sessionKey: string,
  grant: RenderGrant,
): DeterministicImageRenderReceipt[] {
  let value: Record<string, unknown> | undefined;
  try {
    value = record(
      JSON.parse(readFileSync(`${grantPath(config, sessionKey)}.receipts.json`, "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const taskId = deterministicImageRenderReceiptTaskId(grant);
  if (
    !value ||
    value.scopeId !== grant.receipt_scope_id ||
    !Array.isArray(value.receipts) ||
    !value.receipts.every((item) => {
      const receipt = record(item);
      const readback = record(receipt?.readback);
      return (
        receipt?.target === "openclaw.deterministic_image_render.local_media" &&
        receipt.effectKey === taskId &&
        receipt.state === "verified" &&
        readback?.attestedBy === "openclaw_deterministic_image_render_broker" &&
        readback.taskId === taskId &&
        readback.ownerSessionKey === sessionKey &&
        readback.sourceSha256 === grant.authorized_source_sha256?.toLowerCase() &&
        typeof readback.path === "string" &&
        readback.path.length > 0 &&
        /^[0-9a-f]{64}$/.test(String(readback.sha256 ?? "")) &&
        readback.mimeType === "image/png" &&
        /^\d+x\d+$/.test(String(readback.dimensions ?? "")) &&
        typeof readback.endedAt === "number" &&
        Number.isFinite(readback.endedAt)
      );
    })
  ) {
    throw new Error("Persisted deterministic image receipts do not match their scope.");
  }
  return value.receipts as DeterministicImageRenderReceipt[];
}

function scopeFence(
  config: HermesBridgeConfig,
  sessionKey: string,
  grant: RenderGrant,
): string | undefined {
  try {
    const fence = record(
      JSON.parse(readFileSync(`${grantPath(config, sessionKey)}.fence.json`, "utf8")),
    );
    if (
      !fence ||
      typeof fence.scopeId !== "string" ||
      !["closing", "revoked", "failed", "running", "idle"].includes(String(fence.state))
    ) {
      throw new Error("Persisted deterministic image fence is invalid.");
    }
    return fence.scopeId === grant.receipt_scope_id && fence.state !== "idle"
      ? String(fence.state)
      : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// Stop new calls, then drain complete tool calls (broker + durable receipt).
// A terminal audit cannot overtake a still-running local renderer.
export async function drainDeterministicImageRenderCapability(
  sessionKey: string,
  config: HermesBridgeConfig,
): Promise<boolean> {
  const grant = readPersistedGrant(config, sessionKey);
  if (grant && scopeFence(config, sessionKey, grant) === "failed") return false;
  if (
    grant &&
    ["running", "closing"].includes(scopeFence(config, sessionKey, grant) ?? "") &&
    !pendingRenders.get(sessionKey)?.size
  ) {
    persistJson(`${grantPath(config, sessionKey)}.fence.json`, {
      scopeId: grant.receipt_scope_id,
      state: "failed",
    });
    return false;
  }
  if (grant)
    persistJson(`${grantPath(config, sessionKey)}.fence.json`, {
      scopeId: grant.receipt_scope_id,
      state: "closing",
    });
  const pending = [...(pendingRenders.get(sessionKey) ?? [])];
  const drained = await Promise.allSettled(pending);
  return (
    !drained.some((result) => result.status === "rejected") &&
    (!grant || scopeFence(config, sessionKey, grant) !== "failed")
  );
}

function readGrant(config: HermesBridgeConfig, sessionKey: string): RenderGrant | undefined {
  const cached = activeGrants.get(sessionKey);
  if (cached) {
    return scopeFence(config, sessionKey, cached) ? undefined : cached;
  }
  const grant = readPersistedGrant(config, sessionKey);
  if (grant && !scopeFence(config, sessionKey, grant)) {
    activeGrants.set(sessionKey, grant);
  }
  return grant && !scopeFence(config, sessionKey, grant) ? grant : undefined;
}

function readPersistedGrant(
  config: HermesBridgeConfig,
  sessionKey: string,
): RenderGrant | undefined {
  try {
    const parsed = record(JSON.parse(readFileSync(grantPath(config, sessionKey), "utf8")));
    if (
      !parsed ||
      typeof parsed.task_id !== "string" ||
      typeof parsed.contract_fingerprint !== "string" ||
      !Array.isArray(parsed.allowed_asset_filenames) ||
      !parsed.allowed_asset_filenames.every((item) => typeof item === "string") ||
      typeof parsed.authorized_source_path !== "string" ||
      !/^[0-9a-f]{64}$/i.test(String(parsed.authorized_source_sha256 ?? "")) ||
      typeof parsed.receipt_scope_id !== "string" ||
      !parsed.receipt_scope_id
    ) {
      throw new Error("Persisted deterministic image grant is invalid.");
    }
    const grant = parsed as RenderGrant;
    return scopeFence(config, sessionKey, grant) === "revoked" ? undefined : grant;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function inheritedAudioSource(contract: Record<string, unknown>):
  | {
      path: string;
      sha256: string;
    }
  | undefined {
  const sourceRef = record(contract.source_package_ref);
  const snapshot = record(contract.durable_evidence_snapshot);
  const referenced = Array.isArray(snapshot?.referenced_task_evidence)
    ? snapshot.referenced_task_evidence
    : [];
  const sourceTaskId = sourceRef?.execution_task_id;
  const sourceRunId = sourceRef?.execution_run_id;
  if (
    typeof sourceTaskId !== "string" ||
    !sourceTaskId.trim() ||
    !Number.isInteger(sourceRunId) ||
    Number(sourceRunId) <= 0
  ) {
    return undefined;
  }
  for (const item of referenced) {
    const evidence = record(item);
    const latest = record(evidence?.latest_completed_run);
    if (!latest || evidence?.task_id !== sourceTaskId || latest.run_id !== sourceRunId) {
      continue;
    }
    const acceptance = record(latest.acceptance_evidence);
    const assets = Array.isArray(acceptance?.image_assets) ? acceptance.image_assets : [];
    const audio = assets.map(record).find((asset) => asset?.asset_family === "audio_brief");
    if (
      audio &&
      typeof audio.path === "string" &&
      typeof audio.sha256 === "string" &&
      /^[0-9a-f]{64}$/.test(audio.sha256)
    ) {
      return { path: resolve(audio.path), sha256: audio.sha256 };
    }
  }
  return undefined;
}

export function activateDeterministicImageRenderCapability(
  request: HermesBridgeRequest,
  sessionKey: string,
  config: HermesBridgeConfig,
): void {
  revokeDeterministicImageRenderCapability(sessionKey, config);
  if (!request.allowedTools.includes(DETERMINISTIC_IMAGE_RENDER_TOOL)) {
    return;
  }
  const input = record(request.input);
  const contract = record(input?.loopContract);
  const delivery = record(contract?.user_facing_delivery);
  // Role tools are not per-stage grants: inline-only content needs no renderer.
  if (delivery?.kind === "content_package" && delivery.delivery === "inline_only") return;
  const filenames = Array.isArray(delivery?.asset_filenames)
    ? delivery.asset_filenames.filter(
        (item): item is string =>
          typeof item === "string" && item === item.trim() && item.toLowerCase().endsWith(".png"),
      )
    : [];
  const audioFilenames = filenames.filter(
    (name) => basename(name) === name && /(?:^|[-_ ])audio[-_ ]brief\.png$/i.test(name),
  );
  // General image-generation packages have no inherited Audio Brief to render.
  // An available role tool must not block their ordinary image_generate route.
  if (audioFilenames.length === 0) return;
  const attempt = /^(.+):run:(\d+)$/.exec(request.identity.attemptId ?? "");
  if (
    request.protocolVersion !== "2.0" ||
    request.routing.backendAgentId !== DETERMINISTIC_IMAGE_RENDER_AGENT ||
    !["campaign", "content_draft", "product_marketing"].includes(request.identity.taskType ?? "") ||
    request.policy.externalEffectBudget !== 0 ||
    Boolean(request.policy.approvalGrantId) ||
    request.policy.credentialRefs.length !== 0 ||
    request.allowedTools.some((tool) => !SAFE_CONTENT_TOOLS.has(tool)) ||
    !attempt ||
    typeof input?.delegatedTaskId !== "string" ||
    attempt[1] !== input.delegatedTaskId ||
    !request.identity.contractFingerprint ||
    delivery?.kind !== "content_package" ||
    audioFilenames.length !== 1
  ) {
    throw new Error(
      "Deterministic image render grant does not match a zero-effect content-package contract.",
    );
  }
  const source = inheritedAudioSource(contract ?? {});
  if (!source) {
    throw new Error(
      "Deterministic image render grant has no contract-bound inherited Audio Brief source.",
    );
  }
  const grant: RenderGrant = {
    task_id: input.delegatedTaskId,
    contract_fingerprint: request.identity.contractFingerprint,
    allowed_asset_filenames: audioFilenames,
    authorized_source_path: source.path,
    authorized_source_sha256: source.sha256,
    receipt_scope_id: randomUUID(),
  };
  persistGrant(config, sessionKey, grant);
  activeGrants.set(sessionKey, grant);
}

export function revokeDeterministicImageRenderCapability(
  sessionKey: string,
  config?: HermesBridgeConfig,
): void {
  if (!config) {
    activeGrants.delete(sessionKey);
    return;
  }
  const grant = readPersistedGrant(config, sessionKey);
  // Persist denial before destructive cleanup; failed unlink must not resurrect authority.
  if (grant)
    persistJson(`${grantPath(config, sessionKey)}.fence.json`, {
      scopeId: grant.receipt_scope_id,
      state: "revoked",
    });
  activeGrants.delete(sessionKey);
  // Revoke persisted authority first. Receipt cleanup failure must never
  // make a revoked capability available again after restart.
  try {
    unlinkSync(grantPath(config, sessionKey));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    unlinkSync(`${grantPath(config, sessionKey)}.receipts.json`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function invokeBroker(
  config: HermesBridgeConfig,
  grant: RenderGrant,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const cwd = resolve(config.hermesAgentPath);
  const managedPython = resolve(cwd, ".venv312", "bin", "python");
  const python =
    process.env.HERMES_PYTHON || (existsSync(managedPython) ? managedPython : "python3");
  return new Promise((resolveResult, reject) => {
    const child = spawn(python, ["-m", "tools.deterministic_image_render_broker"], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let terminationError: Error | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const terminateAndFail = (error: Error) => {
      if (settled || terminationError) return;
      terminationError = error;
      clearTimeout(timer);
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      forceTimer.unref();
      // Keep the owner operation pending until close proves process exit.
    };
    const enforceOutputLimit = () => {
      if (
        Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") >
        config.maxRequestBytes
      ) {
        terminateAndFail(
          new Error("Deterministic image broker output exceeded the configured limit."),
        );
      }
    };
    const timer = setTimeout(
      () => terminateAndFail(new Error("Deterministic image broker timed out after 30 seconds.")),
      30_000,
    );
    child.stdout.on("data", (chunk) => {
      if (settled || terminationError) {
        return;
      }
      stdout += chunk.toString("utf8");
      enforceOutputLimit();
    });
    child.stderr.on("data", (chunk) => {
      if (!settled && !terminationError) {
        stderr += chunk.toString("utf8");
        enforceOutputLimit();
      }
    });
    child.on("error", (error) => {
      if (child.pid) terminateAndFail(error);
      else fail(error); // Spawn failure has no running process to drain.
    });
    child.stdin.on("error", (error) => {
      terminateAndFail(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (forceTimer) {
        clearTimeout(forceTimer);
      }
      if (settled) {
        return;
      }
      settled = true;
      if (terminationError) {
        reject(terminationError);
        return;
      }
      if (code !== 0) {
        reject(new Error(`Deterministic image broker exited ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        const result = record(parsed);
        if (!result) {
          reject(new Error("Deterministic image broker returned a non-object response."));
          return;
        }
        resolveResult(result);
      } catch {
        reject(new Error("Deterministic image broker returned invalid JSON."));
      }
    });
    child.stdin.end(JSON.stringify({ args, scope: grant }));
  });
}

export function createDeterministicImageRenderTool(
  ctx: OpenClawPluginToolContext,
  config: HermesBridgeConfig,
  _taskRuns?: PluginRuntime["tasks"]["runs"],
) {
  if (
    !config.enabled ||
    config.mode !== "live" ||
    config.hermesMode !== "real" ||
    ctx.agentId !== DETERMINISTIC_IMAGE_RENDER_AGENT ||
    !ctx.sessionKey
  ) {
    return null;
  }
  const grant = readGrant(config, ctx.sessionKey);
  if (!grant) {
    return null;
  }
  return {
    name: DETERMINISTIC_IMAGE_RENDER_TOOL,
    label: "Deterministic Image Render",
    description: `Render the contract-authorized inherited Audio Brief PNG at ${grant.authorized_source_path} with a deterministic AI-assisted visual disclosure in a padded strip above the footer.`,
    parameters: Type.Object({
      source_image: Type.String(),
      output_filename: Type.String(),
      placement: Type.Literal("audio_brief_above_footer"),
    }),
    async execute(_toolCallId: string, raw: Record<string, unknown>) {
      const current = activeGrants.get(ctx.sessionKey!);
      const persisted = readPersistedGrant(config, ctx.sessionKey!);
      if (
        current !== grant ||
        !persisted ||
        scopeFence(config, ctx.sessionKey!, grant) ||
        JSON.stringify(persisted) !== JSON.stringify(grant)
      ) {
        throw new Error("Deterministic image render grant is no longer active.");
      }
      const sourcePath = resolve(String(raw.source_image ?? ""));
      const inheritedReceipt =
        sourcePath === resolve(current.authorized_source_path ?? "") &&
        /^[0-9a-f]{64}$/.test(current.authorized_source_sha256 ?? "")
          ? {
              path: sourcePath,
              sha256: current.authorized_source_sha256!,
            }
          : undefined;
      if (!inheritedReceipt) {
        throw new Error("Source image is not the exact contract-bound inherited Audio Brief.");
      }
      const scopedGrant = {
        ...current,
        authorized_source_path: inheritedReceipt.path,
        authorized_source_sha256: inheritedReceipt.sha256.toLowerCase(),
      };
      const pending = pendingRenders.get(ctx.sessionKey!) ?? new Set<Promise<unknown>>();
      pendingRenders.set(ctx.sessionKey!, pending);
      persistJson(`${grantPath(config, ctx.sessionKey!)}.fence.json`, {
        scopeId: grant.receipt_scope_id,
        state: "running",
      });
      const operation = (async () => {
        const result = await invokeBroker(config, scopedGrant, raw);
        recordDeterministicImageRenderReceipt(ctx.sessionKey!, scopedGrant, result, config);
        return jsonResult(result);
      })().catch((error) => {
        if (scopeFence(config, ctx.sessionKey!, grant) !== "revoked") {
          persistJson(`${grantPath(config, ctx.sessionKey!)}.fence.json`, {
            scopeId: grant.receipt_scope_id,
            state: "failed",
          });
        }
        throw error;
      });
      pending.add(operation);
      try {
        return await operation;
      } finally {
        if (scopeFence(config, ctx.sessionKey!, grant) === "running" && pending.size === 1) {
          persistJson(`${grantPath(config, ctx.sessionKey!)}.fence.json`, {
            scopeId: grant.receipt_scope_id,
            state: "idle",
          });
        }
        pending.delete(operation);
        if (!pending.size) pendingRenders.delete(ctx.sessionKey!);
      }
    },
  };
}
