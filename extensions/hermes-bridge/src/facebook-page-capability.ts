import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { jsonResult } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import type { HermesBridgeConfig } from "./config.js";
import type { HermesBridgeRequest } from "./types.js";

export const FACEBOOK_PAGE_OPERATOR_AGENT = "missioncrew-facebook-page-operator";
export const FACEBOOK_PAGE_CAPABILITY_TOOLS = [
  "facebook_page_graph_status",
  "facebook_page_graph_publish",
] as const;
export const FACEBOOK_PAGE_PREFLIGHT_TOOLS = ["facebook_page_publish_preflight"] as const;

type CapabilityGrant = {
  task_id: string;
  run_id: number;
  delegation_id: string;
  contract_fingerprint: string;
  approval_grant_id: string;
  backend_agent_id: string;
  board: string;
  task_type: "facebook_page_api_publish" | "facebook_page_publish_preflight";
};

const activeGrants = new Map<string, CapabilityGrant>();

function expandHome(path: string): string {
  return path === "~"
    ? homedir()
    : path.startsWith("~/")
      ? resolve(homedir(), path.slice(2))
      : path;
}

function grantPath(config: HermesBridgeConfig, sessionKey: string): string {
  const digest = createHash("sha256").update(sessionKey, "utf8").digest("hex");
  return `${expandHome(config.idempotencyDbPath)}.facebook-page-grants/${digest}.json`;
}

