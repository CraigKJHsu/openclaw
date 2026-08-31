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

  it("accepts a safe zero-effect external blocker report", () => {
    const result = auditLoopContractResult(
      JSON.stringify({
        status: "succeeded",
        summary:
          "blocked: the live management dialog resolved to a forbidden listing id, so no external write was performed.",
        acceptanceEvidence: {
          blocker:
            "The listing-bound management dialog resolved to a forbidden listing id.",
          coverage: {
            expected_total: 16,
            named_count: 16,
            attempted_count: 0,
            success_or_submitted_count: 0,
            blocked_count: 16,
            complete: false,
          },
          destinations: [
            {
              group_id: "207110076321670",
              canonical_name: "二手家電冷氣買賣",
              attempted: false,
              final_state: "blocked",
              evidence: "Not attempted because the source listing id was not canonical.",
            },
          ],
        },
        externalEffects: [],
      }),
      request(),
    );

    expect(result.ok).toBe(true);
  });

  it("accepts source identity conflict as safe zero-effect external blocker evidence", () => {
    const result = auditLoopContractResult(
      JSON.stringify({
        status: "succeeded",
        summary:
          "Zero-effect blocker report produced. The live owner/management identifiers resolve to forbidden listing id 915975414881937. I stopped before any distribution write. No Facebook submit/post action was performed.",
        acceptanceEvidence: {
          sourceListingReadback: {
            requestedSourceListingId: "37276725125275496",
            requestedUrl: "https://www.facebook.com/marketplace/item/37276725125275496/",
            liveReadback:
              "The item page displays Kolin KD-291M06, but edit/listing management links expose listing_id=915975414881937.",
          },
        },
        externalEffects: [],
      }),
      request(),
    );

    expect(result.ok).toBe(true);
  });

  it("accepts credentialed readonly chooser scans with no external effects", () => {
    const result = auditLoopContractResult(
      JSON.stringify({
        status: "succeeded",
        summary:
          "Completed the bounded read-only live chooser scan. The listing-bound List in more places chooser was opened and 47 visible checkbox rows were preserved. No numeric group IDs were exposed in the chooser row href/value/data/id/DOM signals, so no eligible exact allowlist candidates were produced. No checkbox was selected and Post remained disabled.",
        acceptanceEvidence: {
          sourceAliasReadback: {
            public_listing_id: "37276725125275496",
            management_listing_id: "915975414881937",
            verified: true,
          },
          eligibleCandidates: [],
          rejectedOptions: [
            {
              canonical_name:
                "(北市新北) 冷氣 家電 家具 五金 雜貨全新中古買賣",
              reason: "visible in chooser but no exact numeric group ID exposed",
            },
          ],
          coverage: {
            scanned_count: 57,
            eligible_count: 0,
            ineligible_count: 57,
            complete: false,
          },
          zeroExternalEffectConfirmation: {
            verified: true,
          },
        },
        externalEffects: [],
      }),
      request(),
    );

    expect(result.ok).toBe(true);
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
