import { createHash } from "node:crypto";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dispatchGatewayMethod } = vi.hoisted(() => ({
  dispatchGatewayMethod: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/gateway-method-runtime", () => ({
  dispatchGatewayMethod,
}));
import { resolveHermesBridgeConfig } from "./config.js";
import { executeHermesBridgeTask } from "./executor.js";
import {
  hashHermesBridgeRequest,
  MemoryHermesBridgeIdempotencyStore,
} from "./idempotency-store.js";
import { normalizeHermesBridgeRequest } from "./schema.js";
import { sweepHermesBridgeCleanupObligations } from "./task-registry.js";

function request(raw: Record<string, unknown>) {
  const normalized = normalizeHermesBridgeRequest(raw);
  if (!normalized.ok) {
    throw new Error(normalized.error.message);
  }
  return normalized.request;
}

function readonlyRequest(attemptId: string) {
  return request({
    protocolVersion: "2.0",
    taskId: "openclaw.browser.read_snapshot",
    idempotencyKey: attemptId,
    dryRun: false,
    allowedTools: ["browser.read"],
    input: { url: "https://example.com/" },
    identity: {
      delegationId: "delegation-1",
      attemptId,
      contractFingerprint: "sha256:contract",
      project: "hub_ops",
      topicId: "readonly-browser",
    },
    routing: {
      executorBackend: "openclaw",
      executorProfile: "browser-readonly",
      backendAgentId: "missioncrew-browser-readonly",
    },
    policy: {
      externalEffectBudget: 0,
      workspacePolicy: "dedicated",
      sessionPolicy: "ephemeral",
      credentialRefs: [],
    },
  });
}

function readonlyTabLabel(attemptId: string) {
  const identityHash = createHash("sha256")
    .update(
      ["delegation-1", attemptId, "hub_ops", "readonly-browser", "sha256:contract", attemptId].join(
        "\0",
      ),
    )
    .digest("hex")
    .slice(0, 24);
  return `hermes-readonly-${identityHash}`;
}

function readonlyScopedTabLabel(attemptId: string, generation: string) {
  const generationHash = createHash("sha256").update(generation).digest("hex").slice(0, 16);
  return `${readonlyTabLabel(attemptId)}-${generationHash}`;
}

function readonlyScopedSessionKey(attemptId: string, generation: string) {
  const identityHash = readonlyTabLabel(attemptId).replace("hermes-readonly-", "");
  const generationHash = createHash("sha256").update(generation).digest("hex").slice(0, 16);
  return (
    "agent:missioncrew-browser-readonly:subagent:" +
    `hermes-${attemptId}-${identityHash}-${generationHash}`
  );
}

function readonlyConfig(additionalTasks: string[] = []) {
  return resolveHermesBridgeConfig({
    enabled: true,
    mode: "live",
    hermesMode: "real",
    allowedTasks: ["openclaw.browser.read_snapshot", ...additionalTasks],
    allowedTools: ["browser.read"],
  });
}

function zeroEffectAsyncConfig(maxLiveRuntimeSeconds = 120) {
  return resolveHermesBridgeConfig({
    enabled: true,
    mode: "live",
    hermesMode: "real",
    allowedTasks: [
      "openclaw.agent.zero_effect_async_start",
      "openclaw.agent.zero_effect_async_poll",
      "openclaw.agent.zero_effect_async_cancel",
    ],
    allowedTools: [],
    maxLiveRuntimeSeconds,
  });
}

function zeroEffectAsyncRequest(
  taskId:
    | "openclaw.agent.zero_effect_async_start"
    | "openclaw.agent.zero_effect_async_poll"
    | "openclaw.agent.zero_effect_async_cancel",
  idempotencyKey: string,
  input: Record<string, unknown> = {},
) {
  return request({
    protocolVersion: "2.0",
    taskId,
    idempotencyKey,
    dryRun: false,
    allowedTools: [],
    input,
    identity: {
      delegationId: "delegation-async-1",
      attemptId: "attempt-async-1",
      contractFingerprint: "sha256:async-contract",
      project: "hub_ops",
      topicId: "zero-effect-async",
    },
    routing: {
      executorBackend: "openclaw",
      executorProfile: "zero-effect-async",
      backendAgentId: "missioncrew-browser-readonly",
    },
    policy: {
      externalEffectBudget: 0,
      workspacePolicy: "dedicated",
      sessionPolicy: "ephemeral",
      credentialRefs: [],
    },
  });
}

function readonlyAgentConfigPayload() {
  return {
    config: {
      browser: {
        profiles: {
          "hermes-readonly": {
            driver: "openclaw",
            color: "#FF4500",
          },
        },
      },
      agents: {
        list: [
          {
            id: "missioncrew-browser-readonly",
            tools: {
              allow: ["session_status"],
              deny: [
                "apply_patch",
                "edit",
                "exec",
                "gateway",
                "message",
                "nodes",
                "process",
                "read",
                "write",
              ],
            },
          },
        ],
      },
    },
  };
}

function readonlyBackendSubmission(runId: string) {
  return {
    sessionKey: `agent:missioncrew-browser-readonly:subagent:${runId}`,
    message: "Review captured evidence.",
    extraSystemPrompt: "Do not use tools.",
    lane: "hermes-bridge:test",
    lightContext: true as const,
    deliver: false as const,
    toolsAllow: [] as [],
    disableTools: true as const,
  };
}

const validReviewerResult =
  '{"url":"https://example.com/","title":"Example Domain","snapshotExcerpt":"Example Domain","sideEffectsPerformed":false}';

function successfulReadonlySubagent(
  messages: unknown[] = [{ role: "assistant", content: validReviewerResult }],
) {
  return {
    run: vi.fn(async (params: Parameters<PluginRuntime["subagent"]["run"]>[0]) => ({
      runId: params.idempotencyKey ?? "missing-idempotency-key",
    })),
    waitForRun: vi.fn().mockResolvedValue({ status: "ok", terminal: true }),
    getSessionMessages: vi.fn().mockResolvedValue({ messages }),
    getSession: vi.fn(),
    deleteSession: vi.fn().mockResolvedValue(undefined),
  } satisfies PluginRuntime["subagent"];
}

function mockSuccessfulBrowser(targetId = "tab-test") {
  dispatchGatewayMethod
    .mockResolvedValueOnce({ ok: true, payload: readonlyAgentConfigPayload() })
    .mockResolvedValueOnce({
      ok: true,
      payload: {
        targetId,
        title: "Example Domain",
        url: "https://example.com/",
      },
    })
    .mockResolvedValueOnce({
      ok: true,
      payload: {
        targetId,
        url: "https://example.com/",
        snapshot: "Example Domain",
      },
    })
    .mockResolvedValueOnce({ ok: true, payload: { ok: true } });
}

