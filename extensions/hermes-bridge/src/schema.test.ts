import { describe, expect, it } from "vitest";
import { normalizeHermesBridgeRequest } from "./schema.js";

describe("normalizeHermesBridgeRequest", () => {
  it("rejects a present but incomplete model route", () => {
    expect(
      normalizeHermesBridgeRequest({
        taskId: "status.echo",
        routing: { modelRoute: { requested_model: "gpt-5.6-terra" } },
      }),
    ).toMatchObject({
      ok: false,
      error: { type: "invalid_request", message: expect.stringContaining("modelRoute") },
    });
  });

  it("normalizes Hermes delegation requests with safe defaults", () => {
    expect(
      normalizeHermesBridgeRequest({
        requestId: "req-1",
        taskId: "status.echo",
        requestedBy: "not-trusted",
        priority: "high",
        allowedTools: ["telegram.send", "telegram.send", "", 1],
        input: { message: "hello" },
      }),
    ).toEqual({
      ok: true,
      request: {
        protocolVersion: "1.0",
        requestId: "req-1",
        idempotencyKey: "req-1",
        taskId: "status.echo",
        requestedBy: "hermes",
        intent: "status.echo",
        priority: "high",
        requiresConfirmation: false,
        allowedTools: ["telegram.send"],
        input: { message: "hello" },
        dryRun: true,
        identity: {},
        routing: {},
        policy: {
          externalEffectBudget: 0,
          credentialRefs: [],
        },
      },
    });
  });

  it("normalizes Protocol v2 execution identity, routing, and policy", () => {
    expect(
      normalizeHermesBridgeRequest({
        protocolVersion: "2.0",
        taskId: "openclaw.browser.read_snapshot",
        idempotencyKey: "a-1",
        identity: {
          delegationId: "d-1",
          attemptId: "a-1",
          contractFingerprint: "sha256:abc",
          project: "hub_ops",
          topicId: "readonly-browser",
        },
        routing: {
          executorBackend: "openclaw",
          executorProfile: "browser-readonly",
          backendAgentId: "missioncrew-browser-readonly",
          modelRoute: {
            requested_model: "gpt-5.6-luna",
            reasoning_effort: "low",
            reasoning_mode: "standard",
            policy_id: "missioncrew-model-routing-v1",
            policy_sha256: "a".repeat(64),
          },
        },
        policy: {
          externalEffectBudget: 0,
          workspacePolicy: "dedicated",
          sessionPolicy: "ephemeral",
          credentialRefs: [],
        },
      }),
    ).toMatchObject({
      ok: true,
      request: {
        protocolVersion: "2.0",
        identity: {
          delegationId: "d-1",
          attemptId: "a-1",
          contractFingerprint: "sha256:abc",
          project: "hub_ops",
          topicId: "readonly-browser",
        },
        routing: {
          executorBackend: "openclaw",
          executorProfile: "browser-readonly",
          backendAgentId: "missioncrew-browser-readonly",
          modelRoute: {
            requested_model: "gpt-5.6-luna",
            reasoning_effort: "low",
            reasoning_mode: "standard",
            policy_id: "missioncrew-model-routing-v1",
            policy_sha256: "a".repeat(64),
          },
        },
        policy: {
          externalEffectBudget: 0,
          workspacePolicy: "dedicated",
          sessionPolicy: "ephemeral",
          credentialRefs: [],
        },
      },
    });
  });

  it("does not use the Protocol v1 requestId fallback for Protocol v2", () => {
    expect(
      normalizeHermesBridgeRequest({
        protocolVersion: "2.0",
        requestId: "a-1",
        taskId: "openclaw.browser.read_snapshot",
        identity: {
          delegationId: "d-1",
          attemptId: "a-1",
          contractFingerprint: "hash",
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
    ).toMatchObject({
      ok: false,
      error: { message: "Protocol v2 requires an idempotencyKey." },
    });
  });

  it("rejects non-canonical whitespace in Protocol v2 identity.taskType", () => {
    expect(
      normalizeHermesBridgeRequest({
        protocolVersion: "2.0",
        taskId: "openclaw.agent.loop_contract_start",
        idempotencyKey: "a-1",
        identity: {
          delegationId: "d-1",
          attemptId: "a-1",
          contractFingerprint: "sha256:abc",
          project: "secondhand_commerce",
          topicId: "2",
          taskType: "facebook_marketplace_readonly ",
        },
        routing: {
          executorBackend: "openclaw",
          executorProfile: "loop-contract",
          backendAgentId: "missioncrew-executor",
        },
        policy: {
          externalEffectBudget: 0,
          workspacePolicy: "dedicated",
          sessionPolicy: "ephemeral",
          credentialRefs: [],
        },
      }),
    ).toMatchObject({
      ok: false,
      error: {
        message: "Protocol v2 identity.taskType must be a canonical string.",
      },
    });
  });

  it("fails closed without taskId", () => {
    expect(normalizeHermesBridgeRequest({ input: {} })).toMatchObject({
      ok: false,
      error: { type: "invalid_request" },
    });
  });

  it.each(["2.1", "3.0", "", null, 2])(
    "rejects explicitly unsupported protocolVersion=%p",
    (protocolVersion) => {
      expect(
        normalizeHermesBridgeRequest({
          protocolVersion,
          taskId: "status.echo",
        }),
      ).toMatchObject({
        ok: false,
        error: { type: "invalid_request" },
      });
    },
  );

  it.each([undefined, -1, 0.5, Number.NaN, "0"])(
    "rejects malformed Protocol v2 externalEffectBudget=%p",
    (externalEffectBudget) => {
      expect(
        normalizeHermesBridgeRequest({
          protocolVersion: "2.0",
          taskId: "openclaw.browser.read_snapshot",
          idempotencyKey: "a-1",
          identity: {
            delegationId: "d-1",
            attemptId: "a-1",
            contractFingerprint: "sha256:abc",
            project: "hub_ops",
            topicId: "readonly-browser",
          },
          routing: {
            executorBackend: "openclaw",
            executorProfile: "browser-readonly",
            backendAgentId: "missioncrew-browser-readonly",
          },
          policy: {
            externalEffectBudget,
            workspacePolicy: "dedicated",
            sessionPolicy: "ephemeral",
            credentialRefs: [],
          },
        }),
      ).toMatchObject({
        ok: false,
        error: { type: "invalid_request" },
      });
    },
  );
});
