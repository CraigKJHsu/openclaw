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
  it.each([
    "valid",
    "no_approval",
    "wrong_agent",
    "wrong_tool",
    "wrong_type",
    "wrong_domain",
    "wrong_budget",
    "wrong_transport",
    "wrong_ref",
    "wrong_post",
    "wrong_target",
    "unverified",
    "wrong_artifact",
    "informational_only",
    "empty_artifacts",
    "unbound_extra",
    "empty_deltas",
    "missing_readback",
    "readback_failed",
    "readback_unpublished",
    "readback_unverified",
    "readback_wrong_post",
    "missing_permalink",
    "foreign_permalink",
    "wrong_artifact_url",
  ])("binds approved Page publication deltas to the canonical create effect: %s", (fault) => {
    const scoped = request();
    scoped.identity.taskType =
      fault === "wrong_type" ? "facebook_page_publish_preflight" : "facebook_page_api_publish";
    scoped.allowedTools =
      fault === "wrong_tool"
        ? ["browser"]
        : ["facebook_page_graph_status", "facebook_page_graph_publish"];
    if (fault === "no_approval") delete scoped.policy.approvalGrantId;
    if (fault === "wrong_agent") scoped.routing.backendAgentId = "missioncrew-browser-operator";
    if (fault === "wrong_budget") scoped.policy.externalEffectBudget = 2;
    const pageUrl = "https://www.facebook.com/123";
    scoped.input.loopContract = {
      external_targets: [pageUrl],
      facebook_page_post: {
        action: "create_post",
        transport: fault === "wrong_transport" ? "browser" : "graph_api",
        page_id: "123",
        page_url: pageUrl,
      },
      domain_memory: {
        mode: "mutate",
        schema_id: "solobizai.case.v1",
        domain_key: fault === "wrong_domain" ? "other" : "solobizai",
        entity_type: "SoloBizAiCase",
      },
    };
    const ref = "task_external_effect:facebook:create";
    const artifact = {
      artifact_type: fault === "wrong_artifact" ? "podcast_episode" : "facebook_page_post",
      status: fault === "informational_only" ? "draft" : "published",
      platform: "facebook",
      external_id: fault === "wrong_post" ? "123_789" : "123_456",
      public_url:
        fault === "wrong_artifact_url"
          ? "https://example.com/wrong"
          : "https://www.facebook.com/123/posts/456",
      evidence_ref: fault === "wrong_ref" ? "task_external_effect:facebook:other" : ref,
    };
    const result = auditLoopContractResult(
      JSON.stringify({
        status: "succeeded",
        summary: "Published once",
        acceptanceEvidence: { verified: true },
        externalEffects: [
          {
            target: fault === "wrong_target" ? "https://www.facebook.com/999" : pageUrl,
            effectKey: "create",
            externalId: "123_456",
            state: fault === "unverified" ? "unknown" : "verified",
            readback:
              fault === "missing_readback"
                ? undefined
                : {
                    success: fault !== "readback_failed",
                    published: fault !== "readback_unpublished",
                    verified: fault !== "readback_unverified",
                    post_id: fault === "readback_wrong_post" ? "123_789" : "123_456",
                    permalink_url:
                      fault === "missing_permalink"
                        ? undefined
                        : fault === "foreign_permalink"
                          ? "https://example.com/wrong"
                          : "https://www.facebook.com/123/posts/456",
                  },
          },
        ],
        domainMemoryDeltas:
          fault === "empty_deltas"
            ? []
            : [
                {
                  entity_id: "case-a",
                  label: "Case A",
                  status: "published",
                  evidence_refs: [ref],
                  artifacts:
                    fault === "empty_artifacts"
                      ? []
                      : fault === "unbound_extra"
                        ? [artifact, { ...artifact, artifact_type: "podcast_episode" }]
                        : [artifact],
                },
              ],
      }),
      scoped,
    );
    expect(result.ok, result.reason).toBe(fault === "valid");
  });

  it.each([
    "valid",
    "missing_ref",
    "wrong_group",
    "no_approval",
    "empty_artifacts",
    "informational_only",
    "wrong_target",
    "unverified",
  ])("audits approved secondhand mutation binding: %s", (fault) => {
    const scoped = request();
    scoped.routing.backendAgentId = "missioncrew-browser-operator";
    scoped.allowedTools = ["browser"];
    scoped.input.loopContract = {
      external_targets: ["https://www.facebook.com/groups/123"],
      facebook_group_publish: { mode: "listing_bound_chooser" },
      domain_memory: {
        schema_id: "secondhand.item.v1",
        domain_key: "secondhand",
        entity_type: "ResaleItem",
        mode: "mutate",
      },
    };
    if (fault === "no_approval") delete scoped.policy.approvalGrantId;
    const ref = "task_external_effect:facebook:group:123";
    const result = auditLoopContractResult(
      JSON.stringify({
        status: "succeeded",
        externalEffects: [
          {
            target:
              fault === "wrong_target"
                ? "https://www.facebook.com/groups/456"
                : "https://www.facebook.com/groups/123",
            effectKey: "group:123",
            state: fault === "unverified" ? "attempted" : "verified",
            readback: { published: true },
          },
        ],
        domainMemoryDeltas: [
          {
            operation: "upsert",
            entity_id: "telescope",
            label: "Celestron",
            status: "active",
            evidence_refs: fault === "missing_ref" ? [] : [ref],
            artifacts:
              fault === "empty_artifacts"
                ? []
                : [
                    {
                      artifact_type: "facebook_group_post",
                      platform: "facebook",
                      external_id: fault === "wrong_group" ? "456" : "123",
                      status: fault === "informational_only" ? "planned" : "published",
                      evidence_ref: ref,
                    },
                  ],
          },
        ],
      }),
      scoped,
    );
    expect(result.ok).toBe(fault === "valid");
  });

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

  it("normalizes an empty undeclared domain-memory delta list", () => {
    const zeroEffectRequest = request();
    zeroEffectRequest.policy.externalEffectBudget = 0;
    zeroEffectRequest.policy.credentialRefs = [];
    zeroEffectRequest.allowedTools = [];
    zeroEffectRequest.input.loopContract = { external_targets: [] };
    const result = auditLoopContractResult(
      JSON.stringify({
        status: "succeeded",
        externalEffects: [],
        domainMemoryDeltas: [],
      }),
      zeroEffectRequest,
    );

    expect(result.ok).toBe(true);
    expect(result.parsed).not.toHaveProperty("domainMemoryDeltas");
  });

  it("repairs a detached domain-memory delta field from an otherwise valid result", () => {
    const domainRequest = request();
    domainRequest.policy.externalEffectBudget = 0;
    domainRequest.policy.credentialRefs = [];
    domainRequest.allowedTools = [];
    domainRequest.input.loopContract = {
      external_targets: [],
      domain_memory: {
        schema_id: "secondhand.item.v1",
        domain_key: "secondhand",
        entity_type: "ResaleItem",
        mode: "query",
      },
    };
    const result = auditLoopContractResult(
      '{"status":"blocked","summary":"browser unavailable","externalEffects":[],"acceptanceEvidence":{"blocker":{"owner":"openclaw_worker","scope":"contracted_deliverable","kind":"facebook_readonly_verification_unavailable","reason":"snapshot timed out"}}},"domainMemoryDeltas":[]}',
      domainRequest,
    );

    expect(result.ok).toBe(true);
    expect(result.parsed?.domainMemoryDeltas).toEqual([]);
  });

  it("does not repair arbitrary trailing JSON data", () => {
    const domainRequest = request();
    domainRequest.input.loopContract = {
      ...(domainRequest.input.loopContract as Record<string, unknown>),
      domain_memory: {
        schema_id: "secondhand.item.v1",
        domain_key: "secondhand",
        entity_type: "ResaleItem",
        mode: "query",
      },
    };
    const result = auditLoopContractResult(
      '{"status":"succeeded","externalEffects":[]},"unexpected":[]}',
      domainRequest,
    );

    expect(result).toEqual({
      ok: false,
      reason: "Loop Contract result is not valid JSON.",
    });
  });

  it("rejects non-empty undeclared domain-memory deltas", () => {
    const zeroEffectRequest = request();
    zeroEffectRequest.policy.externalEffectBudget = 0;
    zeroEffectRequest.policy.credentialRefs = [];
    zeroEffectRequest.allowedTools = [];
    zeroEffectRequest.input.loopContract = { external_targets: [] };
    const result = auditLoopContractResult(
      JSON.stringify({
        status: "succeeded",
        externalEffects: [],
        domainMemoryDeltas: [{ operation: "upsert" }],
      }),
      zeroEffectRequest,
    );

    expect(result).toEqual({
      ok: false,
      reason: "Loop Contract result returned domainMemoryDeltas without a domain_memory contract.",
    });
  });

  it("rejects noncanonical domain-memory modes", () => {
    const domainRequest = request();
    domainRequest.input.loopContract = {
      ...(domainRequest.input.loopContract as Record<string, unknown>),
      domain_memory: {
        schema_id: "solobizai.case.v1",
        domain_key: "solobizai",
        entity_type: "SoloBizAiCase",
        mode: "MUTATE",
      },
    };
    const result = auditLoopContractResult(
      JSON.stringify({
        status: "succeeded",
        externalEffects: [],
        domainMemoryDeltas: [{ operation: "upsert" }],
      }),
      domainRequest,
    );

    expect(result).toEqual({
      ok: false,
      reason: "Domain-memory mode must be query or mutate.",
    });
  });

  it("requires deltas for a domain-memory mutation", () => {
    const domainRequest = request();
    domainRequest.input.loopContract = {
      ...(domainRequest.input.loopContract as Record<string, unknown>),
      domain_memory: {
        schema_id: "solobizai.case.v1",
        domain_key: "solobizai",
        entity_type: "SoloBizAiCase",
        mode: "mutate",
      },
    };
    const result = auditLoopContractResult(
      JSON.stringify({
        status: "succeeded",
        externalEffects: [
          {
            target: "https://www.facebook.com/solobizai",
            effectKey: "facebook_page_photo_post:test",
            state: "verified",
            externalId: "post_test",
            readback: { post_id: "post_test" },
          },
        ],
        domainMemoryDeltas: [],
      }),
      domainRequest,
    );

    expect(result).toEqual({
      ok: false,
      reason: "Domain-memory mutation returned no domainMemoryDeltas.",
    });
  });

  it("does not let blocker-shaped evidence waive successful mutation deltas", () => {
    const domainRequest = request();
    domainRequest.input.loopContract = {
      ...(domainRequest.input.loopContract as Record<string, unknown>),
      domain_memory: {
        schema_id: "solobizai.case.v1",
        domain_key: "solobizai",
        entity_type: "SoloBizAiCase",
        mode: "mutate",
      },
    };
    const result = auditLoopContractResult(
      JSON.stringify({
        status: "succeeded",
        acceptanceEvidence: {
          blocker: {
            owner: "openclaw_worker",
            scope: "contracted_deliverable",
            kind: "required_source_unavailable",
            reason: "source unavailable",
          },
        },
        externalEffects: [],
        domainMemoryDeltas: [],
      }),
      domainRequest,
    );

    expect(result).toEqual({
      ok: false,
      reason: "Domain-memory mutation returned no domainMemoryDeltas.",
    });
  });

  it("rejects registry mutations from a blocked result", () => {
    const domainRequest = request();
    domainRequest.policy.externalEffectBudget = 0;
    domainRequest.policy.credentialRefs = [];
    domainRequest.allowedTools = [];
    domainRequest.input.loopContract = {
      external_targets: [],
      domain_memory: {
        schema_id: "solobizai.case.v1",
        domain_key: "solobizai",
        entity_type: "SoloBizAiCase",
        mode: "mutate",
      },
    };
    const result = auditLoopContractResult(
      JSON.stringify({
        status: "blocked",
        acceptanceEvidence: {
          blocker: {
            owner: "openclaw_worker",
            scope: "contracted_deliverable",
            kind: "required_source_unavailable",
            reason: "source unavailable",
          },
        },
        externalEffects: [],
        domainMemoryDeltas: [{ operation: "upsert" }],
      }),
      domainRequest,
    );

    expect(result).toEqual({
      ok: false,
      reason: "Blocked domain-memory result must not return registry mutations.",
    });
  });

  it("fails closed on domain-memory mutation until canonical effect binding exists", () => {
    const domainRequest = request();
    domainRequest.input.loopContract = {
      ...(domainRequest.input.loopContract as Record<string, unknown>),
      domain_memory: {
        schema_id: "solobizai.case.v1",
        domain_key: "solobizai",
        entity_type: "SoloBizAiCase",
        mode: "mutate",
      },
    };
    const delta = {
      operation: "upsert",
      entity_id: "case-test",
      label: "Test case",
      status: "active",
      artifacts: [],
      evidence_refs: ["task_external_effect:facebook:facebook_page_photo_post:test"],
    };
    const result = auditLoopContractResult(
      JSON.stringify({
        status: "succeeded",
        externalEffects: [
          {
            target: "https://www.facebook.com/solobizai",
            effectKey: "facebook_page_photo_post:test",
            state: "verified",
            externalId: "post_test",
            readback: { post_id: "post_test" },
          },
        ],
        domainMemoryDeltas: [delta],
      }),
      domainRequest,
    );

    expect(result).toEqual({
      ok: false,
      reason: "OpenClaw domain-memory mutation requires canonical effect binding.",
    });
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
      reason:
        "Loop Contract external effect evidence is incomplete or outside the approved targets.",
    });
  });

  it("accepts a safe zero-effect external blocker report", () => {
    const result = auditLoopContractResult(
      JSON.stringify({
        status: "succeeded",
        summary:
          "blocked: the live management dialog resolved to a forbidden listing id, so no external write was performed.",
        acceptanceEvidence: {
          blocker: "The listing-bound management dialog resolved to a forbidden listing id.",
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

  it("accepts a structured blocked result for a zero-budget worker-scope blocker", () => {
    const zeroEffectRequest = request();
    zeroEffectRequest.policy.externalEffectBudget = 0;
    zeroEffectRequest.policy.credentialRefs = [];
    zeroEffectRequest.allowedTools = [];
    zeroEffectRequest.input.loopContract = { external_targets: [] };

    const result = auditLoopContractResult(
      JSON.stringify({
        status: "blocked",
        summary: "blocked: the required source document is unavailable to the worker.",
        acceptanceEvidence: {
          blocker: {
            owner: "openclaw_worker",
            scope: "contracted_deliverable",
            kind: "required_source_unavailable",
            reason: "required_source_unavailable",
          },
        },
        externalEffects: [],
      }),
      zeroEffectRequest,
    );

    expect(result.ok).toBe(true);
    expect(result.parsed?.status).toBe("blocked");
  });

  it("reports an explicit blocked result without evidence precisely", () => {
    const zeroEffectRequest = request();
    zeroEffectRequest.policy.externalEffectBudget = 0;
    zeroEffectRequest.policy.credentialRefs = [];
    zeroEffectRequest.allowedTools = [];
    zeroEffectRequest.input.loopContract = { external_targets: [] };

    const result = auditLoopContractResult(
      JSON.stringify({ status: "blocked", externalEffects: [] }),
      zeroEffectRequest,
    );

    expect(result).toEqual({
      ok: false,
      reason:
        "Loop Contract result declared status=blocked without structured zero-effect blocker evidence.",
    });
  });

  it("rejects controller-tool availability as a worker-scope blocker", () => {
    const zeroEffectRequest = request();
    zeroEffectRequest.policy.externalEffectBudget = 0;
    zeroEffectRequest.policy.credentialRefs = [];
    zeroEffectRequest.allowedTools = [];
    zeroEffectRequest.input.loopContract = { external_targets: [] };

    const result = auditLoopContractResult(
      JSON.stringify({
        status: "blocked",
        summary: "blocked: kanban_complete is unavailable in this worker runtime.",
        acceptanceEvidence: {
          blocker: {
            kind: "capability",
            reason: "kanban_complete_unavailable",
          },
        },
        externalEffects: [],
      }),
      zeroEffectRequest,
    );

    expect(result).toEqual({
      ok: false,
      reason:
        "Loop Contract result declared status=blocked without structured zero-effect blocker evidence.",
    });
  });

  it("rejects paraphrased controller blockers without canonical worker ownership", () => {
    const zeroEffectRequest = request();
    zeroEffectRequest.policy.externalEffectBudget = 0;
    zeroEffectRequest.policy.credentialRefs = [];
    zeroEffectRequest.allowedTools = [];
    zeroEffectRequest.input.loopContract = { external_targets: [] };

    const result = auditLoopContractResult(
      JSON.stringify({
        status: "blocked",
        summary: "The Kanban completion tool is unavailable.",
        acceptanceEvidence: {
          blocker: {
            kind: "capability",
            reason: "completion_tool_unavailable",
          },
        },
        externalEffects: [],
      }),
      zeroEffectRequest,
    );

    expect(result).toEqual({
      ok: false,
      reason:
        "Loop Contract result declared status=blocked without structured zero-effect blocker evidence.",
    });
  });

  it("rejects worker self-labels without a controller-owned blocker kind", () => {
    const zeroEffectRequest = request();
    zeroEffectRequest.policy.externalEffectBudget = 0;
    zeroEffectRequest.policy.credentialRefs = [];
    zeroEffectRequest.allowedTools = [];
    zeroEffectRequest.input.loopContract = { external_targets: [] };

    const result = auditLoopContractResult(
      JSON.stringify({
        status: "blocked",
        acceptanceEvidence: {
          blocker: {
            owner: "openclaw_worker",
            scope: "contracted_deliverable",
            kind: "capability",
            reason: "completion service unavailable",
          },
        },
        externalEffects: [],
      }),
      zeroEffectRequest,
    );

    expect(result).toEqual({
      ok: false,
      reason:
        "Loop Contract result declared status=blocked without structured zero-effect blocker evidence.",
    });
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
              canonical_name: "(北市新北) 冷氣 家電 家具 五金 雜貨全新中古買賣",
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

  it("preserves compiler-owned domain-memory contracts", () => {
    const terminalContract = {
      domainMemoryDeltas: { operation: "upsert", shape: "entity with artifacts[]" },
      externalEffects: { target: "exact approved string", effectKey: "create" },
    };
    const sanitized = sanitizeLoopContractForPrompt({
      terminal_result_contract: terminalContract,
      domain_memory: {
        schema_id: "solobizai.case.v1",
        domain_key: "solobizai",
        entity_type: "SoloBizAiCase",
        mode: "mutate",
        require_delta_on_acceptance: true,
        artifact_types: ["facebook_page_post", "podcast_episode", "audio_brief"],
      },
    });
    expect(sanitized.terminal_result_contract).toEqual(terminalContract);

    expect(sanitized.domain_memory).toEqual({
      schema_id: "solobizai.case.v1",
      domain_key: "solobizai",
      entity_type: "SoloBizAiCase",
      mode: "mutate",
      require_delta_on_acceptance: true,
      artifact_types: ["facebook_page_post", "podcast_episode", "audio_brief"],
    });
  });
});

it("preserves the exact publication contract and safe approval receipt for the worker", () => {
  const publication = {
    mode: "listing_bound_chooser",
    source_listing_id: "456",
    destinations: [{ group_id: "123", canonical_url: "https://www.facebook.com/groups/123" }],
  };
  const safe = sanitizeLoopContractForPrompt({
    facebook_group_publish: publication,
    objective_ref: { objective_id: "objective", stage_key: "publish" },
    approval_provenance: {
      source: "one_time_authenticated_owner_challenge",
      contract_fingerprint: "fp",
      scope_binding: "exact_loop_contract_fingerprint",
      approved_message_id: "9198",
      user_id: "private-owner",
    },
  });
  expect(safe.facebook_group_publish).toEqual(publication);
  expect(safe.objective_ref).toEqual({ objective_id: "objective", stage_key: "publish" });
  expect(safe.approval_provenance).toEqual({
    source: "one_time_authenticated_owner_challenge",
    contract_fingerprint: "fp",
    scope_binding: "exact_loop_contract_fingerprint",
  });
});
