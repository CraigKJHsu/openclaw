import { randomUUID } from "node:crypto";
import { rmdirSync } from "node:fs";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HERMES_BRIDGE_CONFIG } from "./config.js";
import type { HermesBridgeRequest } from "./types.js";

const cleanupDirectories: string[] = [];

afterEach(() => {
  for (const path of cleanupDirectories.splice(0)) {
    try {
      rmdirSync(path);
    } catch {
      // The grant revocation normally leaves the directory empty.
    }
  }
});

describe("Facebook Page capability grants", () => {
  it("makes a validated grant visible to a fresh worker plugin instance", async () => {
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
      intent: "facebook_page_publish_preflight",
      priority: "normal",
      requiresConfirmation: false,
      allowedTools: ["facebook_page_publish_preflight"],
      input: { delegatedTaskId: "t_preflight", kanbanBoard: "topic-4641" },
      dryRun: false,
      identity: {
        delegationId: "delegation-preflight",
        attemptId: "t_preflight:run:42",
        contractFingerprint: "contract-preflight",
        taskType: "facebook_page_publish_preflight",
      },
      routing: { backendAgentId: "missioncrew-facebook-page-operator" },
      policy: {
        externalEffectBudget: 0,
        credentialRefs: ["missioncrew-facebook-page"],
      },
    };

    const first = await import("./facebook-page-capability.js");
    first.activateFacebookPageCapability(request, sessionKey, config);

    vi.resetModules();
    const worker = await import("./facebook-page-capability.js");
    const tools = worker.createFacebookPageCapabilityTools(
      { agentId: "missioncrew-facebook-page-operator", sessionKey } as OpenClawPluginToolContext,
      config,
    );

    expect(tools?.map((tool) => tool.name)).toEqual(["facebook_page_publish_preflight"]);
    worker.revokeFacebookPageCapability(sessionKey, config);
  });
});
