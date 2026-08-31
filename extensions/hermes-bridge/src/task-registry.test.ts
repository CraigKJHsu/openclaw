import { describe, expect, it } from "vitest";
import { auditLoopContractResult, sanitizeLoopContractForPrompt } from "./task-registry.js";
import type { HermesBridgeRequest } from "./types.js";

function request(): HermesBridgeRequest {
  return {
    protocolVersion: "2.0",
    operation: "loop_contract.start",
    identity: {
      delegationId: "gd_test",
      attemptId: "attempt_test",
      contractFingerprint: "a".repeat(64),
    },
    routing: {
      executorBackend: "openclaw",
      executorProfile: "loop-contract",
      backendAgentId: "missioncrew-facebook-page-operator",
    },
    policy: {
      externalEffectBudget: 1,
      workspacePolicy: "dedicated",
      sessionPolicy: "ephemeral",
      credentialRefs: ["hermes-facebook-page-graph"],
      approvalGrantId: "approval_test",
    },
    allowedTools: ["facebook_page_graph_publish"],
    requiresConfirmation: false,
    dryRun: false,
    idempotencyKey: "attempt_test",
    input: {
      loopContract: {
        external_targets: ["https://www.facebook.com/solobizai"],
      },
    },
  } as HermesBridgeRequest;
}

describe("auditLoopContractResult", () => {
  it("accepts structured Graph API readback evidence", () => {
    const result = auditLoopContractResult(
      JSON.stringify({
        status: "succeeded",
        externalEffects: [
          {
            target: "https://www.facebook.com/solobizai",
            effectKey: "facebook_page_photo_post:531289396730654:message:image",
            state: "verified",
            externalId: "531289396730654_122181403154694189",
            readback: {
              post_id: "531289396730654_122181403154694189",
              message_sha256: "dffcc26e",
              image_sha256: "4061073c",
            },
          },
        ],
      }),
      request(),
    );

    expect(result.ok).toBe(true);
  });

  it("rejects empty structured readback evidence", () => {
    const result = auditLoopContractResult(
      JSON.stringify({
        status: "succeeded",
        externalEffects: [
          {
            target: "https://www.facebook.com/solobizai",
            effectKey: "facebook_page_photo_post:test",
            state: "verified",
            externalId: "post_test",
            readback: {},
          },
        ],
      }),
      request(),
    );

    expect(result).toEqual({
      ok: false,
      reason: "Loop Contract external effect evidence is incomplete or outside the approved targets.",
    });
  });
});

describe("sanitizeLoopContractForPrompt", () => {
  it("preserves durable evidence snapshots for loop workers", () => {
    const sanitized = sanitizeLoopContractForPrompt({
      completion_mode: "intermediate",
      durable_evidence_snapshot: {
        source: "hermes_kanban_same_objective_readonly_snapshot",
        commerce_group_ledger: [
          {
            destination_id: "1333742673375089",
            destination_name: "(北市新北) 冷氣 家電 家具 五金 雜貨全新中古買賣",
            source_listing_id: "37276725125275496",
            source_task_id: "t_e6667e4c",
            source_run_id: 1281,
            status: "unknown",
          },
        ],
      },
    });

    expect(sanitized.durable_evidence_snapshot).toEqual({
      source: "hermes_kanban_same_objective_readonly_snapshot",
      commerce_group_ledger: [
        {
          destination_id: "1333742673375089",
          destination_name: "(北市新北) 冷氣 家電 家具 五金 雜貨全新中古買賣",
          source_listing_id: "37276725125275496",
          source_task_id: "t_e6667e4c",
          source_run_id: 1281,
          status: "unknown",
        },
      ],
    });
  });
});