describe("executeHermesBridgeTask", () => {
  beforeEach(() => {
    dispatchGatewayMethod.mockReset();
  });
  it("rejects tasks that are not allowlisted", async () => {
    const result = await executeHermesBridgeTask({
      config: resolveHermesBridgeConfig({ enabled: true }),
      request: request({ taskId: "status.echo", input: { message: "hello" } }),
    });

    expect(result).toMatchObject({
      ok: false,
      taskId: "status.echo",
      mode: "mock",
      status: "blocked",
      error: { type: "task_not_allowed" },
    });
  });

  it("executes allowlisted mock-safe tasks", async () => {
    const result = await executeHermesBridgeTask({
      config: resolveHermesBridgeConfig({
        enabled: true,
        mode: "live",
        allowedTasks: ["status.echo"],
      }),
      request: request({
        requestId: "req-1",
        taskId: "status.echo",
        dryRun: true,
        input: { message: "hello" },
      }),
    });

    expect(result).toMatchObject({
      ok: true,
      requestId: "req-1",
      idempotencyKey: "req-1",
      taskId: "status.echo",
      mode: "mock",
      status: "succeeded",
      summary: "Hermes bridge task succeeded: status.echo",
      output: { message: "hello" },
    });
  });

  it("executes the MVP Hermes dry-run task organizer without external side effects", async () => {
    const result = await executeHermesBridgeTask({
      config: resolveHermesBridgeConfig({
        enabled: true,
        allowedTasks: ["tasks.organize_today"],
        allowedTools: [],
      }),
      request: request({
        requestId: "mvp-acceptance",
        taskId: "tasks.organize_today",
        intent: "請 OpenClaw 幫我整理今天的任務，但只做 dry-run。",
        allowedTools: [],
        dryRun: true,
        input: {
          request: "請 OpenClaw 幫我整理今天的任務，但只做 dry-run。",
        },
      }),
    });

    expect(result).toMatchObject({
      ok: true,
      requestId: "mvp-acceptance",
      taskId: "tasks.organize_today",
      mode: "mock",
      status: "succeeded",
      summary: "Dry-run completed. No external side effects were performed.",
      output: {
        dryRun: true,
        sideEffectsPerformed: false,
      },
    });
    expect(result.auditLog).toEqual([
      expect.objectContaining({ step: "accepted" }),
      expect.objectContaining({ step: "executed" }),
    ]);
  });

  it("requires dryRun=true for the MVP task organizer", async () => {
    const result = await executeHermesBridgeTask({
      config: resolveHermesBridgeConfig({
        enabled: true,
        allowedTasks: ["tasks.organize_today"],
      }),
      request: request({
        taskId: "tasks.organize_today",
        dryRun: false,
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      status: "blocked",
      error: { type: "dry_run_required" },
    });
  });

  it("rejects dryRun=false for all bridge tasks by default", async () => {
    const result = await executeHermesBridgeTask({
      config: resolveHermesBridgeConfig({
        enabled: true,
        allowedTasks: ["status.echo"],
      }),
      request: request({
        taskId: "status.echo",
        dryRun: false,
        input: { message: "do not run live" },
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      status: "blocked",
      error: { type: "dry_run_required" },
    });
  });

  it("accepts a dry-run OpenClaw agent team delegation without starting agents", async () => {
    const result = await executeHermesBridgeTask({
      config: resolveHermesBridgeConfig({
        enabled: true,
        allowedTasks: ["agents.ask_team"],
        allowedTools: [],
      }),
      request: request({
        requestId: "team-dry-run",
        taskId: "agents.ask_team",
        intent: "請 OpenClaw agent 團隊協助分析目前 Hermes bridge 狀態，但只做 dry-run。",
        allowedTools: [],
        dryRun: true,
        input: {
          team: "openclaw",
          question: "為何 Hermes 還無法呼叫 OpenClaw agent 團隊？",
        },
      }),
    });

    expect(result).toMatchObject({
      ok: true,
      requestId: "team-dry-run",
      taskId: "agents.ask_team",
      mode: "mock",
      status: "succeeded",
      summary: "Dry-run completed. No OpenClaw agents were started.",
      output: {
        team: "openclaw",
        question: "為何 Hermes 還無法呼叫 OpenClaw agent 團隊？",
        dryRun: true,
        agentsStarted: false,
        sideEffectsPerformed: false,
      },
    });
  });

  it("requires confirmation for dangerous mock-only task templates", async () => {
    const result = await executeHermesBridgeTask({
      config: resolveHermesBridgeConfig({
        enabled: true,
        allowedTasks: ["message.send"],
        allowedTools: ["telegram.send"],
      }),
      request: request({
        taskId: "message.send",
        allowedTools: ["telegram.send"],
        input: { body: "do not send" },
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      status: "needs_confirmation",
      error: { type: "confirmation_required" },
    });
  });

  it("blocks templates when required tools are not allowlisted by config and request", async () => {
    const result = await executeHermesBridgeTask({
      config: resolveHermesBridgeConfig({
        enabled: true,
        allowedTasks: ["message.send"],
      }),
      request: request({
        taskId: "message.send",
        requiresConfirmation: true,
        input: { body: "do not send" },
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      status: "blocked",
      error: { type: "tool_not_allowed" },
    });
  });

  it("returns only a preview for confirmed message.send dry-run requests", async () => {
    const result = await executeHermesBridgeTask({
      config: resolveHermesBridgeConfig({
        enabled: true,
        allowedTasks: ["message.send"],
        allowedTools: ["telegram.send"],
      }),
      request: request({
        taskId: "message.send",
        requiresConfirmation: true,
        allowedTools: ["telegram.send"],
        dryRun: true,
        input: {
          channel: "telegram",
          recipient: "@kj",
          body: "preview only",
        },
      }),
    });

    expect(result).toMatchObject({
      ok: true,
      status: "succeeded",
      mode: "mock",
      output: {
        preview: {
          channel: "telegram",
          recipient: "@kj",
          body: "preview only",
          wouldSend: false,
        },
      },
    });
  });

  it("executes the Protocol v2 read-only browser template through a dedicated subagent", async () => {
    dispatchGatewayMethod
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          config: {
            browser: {
              profiles: {
                "hermes-readonly": {
                  driver: "openclaw",
                  color: "#FF4500",
                },
              },
            },
            agents: {
              list: [
                {
                  id: "missioncrew-browser-readonly",
                  tools: {
                    allow: ["session_status"],
                    deny: [
                      "apply_patch",
                      "edit",
                      "exec",
                      "gateway",
                      "message",
                      "nodes",
                      "process",
                      "read",
                      "write",
                    ],
                  },
                },
              ],
            },
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          targetId: "tab-1",
          title: "Example Domain",
          url: "https://example.com/",
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          targetId: "tab-1",
          url: "https://example.com/",
          snapshot: "Example Domain",
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        payload: { ok: true },
      });
    const subagent = {
      run: vi.fn(async (params: Parameters<PluginRuntime["subagent"]["run"]>[0]) => ({
        runId: params.idempotencyKey ?? "missing-idempotency-key",
      })),
      waitForRun: vi.fn().mockResolvedValue({ status: "ok", terminal: true }),
      getSessionMessages: vi.fn().mockResolvedValue({
        messages: [
          {
            role: "assistant",
            content:
              '{"url":"https://example.com/","title":"Example Domain","snapshotExcerpt":"Example Domain","sideEffectsPerformed":false}',
          },
        ],
      }),
      getSession: vi.fn(),
      deleteSession: vi.fn(),
    } satisfies PluginRuntime["subagent"];
    const result = await executeHermesBridgeTask({
      config: resolveHermesBridgeConfig({
        enabled: true,
        mode: "live",
        hermesMode: "real",
        allowedTasks: ["openclaw.browser.read_snapshot"],
        allowedTools: ["browser.read"],
      }),
      subagent,
      request: request({
        protocolVersion: "2.0",
        taskId: "openclaw.browser.read_snapshot",
        idempotencyKey: "attempt-1",
        dryRun: false,
        allowedTools: ["browser.read"],
        input: { url: "https://example.com/" },
        identity: {
          delegationId: "delegation-1",
          attemptId: "attempt-1",
          contractFingerprint: "sha256:contract",
          project: "hub_ops",
          topicId: "readonly-browser",
        },
        routing: {
          executorBackend: "openclaw",
          executorProfile: "browser-readonly",
          backendAgentId: "missioncrew-browser-readonly",
        },
        policy: {
          externalEffectBudget: 0,
          workspacePolicy: "dedicated",
          sessionPolicy: "ephemeral",
          credentialRefs: [],
        },
      }),
    });

    expect(result).toMatchObject({
      ok: true,
      protocolVersion: "2.0",
      mode: "live",
      executionIdentity: {
        delegationId: "delegation-1",
        attemptId: "attempt-1",
        contractFingerprint: "sha256:contract",
      },
      backendExecution: {
        executorBackend: "openclaw",
        backendRunId: expect.stringMatching(/^attempt-1:[a-f0-9]{16}$/),
        backendAgentId: "missioncrew-browser-readonly",
      },
      output: {
        evidence: {
          requestedUrl: "https://example.com/",
          externalEffectBudget: 0,
          sideEffectsPerformed: false,
        },
      },
    });
    expect(subagent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: expect.stringContaining("agent:missioncrew-browser-readonly:"),
        deliver: false,
        toolsAllow: [],
        disableTools: true,
        idempotencyKey: expect.stringMatching(/^attempt-1:[a-f0-9]{16}$/),
      }),
    );
    expect(dispatchGatewayMethod).toHaveBeenCalledTimes(4);
    for (const [method, params] of dispatchGatewayMethod.mock.calls) {
      if (method === "browser.request") {
        expect(params.query).toMatchObject({ profile: "hermes-readonly" });
      }
    }
    expect(dispatchGatewayMethod).toHaveBeenNthCalledWith(
      1,
      "config.get",
      {},
      expect.objectContaining({ expectFinal: true }),
    );
    expect(dispatchGatewayMethod).toHaveBeenNthCalledWith(
      2,
      "browser.request",
      expect.objectContaining({ method: "POST", path: "/tabs/open" }),
      expect.objectContaining({ expectFinal: true }),
    );
    expect(dispatchGatewayMethod).toHaveBeenNthCalledWith(
      3,
      "browser.request",
      expect.objectContaining({ method: "GET", path: "/snapshot" }),
      expect.objectContaining({ expectFinal: true }),
    );
    expect(dispatchGatewayMethod).toHaveBeenNthCalledWith(
      4,
      "browser.request",
      expect.objectContaining({ method: "DELETE", path: "/tabs/tab-1" }),
      expect.objectContaining({ expectFinal: true }),
    );
    expect(subagent.deleteSession).toHaveBeenCalledOnce();
    expect(subagent.deleteSession).toHaveBeenCalledWith({
      sessionKey: expect.stringContaining("agent:missioncrew-browser-readonly:"),
    });
  });

  it.each([
    [
      "an extra reviewer output key",
      [
        {
          role: "assistant",
          content:
            '{"url":"https://example.com/","title":"Example Domain","snapshotExcerpt":"Example Domain","sideEffectsPerformed":false,"extra":"not-allowed"}',
        },
      ],
    ],
    [
      "a reviewer tool transcript",
      [
        {
          role: "assistant",
          content: [{ type: "tool_call", name: "session_status" }],
        },
        { role: "assistant", content: validReviewerResult },
      ],
    ],
  ])("fails closed on %s", async (_case, messages) => {
    mockSuccessfulBrowser("tab-review-policy");
    const subagent = successfulReadonlySubagent(messages);

    const result = await executeHermesBridgeTask({
      config: readonlyConfig(),
      subagent,
      request: readonlyRequest(`attempt-review-${String(_case).replaceAll(" ", "-")}`),
    });

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      error: { type: "task_execution_failed" },
    });
    expect(subagent.deleteSession).toHaveBeenCalledOnce();
    expect(dispatchGatewayMethod).toHaveBeenLastCalledWith(
      "browser.request",
      expect.objectContaining({
        method: "DELETE",
        path: "/tabs/tab-review-policy",
      }),
      expect.objectContaining({ expectFinal: true }),
    );
  });

  it("uses generation-scoped resources when a recovered lease executes", async () => {
    let tabListCount = 0;
    const attemptId = "attempt-recovered-lease";
    dispatchGatewayMethod.mockImplementation(async (method, params) => {
      if (method === "config.get") {
        return { ok: true, payload: readonlyAgentConfigPayload() };
      }
      if (params.path === "/tabs") {
        tabListCount += 1;
        return {
          ok: true,
          payload: {
            tabs: [
              {
                targetId: "tab-stale",
                label: readonlyTabLabel(attemptId),
              },
            ],
          },
        };
      }
      if (params.path === "/tabs/open") {
        return {
          ok: true,
          payload: {
            targetId: "tab-fresh",
            title: "Example Domain",
            url: "https://example.com/",
          },
        };
      }
      if (params.path === "/snapshot") {
        return {
          ok: true,
          payload: {
            targetId: "tab-fresh",
            url: "https://example.com/",
            snapshot: "Example Domain",
          },
        };
      }
      if (params.method === "DELETE") {
        return { ok: true, payload: { ok: true } };
      }
      throw new Error(`unexpected ${method} ${params.path}`);
    });
    const subagent = successfulReadonlySubagent();

    const result = await executeHermesBridgeTask({
      config: readonlyConfig(),
      subagent,
      recoveredLease: true,
      request: readonlyRequest(attemptId),
    });

    expect(result.ok).toBe(true);
    expect(tabListCount).toBe(0);
    const browserCalls = dispatchGatewayMethod.mock.calls
      .filter(([method]) => method === "browser.request")
      .map(([, params]) => `${params.method} ${params.path}`);
    expect(browserCalls).toEqual(["POST /tabs/open", "GET /snapshot", "DELETE /tabs/tab-fresh"]);
    expect(subagent.deleteSession).toHaveBeenCalledOnce();
  });

  it("uses different tab labels and session keys for different start keys", async () => {
    const cleanupStore = new MemoryHermesBridgeIdempotencyStore();
    const subagent = successfulReadonlySubagent();
    const firstRequest = readonlyRequest("attempt-generation-scope-1");
    const secondRequest = readonlyRequest("attempt-generation-scope-2");

    mockSuccessfulBrowser("tab-generation-1");
    const first = await executeHermesBridgeTask({
      config: readonlyConfig(),
      subagent,
      cleanupStore,
      request: firstRequest,
    });
    mockSuccessfulBrowser("tab-generation-2");
    const second = await executeHermesBridgeTask({
      config: readonlyConfig(),
      subagent,
      cleanupStore,
      request: secondRequest,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const labels = dispatchGatewayMethod.mock.calls
      .filter(([method, params]) => method === "browser.request" && params.path === "/tabs/open")
      .map(([, params]) => params.body?.label);
    expect(labels).toHaveLength(2);
    expect(labels[0]).toMatch(/^hermes-readonly-[a-f0-9]{24}-[a-f0-9]{16}$/);
    expect(labels[1]).toMatch(/^hermes-readonly-[a-f0-9]{24}-[a-f0-9]{16}$/);
    expect(labels[0]).not.toBe(labels[1]);
    const sessionKeys = subagent.run.mock.calls.map(([params]) => params.sessionKey);
    expect(sessionKeys).toHaveLength(2);
    expect(sessionKeys[0]).not.toBe(sessionKeys[1]);
  });

  it("bounds subagent execution and cleanup with one end-to-end deadline", async () => {
    mockSuccessfulBrowser("tab-deadline");
    const subagent = successfulReadonlySubagent();
    subagent.run.mockImplementation(() => new Promise(() => undefined));
    const startedAt = Date.now();

    const result = await executeHermesBridgeTask({
      config: resolveHermesBridgeConfig({
        enabled: true,
        mode: "live",
        hermesMode: "real",
        allowedTasks: ["openclaw.browser.read_snapshot"],
        allowedTools: ["browser.read"],
        maxLiveRuntimeSeconds: 1,
      }),
      subagent,
      request: readonlyRequest("attempt-deadline"),
    });

    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      error: { type: "task_execution_failed" },
    });
    expect(dispatchGatewayMethod).toHaveBeenLastCalledWith(
      "browser.request",
      expect.objectContaining({
        method: "DELETE",
        path: "/tabs/tab-deadline",
      }),
      expect.objectContaining({ expectFinal: true }),
    );
  });

  it("retains durable cleanup when the reviewer run has not proven termination", async () => {
    mockSuccessfulBrowser("tab-reviewer-timeout");
    const cleanupStore = new MemoryHermesBridgeIdempotencyStore();
    const subagent = successfulReadonlySubagent();
    subagent.waitForRun.mockResolvedValue({ status: "timeout", terminal: false });

    const result = await executeHermesBridgeTask({
      config: readonlyConfig(),
      subagent,
      cleanupStore,
      request: readonlyRequest("attempt-reviewer-timeout"),
    });

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      error: { type: "task_execution_failed" },
    });
    expect(subagent.deleteSession).toHaveBeenCalledOnce();
    expect(cleanupStore.listDueCleanup(Number.MAX_SAFE_INTEGER)).toEqual([
      expect.objectContaining({
        backendRunId: expect.stringMatching(/^attempt-reviewer-timeout:[a-f0-9]{16}$/),
        generation: expect.any(String),
      }),
    ]);
  });

  it("keeps the admission key separate from the reviewer run ID returned by admission", async () => {
    mockSuccessfulBrowser("tab-returned-run-id");
    const cleanupStore = new MemoryHermesBridgeIdempotencyStore();
    const subagent = successfulReadonlySubagent();
    subagent.run.mockResolvedValueOnce({ runId: "actual-returned-reviewer-run" });

    const result = await executeHermesBridgeTask({
      config: readonlyConfig(),
      subagent,
      cleanupStore,
      request: readonlyRequest("attempt-returned-run-id"),
    });

    expect(result).toMatchObject({
      ok: true,
      status: "succeeded",
      backendExecution: {
        backendRunId: "actual-returned-reviewer-run",
      },
    });
    expect(subagent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^attempt-returned-run-id:[a-f0-9]{16}$/),
      }),
    );
    expect(cleanupStore.listDueCleanup(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it("recovers a failed start by resubmitting the exact idempotent reviewer run", async () => {
    mockSuccessfulBrowser("tab-pre-admission-failure");
    const cleanupStore = new MemoryHermesBridgeIdempotencyStore();
    const subagent = successfulReadonlySubagent();
    subagent.run.mockRejectedValueOnce(new Error("Gateway rejected before admission"));

    const result = await executeHermesBridgeTask({
      config: readonlyConfig(),
      subagent,
      cleanupStore,
      request: readonlyRequest("attempt-pre-admission-failure"),
    });

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      error: { type: "task_execution_failed" },
    });
    expect(cleanupStore.listDueCleanup(Number.MAX_SAFE_INTEGER)).toEqual([
      expect.objectContaining({
        backendAdmissionKey: expect.stringMatching(/^attempt-pre-admission-failure:[a-f0-9]{16}$/),
        backendStartAttempted: true,
      }),
    ]);

    subagent.waitForRun.mockResolvedValue({ status: "ok", terminal: true });
    dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: { tabs: [] } });
    const completed = await sweepHermesBridgeCleanupObligations({
      store: cleanupStore,
      subagent,
      config: readonlyConfig(),
      nowMs: Number.MAX_SAFE_INTEGER,
    });

    expect(completed).toBe(1);
    expect(cleanupStore.listDueCleanup(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it("returns retryable cleanup-store-unavailable before creating resources", async () => {
    dispatchGatewayMethod.mockResolvedValueOnce({
      ok: true,
      payload: readonlyAgentConfigPayload(),
    });
    const cleanupStore = new MemoryHermesBridgeIdempotencyStore();
    vi.spyOn(cleanupStore, "registerCleanup").mockImplementation(() => {
      throw new Error("database is busy");
    });
    const subagent = successfulReadonlySubagent();

    const result = await executeHermesBridgeTask({
      config: readonlyConfig(),
      subagent,
      cleanupStore,
      request: readonlyRequest("attempt-cleanup-store-busy"),
    });

    expect(result).toMatchObject({
      ok: false,
      status: "running",
      error: { type: "cleanup_store_unavailable" },
    });
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
    expect(subagent.run).not.toHaveBeenCalled();
  });

  it("fails closed when the reviewer transcript reaches the audit cap", async () => {
    mockSuccessfulBrowser("tab-audit-cap");
    const subagent = successfulReadonlySubagent(
      Array.from({ length: 1_000 }, () => ({
        role: "assistant",
        content: validReviewerResult,
      })),
    );

    const result = await executeHermesBridgeTask({
      config: readonlyConfig(),
      subagent,
      request: readonlyRequest("attempt-audit-cap"),
    });

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      error: { type: "task_execution_failed" },
    });
    expect(subagent.getSessionMessages).toHaveBeenCalledWith({
      sessionKey: expect.any(String),
      limit: 1_000,
    });
  });

  it("sweeps a durable ambiguous-creation cleanup obligation", async () => {
    const attemptId = "attempt-durable-sweep";
    const pendingRequest = readonlyRequest(attemptId);
    const cleanupStore = new MemoryHermesBridgeIdempotencyStore();
    cleanupStore.registerCleanup({
      idempotencyKey: pendingRequest.idempotencyKey,
      requestHash: "request-hash",
      generation: "generation-durable-sweep",
      request: pendingRequest,
      dueAt: 0,
    });
    let staleTabPresent = true;
    dispatchGatewayMethod.mockImplementation(async (method, params) => {
      if (method !== "browser.request") {
        throw new Error(`unexpected method ${method}`);
      }
      if (params.path === "/tabs") {
        return {
          ok: true,
          payload: {
            tabs: staleTabPresent
              ? [
                  {
                    targetId: "tab-durable-stale",
                    label: readonlyScopedTabLabel(attemptId, "generation-durable-sweep"),
                  },
                ]
              : [],
          },
        };
      }
      if (params.method === "DELETE") {
        staleTabPresent = false;
        return { ok: true, payload: { ok: true } };
      }
      throw new Error(`unexpected browser path ${params.path}`);
    });
    const subagent = successfulReadonlySubagent();

    const completed = await sweepHermesBridgeCleanupObligations({
      store: cleanupStore,
      subagent,
      config: resolveHermesBridgeConfig({
        enabled: true,
        mode: "live",
        hermesMode: "real",
        allowedTasks: ["openclaw.browser.read_snapshot"],
        allowedTools: ["browser.read"],
        maxLiveRuntimeSeconds: 1,
      }),
      nowMs: 1,
    });

    expect(completed).toBe(1);
    expect(cleanupStore.listDueCleanup(Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(subagent.deleteSession).toHaveBeenCalledTimes(1);
    expect(
      dispatchGatewayMethod.mock.calls.filter(
        ([method, params]) =>
          method === "browser.request" &&
          params.method === "DELETE" &&
          params.path === "/tabs/tab-durable-stale",
      ),
    ).toHaveLength(1);
  });

  it("keeps sweeping until the exact reviewer run is proven terminal", async () => {
    const attemptId = "attempt-durable-run-terminal";
    const pendingRequest = readonlyRequest(attemptId);
    const cleanupStore = new MemoryHermesBridgeIdempotencyStore();
    cleanupStore.registerCleanup({
      idempotencyKey: pendingRequest.idempotencyKey,
      requestHash: "request-hash-terminal",
      generation: "generation-run-terminal",
      backendAdmissionKey: "admission-generation-terminal",
      backendRunId: "run-generation-terminal",
      backendStartAttempted: true,
      backendSubmission: readonlyBackendSubmission("run-generation-terminal"),
      request: pendingRequest,
      dueAt: 0,
    });
    dispatchGatewayMethod.mockResolvedValue({
      ok: true,
      payload: { tabs: [] },
    });
    const subagent = successfulReadonlySubagent();
    subagent.run.mockResolvedValue({ runId: "run-generation-terminal" });
    subagent.waitForRun
      .mockResolvedValueOnce({ status: "timeout", terminal: false })
      .mockResolvedValueOnce({ status: "timeout", terminal: true });

    const completed = await sweepHermesBridgeCleanupObligations({
      store: cleanupStore,
      subagent,
      config: readonlyConfig(),
      nowMs: 1,
    });

    expect(completed).toBe(1);
    expect(cleanupStore.listDueCleanup(Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(subagent.waitForRun).toHaveBeenCalledTimes(2);
    for (const [params] of subagent.waitForRun.mock.calls) {
      expect(params.runId).toBe("run-generation-terminal");
    }
  });

  it("persists cancellation before aborting an overdue browser run", async () => {
    const attemptId = "attempt-durable-run-abort";
    const pendingRequest = readonlyRequest(attemptId);
    const cleanupStore = new MemoryHermesBridgeIdempotencyStore();
    cleanupStore.registerCleanup({
      idempotencyKey: pendingRequest.idempotencyKey,
      requestHash: "request-hash-abort",
      generation: "generation-run-abort",
      backendAdmissionKey: "admission-generation-abort",
      backendRunId: "run-generation-abort",
      backendStartAttempted: true,
      backendSubmission: readonlyBackendSubmission("run-generation-abort"),
      request: pendingRequest,
      dueAt: 0,
    });
    dispatchGatewayMethod.mockResolvedValue({
      ok: true,
      payload: { tabs: [] },
    });
    const subagent = successfulReadonlySubagent();
    subagent.run.mockResolvedValue({ runId: "run-generation-abort" });
    subagent.waitForRun
      .mockResolvedValueOnce({ status: "timeout", terminal: false })
      .mockResolvedValueOnce({ status: "timeout", terminal: false })
      .mockResolvedValueOnce({ status: "timeout", terminal: false })
      .mockImplementationOnce(async () => {
        expect(
          cleanupStore.getCleanup(pendingRequest.idempotencyKey)?.auditedTerminal,
        ).toMatchObject({
          output: {
            evidence: {
              cancellationRequested: true,
              terminationProven: false,
              sessionCleaned: false,
            },
          },
        });
        expect(subagent.deleteSession).toHaveBeenCalledTimes(1);
        return { status: "timeout", terminal: true };
      });

    const completed = await sweepHermesBridgeCleanupObligations({
      store: cleanupStore,
      subagent,
      config: readonlyConfig(),
      nowMs: 1,
    });

    expect(completed).toBe(1);
    expect(cleanupStore.getCleanup(pendingRequest.idempotencyKey)).toBeUndefined();
    expect(cleanupStore.getCleanupTerminal(pendingRequest.idempotencyKey)).toMatchObject({
      backendRunId: "run-generation-abort",
      output: {
        bridgeStatus: "blocked",
        evidence: {
          cancellationRequested: true,
          terminationProven: true,
          sessionCleaned: true,
          browserTabsCleaned: true,
        },
      },
    });
  });

  it("fails before resource creation while an older cleanup generation is actively claimed", async () => {
    const pendingRequest = readonlyRequest("attempt-cleanup-claim-race");
    const pendingRequestHash = hashHermesBridgeRequest(pendingRequest);
    const cleanupStore = new MemoryHermesBridgeIdempotencyStore();
    const nowMs = Date.now();
    cleanupStore.registerCleanup(
      {
        idempotencyKey: pendingRequest.idempotencyKey,
        requestHash: pendingRequestHash,
        generation: "older-generation",
        request: pendingRequest,
        dueAt: nowMs,
      },
      nowMs,
    );
    expect(
      cleanupStore.claimCleanup(
        pendingRequest.idempotencyKey,
        pendingRequestHash,
        "older-generation",
        {
          ownerId: "active-sweeper",
          leaseMs: 30_000,
          nowMs,
        },
      ),
    ).toBe(true);
    const subagent = successfulReadonlySubagent();

    const result = await executeHermesBridgeTask({
      config: readonlyConfig(),
      subagent,
      cleanupStore,
      request: pendingRequest,
    });

    expect(result).toMatchObject({
      ok: false,
      status: "running",
      error: {
        type: "cleanup_in_progress",
        message: expect.stringContaining("earlier execution generation"),
      },
    });
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
    expect(subagent.run).not.toHaveBeenCalled();
  });

  it("fails closed when the backend agent omits its required static tool allowlist", async () => {
    dispatchGatewayMethod.mockResolvedValueOnce({
      ok: true,
      payload: {
        config: {
          browser: {
            profiles: {
              "hermes-readonly": {
                driver: "openclaw",
                color: "#FF4500",
              },
            },
          },
          agents: {
            list: [
              {
                id: "missioncrew-browser-readonly",
                tools: {
                  deny: [
                    "apply_patch",
                    "edit",
                    "exec",
                    "gateway",
                    "message",
                    "nodes",
                    "process",
                    "read",
                    "write",
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const subagent = {
      run: vi.fn(),
      waitForRun: vi.fn(),
      getSessionMessages: vi.fn(),
      getSession: vi.fn(),
      deleteSession: vi.fn(),
    } satisfies PluginRuntime["subagent"];
    const result = await executeHermesBridgeTask({
      config: resolveHermesBridgeConfig({
        enabled: true,
        mode: "live",
        hermesMode: "real",
        allowedTasks: ["openclaw.browser.read_snapshot"],
        allowedTools: ["browser.read"],
      }),
      subagent,
      request: request({
        protocolVersion: "2.0",
        taskId: "openclaw.browser.read_snapshot",
        idempotencyKey: "attempt-policy",
        dryRun: false,
        allowedTools: ["browser.read"],
        input: { url: "https://example.com/" },
        identity: {
          delegationId: "delegation-1",
          attemptId: "attempt-policy",
          contractFingerprint: "sha256:contract",
          project: "hub_ops",
          topicId: "readonly-browser",
        },
        routing: {
          executorBackend: "openclaw",
          executorProfile: "browser-readonly",
          backendAgentId: "missioncrew-browser-readonly",
        },
        policy: {
          externalEffectBudget: 0,
          workspacePolicy: "dedicated",
          sessionPolicy: "ephemeral",
          credentialRefs: [],
        },
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      error: { type: "task_execution_failed" },
    });
    expect(dispatchGatewayMethod).toHaveBeenCalledOnce();
    expect(subagent.run).not.toHaveBeenCalled();
  });

  it("rejects reviewer output that differs from captured browser evidence", async () => {
    dispatchGatewayMethod
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          config: {
            browser: {
              profiles: {
                "hermes-readonly": {
                  driver: "openclaw",
                  color: "#FF4500",
                },
              },
            },
            agents: {
              list: [
                {
                  id: "missioncrew-browser-readonly",
                  tools: {
                    allow: ["session_status"],
                    deny: [
                      "apply_patch",
                      "edit",
                      "exec",
                      "gateway",
                      "message",
                      "nodes",
                      "process",
                      "read",
                      "write",
                    ],
                  },
                },
              ],
            },
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          targetId: "tab-2",
          title: "Example Domain",
          url: "https://example.com/",
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          targetId: "tab-2",
          url: "https://example.com/",
          snapshot: "Example Domain",
        },
      })
      .mockResolvedValueOnce({ ok: true, payload: { ok: true } });
    const subagent = {
      run: vi.fn(async (params: Parameters<PluginRuntime["subagent"]["run"]>[0]) => ({
        runId: params.idempotencyKey ?? "missing-idempotency-key",
      })),
      waitForRun: vi.fn().mockResolvedValue({ status: "ok", terminal: true }),
      getSessionMessages: vi.fn().mockResolvedValue({
        messages: [{ role: "assistant", content: '{"sideEffectsPerformed":false}' }],
      }),
      getSession: vi.fn(),
      deleteSession: vi.fn(),
    } satisfies PluginRuntime["subagent"];
    const result = await executeHermesBridgeTask({
      config: resolveHermesBridgeConfig({
        enabled: true,
        mode: "live",
        hermesMode: "real",
        allowedTasks: ["openclaw.browser.read_snapshot"],
        allowedTools: ["browser.read"],
      }),
      subagent,
      request: request({
        protocolVersion: "2.0",
        taskId: "openclaw.browser.read_snapshot",
        idempotencyKey: "attempt-review",
        dryRun: false,
        allowedTools: ["browser.read"],
        input: { url: "https://example.com/" },
        identity: {
          delegationId: "delegation-1",
          attemptId: "attempt-review",
          contractFingerprint: "sha256:contract",
          project: "hub_ops",
          topicId: "readonly-browser",
        },
        routing: {
          executorBackend: "openclaw",
          executorProfile: "browser-readonly",
          backendAgentId: "missioncrew-browser-readonly",
        },
        policy: {
          externalEffectBudget: 0,
          workspacePolicy: "dedicated",
          sessionPolicy: "ephemeral",
          credentialRefs: [],
        },
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      error: { type: "task_execution_failed" },
    });
    expect(subagent.deleteSession).toHaveBeenCalledOnce();
    expect(dispatchGatewayMethod).toHaveBeenCalledTimes(4);
  });

  it("rejects a snapshot that does not explicitly attest its current URL", async () => {
    dispatchGatewayMethod
      .mockResolvedValueOnce({ ok: true, payload: readonlyAgentConfigPayload() })
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          targetId: "tab-missing-url",
          title: "Example Domain",
          url: "https://example.com/",
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          targetId: "tab-missing-url",
          snapshot: "Example Domain",
        },
      })
      .mockResolvedValueOnce({ ok: true, payload: { ok: true } });
    const subagent = {
      run: vi.fn(),
      waitForRun: vi.fn(),
      getSessionMessages: vi.fn(),
      getSession: vi.fn(),
      deleteSession: vi.fn(),
    } satisfies PluginRuntime["subagent"];

    const result = await executeHermesBridgeTask({
      config: readonlyConfig(),
      subagent,
      request: readonlyRequest("attempt-missing-url"),
    });

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      error: { type: "task_execution_failed" },
    });
    expect(subagent.run).not.toHaveBeenCalled();
    expect(dispatchGatewayMethod).toHaveBeenCalledTimes(4);
    expect(dispatchGatewayMethod).toHaveBeenLastCalledWith(
      "browser.request",
      expect.objectContaining({
        method: "DELETE",
        path: "/tabs/tab-missing-url",
      }),
      expect.any(Object),
    );
  });

  it("rejects a snapshot returned for a different browser target", async () => {
    dispatchGatewayMethod
      .mockResolvedValueOnce({ ok: true, payload: readonlyAgentConfigPayload() })
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          targetId: "tab-opened",
          title: "Example Domain",
          url: "https://example.com/",
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          targetId: "tab-stale",
          url: "https://example.com/",
          snapshot: "Example Domain",
        },
      })
      .mockResolvedValueOnce({ ok: true, payload: { ok: true } });
    const subagent = successfulReadonlySubagent();

    const result = await executeHermesBridgeTask({
      config: readonlyConfig(),
      subagent,
      request: readonlyRequest("attempt-target-mismatch"),
    });

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      error: { type: "task_execution_failed" },
    });
    expect(subagent.run).not.toHaveBeenCalled();
  });

  it("rejects browser evidence without a non-empty captured title", async () => {
    dispatchGatewayMethod
      .mockResolvedValueOnce({ ok: true, payload: readonlyAgentConfigPayload() })
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          targetId: "tab-missing-title",
          url: "https://example.com/",
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          targetId: "tab-missing-title",
          url: "https://example.com/",
          snapshot: "Example Domain",
        },
      })
      .mockResolvedValueOnce({ ok: true, payload: { ok: true } });
    const subagent = successfulReadonlySubagent();

    const result = await executeHermesBridgeTask({
      config: readonlyConfig(),
      subagent,
      request: readonlyRequest("attempt-missing-title"),
    });

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      error: { type: "task_execution_failed" },
    });
    expect(subagent.run).not.toHaveBeenCalled();
  });

  it("reconciles a correlated tab after an ambiguous open failure", async () => {
    const cleanupStore = new MemoryHermesBridgeIdempotencyStore();
    let tabLabel = "";
    dispatchGatewayMethod.mockImplementation(async (method, params) => {
      if (method === "config.get") {
        return { ok: true, payload: readonlyAgentConfigPayload() };
      }
      if (method !== "browser.request") {
        throw new Error(`unexpected method ${method}`);
      }
      if (params.path === "/tabs/open") {
        tabLabel = String(params.body?.label ?? "");
        return { ok: false, error: { message: "open response timed out" } };
      }
      if (params.path === "/tabs") {
        return {
          ok: true,
          payload: {
            running: true,
            tabs: [{ targetId: "tab-ambiguous", label: tabLabel }],
          },
        };
      }
      if (params.path === "/tabs/tab-ambiguous") {
        return { ok: true, payload: { ok: true } };
      }
      throw new Error(`unexpected browser path ${params.path}`);
    });
    const subagent = {
      run: vi.fn(),
      waitForRun: vi.fn(),
      getSessionMessages: vi.fn(),
      getSession: vi.fn(),
      deleteSession: vi.fn(),
    } satisfies PluginRuntime["subagent"];

    const result = await executeHermesBridgeTask({
      config: readonlyConfig(),
      subagent,
      cleanupStore,
      request: readonlyRequest("attempt-ambiguous-open"),
    });

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      error: { type: "task_execution_failed" },
    });
    expect(tabLabel).toMatch(/^hermes-readonly-[a-f0-9]{24}-[a-f0-9]{16}$/);
    expect(dispatchGatewayMethod).toHaveBeenCalledTimes(8);
    expect(
      dispatchGatewayMethod.mock.calls.filter(
        ([method, params]) =>
          method === "browser.request" &&
          params.method === "DELETE" &&
          params.path === "/tabs/tab-ambiguous",
      ),
    ).toHaveLength(3);
    expect(subagent.run).not.toHaveBeenCalled();
    expect(cleanupStore.listDueCleanup(Number.MAX_SAFE_INTEGER)).toHaveLength(1);
  });

  it("deletes the generation-scoped session after an ambiguous subagent start failure", async () => {
    dispatchGatewayMethod
      .mockResolvedValueOnce({ ok: true, payload: readonlyAgentConfigPayload() })
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          targetId: "tab-session-ambiguous",
          title: "Example Domain",
          url: "https://example.com/",
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          targetId: "tab-session-ambiguous",
          url: "https://example.com/",
          snapshot: "Example Domain",
        },
      })
      .mockResolvedValueOnce({ ok: true, payload: { ok: true } });
    const subagent = {
      run: vi.fn().mockRejectedValue(new Error("subagent response timed out")),
      waitForRun: vi.fn(),
      getSessionMessages: vi.fn(),
      getSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    } satisfies PluginRuntime["subagent"];
    const result = await executeHermesBridgeTask({
      config: readonlyConfig(),
      subagent,
      request: readonlyRequest("attempt-ambiguous-session"),
    });

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      error: { type: "task_execution_failed" },
    });
    expect(subagent.deleteSession).toHaveBeenCalledTimes(4);
    expect(subagent.deleteSession).toHaveBeenCalledWith({
      sessionKey: expect.stringContaining("attempt-ambiguous-session"),
    });
  });

  it("fails closed when a live browser request lacks Protocol v2 zero-effect policy", async () => {
    const subagent = {
      run: vi.fn(),
      waitForRun: vi.fn(),
      getSessionMessages: vi.fn(),
      getSession: vi.fn(),
      deleteSession: vi.fn(),
    } satisfies PluginRuntime["subagent"];
    const result = await executeHermesBridgeTask({
      config: resolveHermesBridgeConfig({
        enabled: true,
        mode: "live",
        allowedTasks: ["openclaw.browser.read_snapshot"],
        allowedTools: ["browser.read"],
      }),
      subagent,
      request: request({
        protocolVersion: "2.0",
        taskId: "openclaw.browser.read_snapshot",
        idempotencyKey: "attempt-1",
        dryRun: false,
        allowedTools: ["browser.read"],
        input: { url: "https://example.com/" },
        identity: {
          delegationId: "delegation-1",
          attemptId: "attempt-1",
          contractFingerprint: "sha256:contract",
          project: "hub_ops",
          topicId: "readonly-browser",
        },
        routing: {
          executorBackend: "openclaw",
          executorProfile: "wrong-profile",
          backendAgentId: "missioncrew-browser-readonly",
        },
        policy: {
          externalEffectBudget: 0,
          workspacePolicy: "dedicated",
          sessionPolicy: "ephemeral",
          credentialRefs: [],
        },
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      error: { type: "task_execution_failed" },
    });
    expect(subagent.run).not.toHaveBeenCalled();
  });

  it("rejects every URL except the fixed zero-effect pilot target", async () => {
    const subagent = {
      run: vi.fn(),
      waitForRun: vi.fn(),
      getSessionMessages: vi.fn(),
      getSession: vi.fn(),
      deleteSession: vi.fn(),
    } satisfies PluginRuntime["subagent"];
    const result = await executeHermesBridgeTask({
      config: resolveHermesBridgeConfig({
        enabled: true,
        mode: "live",
        hermesMode: "real",
        allowedTasks: ["openclaw.browser.read_snapshot"],
        allowedTools: ["browser.read"],
      }),
      subagent,
      request: request({
        protocolVersion: "2.0",
        taskId: "openclaw.browser.read_snapshot",
        idempotencyKey: "attempt-private",
        dryRun: false,
        allowedTools: ["browser.read"],
        input: { url: "http://[fc00::1]/" },
        identity: {
          delegationId: "delegation-1",
          attemptId: "attempt-private",
          contractFingerprint: "sha256:contract",
          project: "hub_ops",
          topicId: "readonly-browser",
        },
        routing: {
          executorBackend: "openclaw",
          executorProfile: "browser-readonly",
          backendAgentId: "missioncrew-browser-readonly",
        },
        policy: {
          externalEffectBudget: 0,
          workspacePolicy: "dedicated",
          sessionPolicy: "ephemeral",
          credentialRefs: [],
        },
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      error: { type: "task_execution_failed" },
    });
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
    expect(subagent.run).not.toHaveBeenCalled();
  });

  it("rejects an idempotency key that is not the Protocol v2 attempt identity", async () => {
    const subagent = {
      run: vi.fn(),
      waitForRun: vi.fn(),
      getSessionMessages: vi.fn(),
      getSession: vi.fn(),
      deleteSession: vi.fn(),
    } satisfies PluginRuntime["subagent"];
    const result = await executeHermesBridgeTask({
      config: resolveHermesBridgeConfig({
        enabled: true,
        mode: "live",
        hermesMode: "real",
        allowedTasks: ["openclaw.browser.read_snapshot"],
        allowedTools: ["browser.read"],
      }),
      subagent,
      request: request({
        protocolVersion: "2.0",
        taskId: "openclaw.browser.read_snapshot",
        idempotencyKey: "different-key",
        dryRun: false,
        allowedTools: ["browser.read"],
        input: { url: "https://example.com/" },
        identity: {
          delegationId: "delegation-1",
          attemptId: "attempt-identity",
          contractFingerprint: "sha256:contract",
          project: "hub_ops",
          topicId: "readonly-browser",
        },
        routing: {
          executorBackend: "openclaw",
          executorProfile: "browser-readonly",
          backendAgentId: "missioncrew-browser-readonly",
        },
        policy: {
          externalEffectBudget: 0,
          workspacePolicy: "dedicated",
          sessionPolicy: "ephemeral",
          credentialRefs: [],
        },
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      error: { type: "task_execution_failed" },
    });
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
    expect(subagent.run).not.toHaveBeenCalled();
  });

  it("replays a completed browser snapshot from its terminal tombstone", async () => {
    const cleanupStore = new MemoryHermesBridgeIdempotencyStore();
    mockSuccessfulBrowser("tab-browser-terminal");
    const subagent = successfulReadonlySubagent();
    const browserRequest = readonlyRequest("attempt-browser-terminal");
    const audited = vi.spyOn(cleanupStore, "setCleanupAuditedTerminal");
    const completedCleanup = vi.spyOn(cleanupStore, "completeCleanup");

    const completed = await executeHermesBridgeTask({
      config: readonlyConfig(),
      request: browserRequest,
      subagent,
      cleanupStore,
    });
    expect(completed).toMatchObject({
      ok: true,
      status: "succeeded",
      output: { bridgeStatus: "succeeded" },
    });
    expect(cleanupStore.getCleanup("attempt-browser-terminal")).toBeUndefined();
    expect(cleanupStore.getCleanupTerminal("attempt-browser-terminal")).toMatchObject({
      output: { bridgeStatus: "succeeded" },
    });
    expect(audited).toHaveBeenCalledOnce();
    expect(audited.mock.invocationCallOrder[0]).toBeLessThan(
      subagent.deleteSession.mock.invocationCallOrder[0]!,
    );
    expect(subagent.deleteSession.mock.invocationCallOrder[0]).toBeLessThan(
      completedCleanup.mock.invocationCallOrder[0]!,
    );
    const browserCallCount = dispatchGatewayMethod.mock.calls.length;

    const replayed = await executeHermesBridgeTask({
      config: readonlyConfig(),
      request: browserRequest,
      subagent,
      cleanupStore,
    });
    expect(replayed).toMatchObject({
      ok: true,
      status: "succeeded",
      output: { bridgeStatus: "succeeded" },
    });
    expect(dispatchGatewayMethod).toHaveBeenCalledTimes(browserCallCount);
    expect(subagent.run).toHaveBeenCalledOnce();
  });

  it("polls and finalizes an exact admitted browser snapshot run", async () => {
    const cleanupStore = new MemoryHermesBridgeIdempotencyStore();
    const startRequest = readonlyRequest("attempt-browser-poll");
    const requestHash = hashHermesBridgeRequest(startRequest);
    const generation = "browser-poll-generation";
    const generationHash = createHash("sha256").update(generation).digest("hex").slice(0, 16);
    const identityHash = readonlyTabLabel("attempt-browser-poll").replace("hermes-readonly-", "");
    const sessionKey =
      `agent:missioncrew-browser-readonly:subagent:` +
      `hermes-attempt-browser-poll-${identityHash}-${generationHash}`;
    const backendRunId = "browser-poll-run";
    cleanupStore.registerCleanup({
      idempotencyKey: "attempt-browser-poll",
      requestHash,
      generation,
      backendAdmissionKey: "browser-poll-admission",
      backendRunId,
      backendStartAttempted: true,
      backendSubmission: {
        sessionKey,
        message: [
          "Review captured evidence.",
          JSON.stringify({
            url: "https://example.com/",
            title: "Example Domain",
            snapshotExcerpt: "Example Domain",
            targetId: "tab-browser-poll",
            externalEffectBudget: 0,
            sideEffectsPerformed: false,
          }),
        ].join("\n"),
        extraSystemPrompt: "Do not use tools.",
        lane: "hermes-bridge:test",
        lightContext: true,
        deliver: false,
        toolsAllow: [],
        disableTools: true,
      },
      request: startRequest,
      dueAt: Date.now(),
    });
    dispatchGatewayMethod
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          tabs: [
            {
              targetId: "tab-browser-poll",
              label: readonlyScopedTabLabel("attempt-browser-poll", generation),
            },
          ],
        },
      })
      .mockResolvedValueOnce({ ok: true, payload: { ok: true } });
    const subagent = successfulReadonlySubagent();
    const audited = vi.spyOn(cleanupStore, "setCleanupAuditedTerminal");
    const completedCleanup = vi.spyOn(cleanupStore, "completeCleanup");
    const pollRequest = request({
      protocolVersion: "2.0",
      taskId: "openclaw.browser.read_snapshot_poll",
      idempotencyKey: "attempt-browser-poll:poll:1",
      dryRun: false,
      allowedTools: ["browser.read"],
      input: {
        startIdempotencyKey: "attempt-browser-poll",
        backendRunId,
      },
      identity: startRequest.identity,
      routing: startRequest.routing,
      policy: startRequest.policy,
    });

    const polled = await executeHermesBridgeTask({
      config: readonlyConfig(["openclaw.browser.read_snapshot_poll"]),
      request: pollRequest,
      subagent,
      cleanupStore,
    });

    expect(polled).toMatchObject({
      ok: true,
      status: "succeeded",
      backendExecution: { backendRunId, sessionKey },
      output: {
        evidence: {
          terminal: true,
          sessionCleaned: true,
          browserTabsCleaned: true,
        },
        resultText: validReviewerResult,
      },
    });
    expect(subagent.waitForRun).toHaveBeenCalledWith({
      runId: backendRunId,
      timeoutMs: 1,
    });
    expect(subagent.deleteSession).toHaveBeenCalledWith({ sessionKey });
    expect(audited).toHaveBeenCalledOnce();
    expect(completedCleanup).toHaveBeenCalledOnce();
    expect(audited.mock.invocationCallOrder[0]).toBeLessThan(
      subagent.deleteSession.mock.invocationCallOrder[0]!,
    );
    expect(subagent.deleteSession.mock.invocationCallOrder[0]).toBeLessThan(
      completedCleanup.mock.invocationCallOrder[0]!,
    );
    expect(cleanupStore.getCleanup("attempt-browser-poll")).toBeUndefined();
    expect(cleanupStore.getCleanupTerminal("attempt-browser-poll")).toMatchObject({
      backendRunId,
      output: { bridgeStatus: "succeeded" },
    });
  });

  it("cancels an exact browser snapshot run and persists terminal cleanup evidence", async () => {
    const cleanupStore = new MemoryHermesBridgeIdempotencyStore();
    const startRequest = readonlyRequest("attempt-browser-cancel");
    const requestHash = hashHermesBridgeRequest(startRequest);
    const generation = "browser-cancel-generation";
    const backendRunId = "browser-cancel-run";
    const backendSubmission = {
      ...readonlyBackendSubmission(backendRunId),
      sessionKey: readonlyScopedSessionKey("attempt-browser-cancel", generation),
    };
    cleanupStore.registerCleanup({
      idempotencyKey: "attempt-browser-cancel",
      requestHash,
      generation,
      backendAdmissionKey: "browser-cancel-admission",
      backendRunId,
      backendStartAttempted: true,
      backendSubmission,
      request: startRequest,
      dueAt: Date.now(),
    });
    dispatchGatewayMethod
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          tabs: [
            {
              targetId: "tab-browser-cancel",
              label: readonlyScopedTabLabel("attempt-browser-cancel", generation),
            },
          ],
        },
      })
      .mockResolvedValueOnce({ ok: true, payload: { ok: true } });
    const subagent = {
      run: vi.fn(),
      waitForRun: vi.fn(),
      getSessionMessages: vi.fn(),
      getSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    } satisfies PluginRuntime["subagent"];
    const cancelRequest = request({
      protocolVersion: "2.0",
      taskId: "openclaw.browser.read_snapshot_cancel",
      idempotencyKey: "attempt-browser-cancel:cancel",
      dryRun: false,
      allowedTools: ["browser.read"],
      input: {
        startIdempotencyKey: "attempt-browser-cancel",
        backendRunId,
      },
      identity: startRequest.identity,
      routing: startRequest.routing,
      policy: startRequest.policy,
    });

    const cancelled = await executeHermesBridgeTask({
      config: readonlyConfig(["openclaw.browser.read_snapshot_cancel"]),
      request: cancelRequest,
      subagent,
      cleanupStore,
    });

    expect(cancelled).toMatchObject({
      ok: true,
      status: "blocked",
      backendExecution: { backendRunId },
      output: {
        evidence: {
          terminal: true,
          cancellationRequested: true,
          browserTabsCleaned: true,
          sessionCleaned: true,
        },
      },
    });
    expect(subagent.deleteSession).toHaveBeenCalledOnce();
    expect(cleanupStore.getCleanup("attempt-browser-cancel")).toBeUndefined();
    expect(cleanupStore.getCleanupTerminal("attempt-browser-cancel")).toMatchObject({
      backendRunId,
      output: { bridgeStatus: "blocked" },
    });
  });

  it("runs a real zero-effect async task through accepted, running, and terminal states", async () => {
    const cleanupStore = new MemoryHermesBridgeIdempotencyStore();
    const subagent = {
      run: vi.fn().mockResolvedValue({ runId: "async-run-1" }),
      waitForRun: vi
        .fn()
        .mockResolvedValueOnce({ status: "timeout", terminal: false })
        .mockResolvedValueOnce({ status: "ok", terminal: true }),
      getSessionMessages: vi.fn().mockResolvedValue({
        messages: [
          {
            role: "assistant",
            content: '{"result":"zero-effect async completed","sideEffectsPerformed":false}',
          },
        ],
      }),
      getSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    } satisfies PluginRuntime["subagent"];
    const audited = vi.spyOn(cleanupStore, "setCleanupAuditedTerminal");
    const completedCleanup = vi.spyOn(cleanupStore, "completeCleanup");

    const started = await executeHermesBridgeTask({
      config: zeroEffectAsyncConfig(),
      request: zeroEffectAsyncRequest("openclaw.agent.zero_effect_async_start", "async-start-1"),
      subagent,
      cleanupStore,
    });
    expect(started).toMatchObject({
      ok: true,
      status: "accepted",
      backendExecution: {
        executorBackend: "openclaw",
        backendRunId: "async-run-1",
        backendAgentId: "missioncrew-browser-readonly",
      },
      output: {
        evidence: {
          externalEffectBudget: 0,
          sideEffectsPerformed: false,
          terminal: false,
        },
      },
    });

    const running = await executeHermesBridgeTask({
      config: zeroEffectAsyncConfig(),
      request: zeroEffectAsyncRequest("openclaw.agent.zero_effect_async_poll", "async-poll-1", {
        startIdempotencyKey: "async-start-1",
        backendRunId: "async-run-1",
      }),
      subagent,
      cleanupStore,
    });
    expect(running).toMatchObject({
      ok: true,
      status: "running",
      backendExecution: { backendRunId: "async-run-1" },
      output: { evidence: { terminal: false } },
    });
    expect(cleanupStore.getCleanup("async-start-1")).toBeDefined();

    const completed = await executeHermesBridgeTask({
      config: zeroEffectAsyncConfig(),
      request: zeroEffectAsyncRequest("openclaw.agent.zero_effect_async_poll", "async-poll-2", {
        startIdempotencyKey: "async-start-1",
        backendRunId: "async-run-1",
      }),
      subagent,
      cleanupStore,
    });
    expect(completed).toMatchObject({
      ok: true,
      status: "succeeded",
      backendExecution: { backendRunId: "async-run-1" },
      output: {
        evidence: {
          externalEffectBudget: 0,
          sideEffectsPerformed: false,
          toolsAllowed: [],
          terminal: true,
          sessionCleaned: true,
          transcriptMessageCount: 1,
        },
      },
    });
    expect(subagent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        toolsAllow: [],
        disableTools: true,
        deliver: false,
      }),
    );
    expect(subagent.deleteSession).toHaveBeenCalledTimes(1);
    expect(audited).toHaveBeenCalledOnce();
    expect(audited.mock.invocationCallOrder[0]).toBeLessThan(
      subagent.deleteSession.mock.invocationCallOrder[0]!,
    );
    expect(subagent.deleteSession.mock.invocationCallOrder[0]).toBeLessThan(
      completedCleanup.mock.invocationCallOrder[0]!,
    );
    expect(cleanupStore.getCleanup("async-start-1")).toBeUndefined();
    expect(cleanupStore.getCleanupTerminal("async-start-1")).toMatchObject({
      backendRunId: "async-run-1",
      output: {
        bridgeStatus: "succeeded",
        evidence: { terminal: true, sessionCleaned: true },
      },
    });

    const replayed = await executeHermesBridgeTask({
      config: zeroEffectAsyncConfig(),
      request: zeroEffectAsyncRequest("openclaw.agent.zero_effect_async_poll", "async-poll-3", {
        startIdempotencyKey: "async-start-1",
        backendRunId: "async-run-1",
      }),
      subagent,
      cleanupStore,
    });
    expect(replayed).toMatchObject({
      ok: true,
      status: "succeeded",
      output: { evidence: { terminal: true, sessionCleaned: true } },
    });
    expect(subagent.waitForRun).toHaveBeenCalledTimes(2);
  });

  it("uses the start idempotency key to isolate otherwise identical async sessions", async () => {
    const cleanupStore = new MemoryHermesBridgeIdempotencyStore();
    const sessionKeys: string[] = [];
    const subagent = {
      run: vi.fn(async (params: Parameters<PluginRuntime["subagent"]["run"]>[0]) => {
        sessionKeys.push(params.sessionKey);
        return { runId: `run-${sessionKeys.length}` };
      }),
      waitForRun: vi.fn(),
      getSessionMessages: vi.fn(),
      getSession: vi.fn(),
      deleteSession: vi.fn(),
    } satisfies PluginRuntime["subagent"];

    for (const idempotencyKey of ["isolated-start-1", "isolated-start-2"]) {
      const result = await executeHermesBridgeTask({
        config: zeroEffectAsyncConfig(),
        request: zeroEffectAsyncRequest("openclaw.agent.zero_effect_async_start", idempotencyKey),
        subagent,
        cleanupStore,
      });
      expect(result.status).toBe("accepted");
    }

    expect(sessionKeys).toHaveLength(2);
    expect(sessionKeys[0]).not.toBe(sessionKeys[1]);
  });

  it("bounds and reconciles a hanging zero-effect async admission", async () => {
    vi.useFakeTimers();
    try {
      const cleanupStore = new MemoryHermesBridgeIdempotencyStore();
      const subagent = {
        run: vi.fn(() => new Promise<never>(() => {})),
        waitForRun: vi.fn(),
        getSessionMessages: vi.fn(),
        getSession: vi.fn(),
        deleteSession: vi.fn(),
      } satisfies PluginRuntime["subagent"];
      const execution = executeHermesBridgeTask({
        config: zeroEffectAsyncConfig(1),
        request: zeroEffectAsyncRequest(
          "openclaw.agent.zero_effect_async_start",
          "async-timeout-start",
        ),
        subagent,
        cleanupStore,
      });

      await vi.advanceTimersByTimeAsync(1_001);
      await expect(execution).resolves.toMatchObject({
        ok: true,
        status: "running",
        output: {
          evidence: {
            admissionPending: true,
            terminal: false,
          },
        },
      });
      expect(subagent.deleteSession).not.toHaveBeenCalled();
      expect(cleanupStore.getCleanup("async-timeout-start")).toMatchObject({
        backendStartAttempted: true,
        backendAdmissionKey: expect.any(String),
      });
      subagent.run.mockResolvedValueOnce({ runId: "async-timeout-reconciled" });
      const reconciled = executeHermesBridgeTask({
        config: zeroEffectAsyncConfig(1),
        request: zeroEffectAsyncRequest(
          "openclaw.agent.zero_effect_async_start",
          "async-timeout-start",
        ),
        subagent,
        cleanupStore,
      });
      await expect(reconciled).resolves.toMatchObject({
        ok: true,
        status: "accepted",
        backendExecution: {
          backendRunId: "async-timeout-reconciled",
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks a reconciled async admission attempted before dispatch", async () => {
    const cleanupStore = new MemoryHermesBridgeIdempotencyStore();
    const startRequest = zeroEffectAsyncRequest(
      "openclaw.agent.zero_effect_async_start",
      "async-submission-only-start",
    );
    const requestHash = hashHermesBridgeRequest(startRequest);
    cleanupStore.registerCleanup({
      idempotencyKey: startRequest.idempotencyKey,
      requestHash,
      generation: "async-submission-only-generation",
      backendAdmissionKey: "async-submission-only-admission",
      backendSubmission: {
        sessionKey: "agent:missioncrew-browser-readonly:subagent:submission-only",
        message: "Complete zero-effect work.",
        extraSystemPrompt: "Do not use tools.",
        lane: "hermes-bridge:submission-only",
        lightContext: true,
        deliver: false,
        toolsAllow: [],
        disableTools: true,
      },
      request: startRequest,
      dueAt: 1,
    });
    const marked = vi.spyOn(cleanupStore, "markCleanupBackendStartAttempted");
    const subagent = {
      run: vi.fn(async () => {
        expect(cleanupStore.getCleanup(startRequest.idempotencyKey)).toMatchObject({
          backendStartAttempted: true,
        });
        expect(marked).toHaveBeenCalledOnce();
        return { runId: "async-submission-only-run" };
      }),
      waitForRun: vi.fn(),
      getSessionMessages: vi.fn(),
      getSession: vi.fn(),
      deleteSession: vi.fn(),
    } satisfies PluginRuntime["subagent"];

    await expect(
      executeHermesBridgeTask({
        config: zeroEffectAsyncConfig(),
        request: startRequest,
        subagent,
        cleanupStore,
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: "accepted",
      backendExecution: {
        backendRunId: "async-submission-only-run",
      },
    });
  });

  it("does not classify a definitive async admission rejection as pending", async () => {
    const cleanupStore = new MemoryHermesBridgeIdempotencyStore();
    const subagent = {
      run: vi.fn().mockRejectedValue(
        Object.assign(new Error("backend authentication rejected"), {
          code: "UNAUTHENTICATED",
        }),
      ),
      waitForRun: vi.fn(),
      getSessionMessages: vi.fn(),
      getSession: vi.fn(),
      deleteSession: vi.fn(),
    } satisfies PluginRuntime["subagent"];

    await expect(
      executeHermesBridgeTask({
        config: zeroEffectAsyncConfig(),
        request: zeroEffectAsyncRequest(
          "openclaw.agent.zero_effect_async_start",
          "async-definitive-rejection",
        ),
        subagent,
        cleanupStore,
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: "failed",
      error: { type: "task_execution_failed" },
    });
    expect(cleanupStore.getCleanup("async-definitive-rejection")).toBeUndefined();
  });

  it("retains async admission identity after an ambiguous transport rejection", async () => {
    const cleanupStore = new MemoryHermesBridgeIdempotencyStore();
    const subagent = {
      run: vi.fn().mockRejectedValue(new Error("connection reset")),
      waitForRun: vi.fn(),
      getSessionMessages: vi.fn(),
      getSession: vi.fn(),
      deleteSession: vi.fn(),
    } satisfies PluginRuntime["subagent"];

    await expect(
      executeHermesBridgeTask({
        config: zeroEffectAsyncConfig(),
        request: zeroEffectAsyncRequest(
          "openclaw.agent.zero_effect_async_start",
          "async-ambiguous-rejection",
        ),
        subagent,
        cleanupStore,
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: "running",
      output: {
        evidence: {
          admissionPending: true,
          terminal: false,
        },
      },
    });
    expect(cleanupStore.getCleanup("async-ambiguous-rejection")).toMatchObject({
      backendStartAttempted: true,
      backendAdmissionKey: expect.any(String),
      backendSubmission: expect.any(Object),
    });
  });

  it("retains a prior ambiguous admission after a later definitive rejection", async () => {
    vi.useFakeTimers();
    try {
      const cleanupStore = new MemoryHermesBridgeIdempotencyStore();
      const subagent = {
        run: vi.fn(() => new Promise<never>(() => {})),
        waitForRun: vi.fn(),
        getSessionMessages: vi.fn(),
        getSession: vi.fn(),
        deleteSession: vi.fn(),
      } satisfies PluginRuntime["subagent"];
      const request = zeroEffectAsyncRequest(
        "openclaw.agent.zero_effect_async_start",
        "async-ambiguous-then-rejected",
      );
      const first = executeHermesBridgeTask({
        config: zeroEffectAsyncConfig(1),
        request,
        subagent,
        cleanupStore,
      });
      await vi.advanceTimersByTimeAsync(1_001);
      await expect(first).resolves.toMatchObject({
        ok: true,
        status: "running",
        output: { evidence: { admissionPending: true } },
      });
      const original = cleanupStore.getCleanup(request.idempotencyKey);
      subagent.run.mockRejectedValueOnce(
        Object.assign(new Error("backend precondition changed"), {
          code: "FAILED_PRECONDITION",
        }),
      );

      await expect(
        executeHermesBridgeTask({
          config: zeroEffectAsyncConfig(1),
          request,
          subagent,
          cleanupStore,
        }),
      ).resolves.toMatchObject({
        ok: true,
        status: "running",
        output: { evidence: { admissionPending: true } },
      });
      expect(cleanupStore.getCleanup(request.idempotencyKey)).toMatchObject({
        generation: original?.generation,
        backendAdmissionKey: original?.backendAdmissionKey,
        backendStartAttempted: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts and cleans an exact zero-effect async run at a stop rule", async () => {
    const cleanupStore = new MemoryHermesBridgeIdempotencyStore();
    const subagent = {
      run: vi.fn().mockResolvedValue({ runId: "async-cancel-run" }),
      waitForRun: vi.fn(),
      getSessionMessages: vi.fn(),
      getSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    } satisfies PluginRuntime["subagent"];

    await executeHermesBridgeTask({
      config: zeroEffectAsyncConfig(),
      request: zeroEffectAsyncRequest(
        "openclaw.agent.zero_effect_async_start",
        "async-cancel-start",
      ),
      subagent,
      cleanupStore,
    });

    const cancelled = await executeHermesBridgeTask({
      config: zeroEffectAsyncConfig(),
      request: zeroEffectAsyncRequest(
        "openclaw.agent.zero_effect_async_cancel",
        "async-cancel-request",
        {
          startIdempotencyKey: "async-cancel-start",
          backendRunId: "async-cancel-run",
        },
      ),
      subagent,
      cleanupStore,
    });

    expect(cancelled).toMatchObject({
      ok: true,
      status: "blocked",
      backendExecution: { backendRunId: "async-cancel-run" },
      output: {
        evidence: {
          terminal: true,
          cancellationRequested: true,
          terminationProven: true,
          sessionCleaned: true,
        },
      },
    });
    expect(subagent.deleteSession).toHaveBeenCalledWith({
      sessionKey: expect.stringMatching(
        /^agent:missioncrew-browser-readonly:subagent:hermes-zero-effect-/,
      ),
    });
    expect(cleanupStore.getCleanup("async-cancel-start")).toBeUndefined();
    expect(cleanupStore.getCleanupTerminal("async-cancel-start")).toMatchObject({
      backendRunId: "async-cancel-run",
      output: {
        bridgeStatus: "blocked",
        evidence: { cancellationRequested: true, terminal: true },
      },
    });
  });

  it("returns retryable running when async poll cleanup state is unavailable", async () => {
    const cleanupStore = new MemoryHermesBridgeIdempotencyStore();
    const subagent = {
      run: vi.fn().mockResolvedValue({ runId: "async-store-run" }),
      waitForRun: vi.fn(),
      getSessionMessages: vi.fn().mockResolvedValue({
        messages: [
          {
            role: "assistant",
            content: '{"result":"zero-effect async completed","sideEffectsPerformed":false}',
          },
        ],
      }),
      getSession: vi.fn(),
      deleteSession: vi.fn(),
    } satisfies PluginRuntime["subagent"];
    const started = await executeHermesBridgeTask({
      config: zeroEffectAsyncConfig(),
      request: zeroEffectAsyncRequest(
        "openclaw.agent.zero_effect_async_start",
        "async-store-start",
      ),
      subagent,
      cleanupStore,
    });
    expect(started.status).toBe("accepted");
    vi.spyOn(cleanupStore, "getCleanup").mockImplementation(() => {
      throw new Error("database is busy");
    });

    const result = await executeHermesBridgeTask({
      config: zeroEffectAsyncConfig(),
      request: zeroEffectAsyncRequest("openclaw.agent.zero_effect_async_poll", "async-store-poll", {
        startIdempotencyKey: "async-store-start",
        backendRunId: "async-store-run",
      }),
      subagent,
      cleanupStore,
    });

    expect(result).toMatchObject({
      ok: false,
      status: "running",
      error: { type: "cleanup_store_unavailable" },
    });
    expect(subagent.waitForRun).not.toHaveBeenCalled();
  });

  it("durably reconciles and cleans an abandoned zero-effect async run", async () => {
    const cleanupStore = new MemoryHermesBridgeIdempotencyStore();
    const subagent = {
      run: vi.fn().mockResolvedValue({ runId: "async-abandoned-run" }),
      waitForRun: vi.fn().mockResolvedValue({ status: "ok", terminal: true }),
      getSessionMessages: vi.fn().mockResolvedValue({
        messages: [
          {
            role: "assistant",
            content: '{"result":"zero-effect async completed","sideEffectsPerformed":false}',
          },
        ],
      }),
      getSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    } satisfies PluginRuntime["subagent"];

    const started = await executeHermesBridgeTask({
      config: zeroEffectAsyncConfig(),
      request: zeroEffectAsyncRequest(
        "openclaw.agent.zero_effect_async_start",
        "async-abandoned-start",
      ),
      subagent,
      cleanupStore,
    });
    expect(started.status).toBe("accepted");
    expect(cleanupStore.getCleanup("async-abandoned-start")).toBeDefined();

    const completed = await sweepHermesBridgeCleanupObligations({
      store: cleanupStore,
      subagent,
      config: zeroEffectAsyncConfig(),
      nowMs: Number.MAX_SAFE_INTEGER,
    });

    expect(completed).toBe(1);
    expect(subagent.run).toHaveBeenCalledTimes(2);
    expect(subagent.waitForRun).toHaveBeenCalledWith({
      runId: "async-abandoned-run",
      timeoutMs: expect.any(Number),
    });
    expect(subagent.deleteSession).toHaveBeenCalledOnce();
    expect(cleanupStore.getCleanup("async-abandoned-start")).toBeUndefined();
    expect(cleanupStore.getCleanupTerminal("async-abandoned-start")).toMatchObject({
      backendRunId: "async-abandoned-run",
      output: { bridgeStatus: "succeeded", evidence: { terminal: true } },
    });
  });

  it("cleans and tombstones a terminal async run whose transcript audit fails", async () => {
    const cleanupStore = new MemoryHermesBridgeIdempotencyStore();
    const subagent = {
      run: vi.fn().mockResolvedValue({ runId: "async-invalid-audit-run" }),
      waitForRun: vi.fn().mockResolvedValue({ status: "ok", terminal: true }),
      getSessionMessages: vi.fn().mockResolvedValue({
        messages: [{ role: "assistant", content: "unexpected result" }],
      }),
      getSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    } satisfies PluginRuntime["subagent"];

    await executeHermesBridgeTask({
      config: zeroEffectAsyncConfig(),
      request: zeroEffectAsyncRequest(
        "openclaw.agent.zero_effect_async_start",
        "async-invalid-audit-start",
      ),
      subagent,
      cleanupStore,
    });
    const completed = await sweepHermesBridgeCleanupObligations({
      store: cleanupStore,
      subagent,
      config: zeroEffectAsyncConfig(),
      nowMs: Number.MAX_SAFE_INTEGER,
    });

    expect(completed).toBe(1);
    expect(subagent.deleteSession).toHaveBeenCalledOnce();
    expect(cleanupStore.getCleanup("async-invalid-audit-start")).toBeUndefined();
    expect(cleanupStore.getCleanupTerminal("async-invalid-audit-start")).toMatchObject({
      backendRunId: "async-invalid-audit-run",
      output: {
        bridgeStatus: "failed",
        evidence: {
          terminal: true,
          auditPassed: false,
          sessionCleaned: true,
        },
      },
    });
  });
});
