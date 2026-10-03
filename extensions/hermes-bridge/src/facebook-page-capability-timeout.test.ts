import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, rmdirSync } from "node:fs";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_HERMES_BRIDGE_CONFIG } from "./config.js";
import type { HermesBridgeRequest } from "./types.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

const cleanupDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(spawn).mockReset();
  for (const path of cleanupDirectories.splice(0)) {
    if (existsSync(path)) rmdirSync(path);
  }
});

it("keeps the read-only Page status broker alive past the Graph timeout", async () => {
  const sessionKey = `agent:missioncrew-facebook-page-operator:subagent:test-${randomUUID()}`;
  const idempotencyDbPath = `/tmp/hermes-bridge-${randomUUID()}.sqlite`;
  cleanupDirectories.push(`${idempotencyDbPath}.facebook-page-grants`);
  const config = {
    ...DEFAULT_HERMES_BRIDGE_CONFIG,
    enabled: true,
    mode: "live" as const,
    hermesMode: "real" as const,
    idempotencyDbPath,
  };
  const request: HermesBridgeRequest = {
    protocolVersion: "2.0",
    taskId: "openclaw.agent.loop_contract_start",
    requestedBy: "hermes",
    intent: "facebook_page_api_publish",
    priority: "normal",
    requiresConfirmation: false,
    allowedTools: ["facebook_page_graph_status", "facebook_page_graph_publish"],
    input: { delegatedTaskId: "t_publish", kanbanBoard: "topic-4641" },
    dryRun: false,
    identity: {
      delegationId: "delegation-publish",
      attemptId: "t_publish:run:42",
      contractFingerprint: "contract-publish",
      taskType: "facebook_page_api_publish",
    },
    routing: { backendAgentId: "missioncrew-facebook-page-operator" },
    policy: {
      externalEffectBudget: 1,
      approvalGrantId: "approval-publish",
      credentialRefs: ["missioncrew-facebook-page"],
    },
  };
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { end: vi.fn() },
    kill: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(child as never);
  const capability = await import("./facebook-page-capability.js");
  capability.activateFacebookPageCapability(request, sessionKey, config);
  const tools = capability.createFacebookPageCapabilityTools(
    { agentId: "missioncrew-facebook-page-operator", sessionKey } as OpenClawPluginToolContext,
    config,
  );
  const status = tools?.find((tool) => tool.name === "facebook_page_graph_status");
  expect(status).toBeDefined();

  vi.useFakeTimers();
  const pending = (status as { execute: () => Promise<unknown> }).execute();
  await vi.advanceTimersByTimeAsync(65_000);
  expect(child.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(25_000);
  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  child.emit("close", null, "SIGTERM");
  await expect(pending).rejects.toThrow("Facebook Page capability broker timed out after 90s");
  capability.revokeFacebookPageCapability(sessionKey, config);
});