function persistGrant(
  config: HermesBridgeConfig,
  sessionKey: string,
  grant: CapabilityGrant,
): void {
  const path = grantPath(config, sessionKey);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(grant), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function readGrant(config: HermesBridgeConfig, sessionKey: string): CapabilityGrant | undefined {
  const cached = activeGrants.get(sessionKey);
  if (cached) {
    return cached;
  }
  try {
    const parsed = JSON.parse(readFileSync(grantPath(config, sessionKey), "utf8"));
    const record = readRecord(parsed);
    const taskType = record.task_type;
    if (
      typeof record.task_id !== "string" ||
      !Number.isInteger(record.run_id) ||
      typeof record.delegation_id !== "string" ||
      typeof record.contract_fingerprint !== "string" ||
      typeof record.approval_grant_id !== "string" ||
      record.backend_agent_id !== FACEBOOK_PAGE_OPERATOR_AGENT ||
      typeof record.board !== "string" ||
      (taskType !== "facebook_page_api_publish" && taskType !== "facebook_page_publish_preflight")
    ) {
      return undefined;
    }
    const grant = record as CapabilityGrant;
    activeGrants.set(sessionKey, grant);
    return grant;
  } catch {
    return undefined;
  }
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function activateFacebookPageCapability(
  request: HermesBridgeRequest,
  sessionKey: string,
  config: HermesBridgeConfig,
): void {
  const taskType = request.identity.taskType;
  if (taskType !== "facebook_page_api_publish" && taskType !== "facebook_page_publish_preflight") {
    return;
  }
  const input = readRecord(request.input);
  const taskId = String(input.delegatedTaskId ?? "").trim();
  const attempt = /^(.+):run:(\d+)$/.exec(request.identity.attemptId ?? "");
  const expectedTools =
    taskType === "facebook_page_api_publish"
      ? FACEBOOK_PAGE_CAPABILITY_TOOLS
      : FACEBOOK_PAGE_PREFLIGHT_TOOLS;
  const exactTools =
    request.allowedTools.length === expectedTools.length &&
    expectedTools.every((tool) => request.allowedTools.includes(tool));
  const exactPolicy =
    taskType === "facebook_page_api_publish"
      ? request.policy.externalEffectBudget === 1 && Boolean(request.policy.approvalGrantId)
      : request.policy.externalEffectBudget === 0 && !request.policy.approvalGrantId;
  if (
    request.routing.backendAgentId !== FACEBOOK_PAGE_OPERATOR_AGENT ||
    !taskId ||
    !attempt ||
    attempt[1] !== taskId ||
    !exactTools ||
    !exactPolicy ||
    request.policy.credentialRefs.length !== 1 ||
    request.policy.credentialRefs[0] !== "missioncrew-facebook-page" ||
    !request.identity.delegationId ||
    !request.identity.contractFingerprint
  ) {
    throw new Error(
      "Facebook Page capability grant does not match the dedicated operator contract.",
    );
  }
  const grant: CapabilityGrant = {
    task_id: taskId,
    run_id: Number.parseInt(attempt[2], 10),
    delegation_id: request.identity.delegationId,
    contract_fingerprint: request.identity.contractFingerprint,
    approval_grant_id: request.policy.approvalGrantId ?? "",
    backend_agent_id: FACEBOOK_PAGE_OPERATOR_AGENT,
    board: String(input.kanbanBoard ?? "").trim(),
    task_type: taskType,
  };
  persistGrant(config, sessionKey, grant);
  activeGrants.set(sessionKey, grant);
}

export function revokeFacebookPageCapability(sessionKey: string, config: HermesBridgeConfig): void {
  activeGrants.delete(sessionKey);
  try {
    unlinkSync(grantPath(config, sessionKey));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function invokeBroker(params: {
  config: HermesBridgeConfig;
  grant: CapabilityGrant;
  operation: "status" | "publish" | "preflight";
  args: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const cwd = resolve(params.config.hermesAgentPath);
  const managedPython = resolve(cwd, ".venv312", "bin", "python");
  const python =
    process.env.HERMES_PYTHON || (existsSync(managedPython) ? managedPython : "python3");
  const payload = JSON.stringify({
    operation: params.operation,
    args: params.args,
    scope: params.grant,
  });
  return new Promise((resolveResult, reject) => {
    const child = spawn(python, ["-m", "tools.facebook_page_capability_broker"], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const maxBytes = params.config.maxRequestBytes;
    const timer = setTimeout(() => child.kill("SIGTERM"), 65_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > maxBytes) {
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Facebook Page capability broker exited ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolveResult(readRecord(parsed));
      } catch {
        reject(new Error("Facebook Page capability broker returned invalid JSON."));
      }
    });
    child.stdin.end(payload);
  });
}

export function createFacebookPageCapabilityTools(
  ctx: OpenClawPluginToolContext,
  config: HermesBridgeConfig,
) {
  if (
    !config.enabled ||
    config.mode !== "live" ||
    config.hermesMode !== "real" ||
    ctx.agentId !== FACEBOOK_PAGE_OPERATOR_AGENT ||
    !ctx.sessionKey
  ) {
    return null;
  }
  const grant = readGrant(config, ctx.sessionKey);
  if (!grant) {
    return null;
  }
  if (grant.task_type === "facebook_page_publish_preflight") {
    return [
      {
        name: "facebook_page_publish_preflight",
        label: "Facebook Page Publish Preflight",
        description:
          "Deterministically verify the contract-embedded Page source, authorized section removals, final text hash, local PNG dimensions/hash, and Graph Page identity without publishing.",
        parameters: Type.Object({
          final_message: Type.String(),
          image_path: Type.String(),
        }),
        async execute(_toolCallId: string, raw: Record<string, unknown>) {
          return jsonResult(
            await invokeBroker({ config, grant, operation: "preflight", args: raw }),
          );
        },
      },
    ];
  }
  return [
    {
      name: "facebook_page_graph_status",
      label: "Facebook Page Status",
      description:
        "Read-only verification of the configured Facebook Page identity through the MissionCrew capability broker.",
      parameters: Type.Object({}),
      async execute() {
        return jsonResult(await invokeBroker({ config, grant, operation: "status", args: {} }));
      },
    },
    {
      name: "facebook_page_graph_publish",
      label: "Facebook Page Publish",
      description:
        "Publish exactly one approved photo post. The broker verifies the task, approval, target, text hash, image hash, and durable effect ledger.",
      parameters: Type.Object({
        page_url: Type.String(),
        message: Type.String(),
        image_path: Type.String(),
      }),
      async execute(_toolCallId: string, raw: Record<string, unknown>) {
        return jsonResult(await invokeBroker({ config, grant, operation: "publish", args: raw }));
      },
    },
  ];
}
