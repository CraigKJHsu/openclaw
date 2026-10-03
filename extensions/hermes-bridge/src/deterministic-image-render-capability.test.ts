import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_HERMES_BRIDGE_CONFIG } from "./config.js";
import {
  activateDeterministicImageRenderCapability,
  createDeterministicImageRenderTool,
  peekDeterministicImageRenderReceipts,
  drainDeterministicImageRenderCapability,
  recordDeterministicImageRenderReceipt,
  revokeDeterministicImageRenderCapability,
} from "./deterministic-image-render-capability.js";
import type { HermesBridgeRequest } from "./types.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, unlinkSync: vi.fn(original.unlinkSync) };
});

function request(overrides: Partial<HermesBridgeRequest> = {}): HermesBridgeRequest {
  return {
    protocolVersion: "2.0",
    taskId: "openclaw.agent.loop_contract_start",
    requestedBy: "hermes",
    intent: "campaign",
    priority: "normal",
    requiresConfirmation: false,
    allowedTools: ["read", "write", "web_search", "image_generate", "deterministic_image_render"],
    input: {
      delegatedTaskId: "t_content",
      loopContract: {
        source_package_ref: {
          execution_task_id: "t_source",
          execution_run_id: 41,
        },
        durable_evidence_snapshot: {
          referenced_task_evidence: [
            {
              task_id: "t_source",
              latest_completed_run: {
                run_id: 41,
                acceptance_evidence: {
                  image_assets: [
                    {
                      asset_family: "audio_brief",
                      path: "/tmp/inherited-audio.png",
                      sha256: "a".repeat(64),
                    },
                  ],
                },
              },
            },
          ],
        },
        user_facing_delivery: {
          kind: "content_package",
          asset_filenames: ["Page Hero.png", "Audio Brief.png"],
        },
      },
    },
    dryRun: false,
    identity: {
      delegationId: "delegation-content",
      attemptId: "t_content:run:42",
      contractFingerprint: "contract-content",
      taskType: "campaign",
    },
    routing: { backendAgentId: "missioncrew-content" },
    policy: { externalEffectBudget: 0, credentialRefs: [] },
    ...overrides,
  };
}

describe("deterministic image render capability", () => {
  it.each([
    "valid",
    "foreign-objective",
    "wrong-run",
    "unregistered-task",
    "wrong-policy-text",
    "partial-footer",
    "reversed-footer",
    "missing-identifiers",
    "multiple-filenames",
    "policy-digest-mismatch",
    "footer-whitespace-mutation",
    "serialized-check",
    "duplicate-check",
    "malformed-check",
    "conflicting-check",
  ])("binds explicit footer repair to a registered candidate artifact: %s", (fault) => {
    const scoped = request();
    const contract = scoped.input.loopContract as Record<string, unknown>;
    delete contract.source_package_ref;
    const spec = {
      mode: "repair_footer",
      source_execution_task_id: "t_source",
      source_execution_run_id: 41,
      policy_id: "audio-policy",
      footer_text: "6–10 min｜Fixed footer",
    };
    const latest = {
      run_id: 41,
      status: "done",
      outcome: "completed",
      acceptance_evidence: {
        assets: [
          {
            filename: "EP11_Best_Buy_audio_brief_1x1.png",
            asset_family: "audio_brief",
            path: "/tmp/candidate.png",
            sha256: "a".repeat(64),
            width: 1254,
            height: 1254,
          },
        ],
      },
    };
    const snapshot = {
      objective_id: "objective-a",
      stage_key: "repair",
      stages: [{ execution_task_id: "t_source" }],
      referenced_task_evidence: [{ task_id: "t_source", latest_completed_run: latest }],
    };
    const policyContent = "### 8｜Footer\n- 「6–10 min」\n- 「Fixed footer」\n## Next section";
    const policy = {
      policy_id: "audio-policy",
      sha256: createHash("sha256").update(policyContent, "utf8").digest("hex"),
      content: policyContent,
    };
    Object.assign(contract, {
      objective_ref: { objective_id: "objective-a", stage_key: "repair" },
      verification: { deterministic_image_render: spec },
      policy_snapshots: [policy],
      durable_evidence_snapshot: snapshot,
      user_facing_delivery: {
        kind: "content_package",
        asset_filenames: ["EP11_Best_Buy_page_hero_16x9.png", "EP11_Best_Buy_audio_brief_1x1.png"],
      },
    });
    const verification = contract.verification as Record<string, unknown>;
    if (["serialized-check", "duplicate-check", "malformed-check"].includes(fault)) {
      delete verification.deterministic_image_render;
      const check = "`verification.deterministic_image_render=" + JSON.stringify(spec) + "`";
      verification.checks =
        fault === "duplicate-check"
          ? [check, check]
          : fault === "malformed-check"
            ? ["verification.deterministic_image_render={broken}"]
            : [check];
    }
    if (fault === "conflicting-check")
      verification.checks = [
        "verification.deterministic_image_render=" +
          JSON.stringify({ ...spec, source_execution_run_id: 40 }),
      ];
    if (fault === "foreign-objective") snapshot.objective_id = "objective-b";
    if (fault === "wrong-run") latest.run_id = 40;
    if (fault === "unregistered-task") snapshot.stages = [];
    if (fault === "wrong-policy-text") spec.footer_text = "Invented footer";
    if (fault === "policy-digest-mismatch") policy.sha256 = "c".repeat(64);
    if (fault === "footer-whitespace-mutation") spec.footer_text = "6 - 1 0 min｜Fixed footer";
    if (fault === "partial-footer") spec.footer_text = "Fixed｜footer";
    if (fault === "reversed-footer") spec.footer_text = "Fixed footer｜6–10 min";
    if (fault === "missing-identifiers") {
      delete (spec as Partial<typeof spec>).source_execution_task_id;
      delete (spec as Partial<typeof spec>).source_execution_run_id;
      delete (spec as Partial<typeof spec>).policy_id;
    }
    if (fault === "multiple-filenames")
      (contract.user_facing_delivery as { asset_filenames: string[] }).asset_filenames.push(
        "Second Audio Brief.png",
      );
    const config = {
      ...DEFAULT_HERMES_BRIDGE_CONFIG,
      enabled: true,
      mode: "live" as const,
      hermesMode: "real" as const,
      idempotencyDbPath: resolve(
        mkdtempSync(resolve(tmpdir(), "footer-candidate-")),
        "bridge.sqlite",
      ),
    };
    const sessionKey = `agent:missioncrew-content:subagent:footer-${fault}`;
    if (!["valid", "serialized-check"].includes(fault)) {
      expect(() =>
        activateDeterministicImageRenderCapability(scoped, sessionKey, config),
      ).toThrow();
      return;
    }
    activateDeterministicImageRenderCapability(scoped, sessionKey, config);
    expect(
      createDeterministicImageRenderTool(
        { agentId: "missioncrew-content", sessionKey } as OpenClawPluginToolContext,
        config,
      ),
    ).not.toBeNull();
    const grantFile = `${config.idempotencyDbPath}.deterministic-image-render-grants/${createHash("sha256").update(sessionKey, "utf8").digest("hex")}.json`;
    expect(JSON.parse(readFileSync(grantFile, "utf8"))).toMatchObject({
      authorized_source_path: "/tmp/candidate.png",
      authorized_source_sha256: "a".repeat(64),
      authorized_footer_text: "6–10 min｜Fixed footer",
      authorized_source_kind: "controller_candidate",
    });
    revokeDeterministicImageRenderCapability(sessionKey, config);
  });

  it("preserves receipts through repeated polling and runtime restart until terminal revoke", async () => {
    const sessionKey = "agent:missioncrew-content:subagent:receipt";
    const currentRequest = request();
    const config = {
      ...DEFAULT_HERMES_BRIDGE_CONFIG,
      enabled: true,
      mode: "live" as const,
      hermesMode: "real" as const,
      idempotencyDbPath: resolve(
        mkdtempSync(resolve(tmpdir(), "deterministic-receipt-")),
        "bridge.sqlite",
      ),
    };
    activateDeterministicImageRenderCapability(currentRequest, sessionKey, config);
    const grantFile = `${config.idempotencyDbPath}.deterministic-image-render-grants/${createHash("sha256").update(sessionKey, "utf8").digest("hex")}.json`;
    const activeGrant = JSON.parse(readFileSync(grantFile, "utf8"));
    const receipt = recordDeterministicImageRenderReceipt(
      sessionKey,
      activeGrant,
      {
        success: true,
        path: "/tmp/output.png",
        sha256: "b".repeat(64),
        dimensions: "1254x1254",
      },
      config,
    );
    const secondReceipt = recordDeterministicImageRenderReceipt(
      sessionKey,
      activeGrant,
      {
        success: true,
        path: "/tmp/output-2.png",
        sha256: "c".repeat(64),
        dimensions: "1254x1254",
      },
      config,
    );
    expect(() =>
      recordDeterministicImageRenderReceipt(
        sessionKey,
        { ...activeGrant, authorized_source_sha256: "e".repeat(64) },
        {
          success: true,
          path: "/tmp/wrong-source.png",
          sha256: "f".repeat(64),
          dimensions: "1254x1254",
        },
        config,
      ),
    ).toThrow(/scope is no longer active/);

    expect(receipt.readback.attestedBy).toBe("openclaw_deterministic_image_render_broker");
    expect(receipt.readback.sourceSha256).toBe("a".repeat(64));
    expect(peekDeterministicImageRenderReceipts(sessionKey, currentRequest, config)).toEqual([
      receipt,
      secondReceipt,
    ]);
    expect(peekDeterministicImageRenderReceipts(sessionKey, currentRequest, config)).toEqual([
      receipt,
      secondReceipt,
    ]);
    expect(
      peekDeterministicImageRenderReceipts(
        sessionKey,
        {
          ...currentRequest,
          identity: { ...currentRequest.identity, contractFingerprint: "foreign" },
        },
        config,
      ),
    ).toEqual([]);
    const receiptFile = `${grantFile}.receipts.json`;
    const receiptBytes = readFileSync(receiptFile, "utf8");
    writeFileSync(receiptFile, JSON.stringify({ scopeId: "foreign", receipts: [receipt] }));
    expect(() => peekDeterministicImageRenderReceipts(sessionKey, currentRequest, config)).toThrow(
      /do not match/,
    );
    writeFileSync(receiptFile, receiptBytes);
    const grantBytes = readFileSync(grantFile, "utf8");
    writeFileSync(grantFile, "{}");
    expect(() => peekDeterministicImageRenderReceipts(sessionKey, currentRequest, config)).toThrow(
      /grant is invalid/,
    );
    writeFileSync(grantFile, grantBytes);
    vi.resetModules();
    const restarted = await import("./deterministic-image-render-capability.js");
    expect(
      restarted.peekDeterministicImageRenderReceipts(sessionKey, currentRequest, config),
    ).toEqual([receipt, secondReceipt]);
    // Simulate receipt-cleanup failure after authority revocation. The leftover
    // evidence path is inert and cannot restore the grant on module reload.
    unlinkSync(receiptFile);
    mkdirSync(receiptFile);
    expect(() => restarted.revokeDeterministicImageRenderCapability(sessionKey, config)).toThrow();
    vi.resetModules();
    const revoked = await import("./deterministic-image-render-capability.js");
    expect(
      revoked.peekDeterministicImageRenderReceipts(sessionKey, currentRequest, config),
    ).toEqual([]);
    expect(
      restarted.peekDeterministicImageRenderReceipts(sessionKey, currentRequest, config),
    ).toEqual([]);
    expect(() =>
      recordDeterministicImageRenderReceipt(
        sessionKey,
        activeGrant,
        {
          success: true,
          path: "/tmp/late.png",
          sha256: "d".repeat(64),
          dimensions: "1254x1254",
        },
        config,
      ),
    ).toThrow(/scope is no longer active/);
  });

  it("fences persisted authority even when grant unlink fails", async () => {
    const sessionKey = "agent:missioncrew-content:subagent:unlink-failure";
    const config = {
      ...DEFAULT_HERMES_BRIDGE_CONFIG,
      enabled: true,
      mode: "live" as const,
      hermesMode: "real" as const,
      idempotencyDbPath: resolve(mkdtempSync(resolve(tmpdir(), "render-unlink-")), "bridge.sqlite"),
    };
    activateDeterministicImageRenderCapability(request(), sessionKey, config);
    vi.mocked(unlinkSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    expect(() => revokeDeterministicImageRenderCapability(sessionKey, config)).toThrow("denied");
    vi.resetModules();
    const restarted = await import("./deterministic-image-render-capability.js");
    expect(
      restarted.createDeterministicImageRenderTool(
        { agentId: "missioncrew-content", sessionKey } as OpenClawPluginToolContext,
        config,
      ),
    ).toBeNull();
    expect(restarted.peekDeterministicImageRenderReceipts(sessionKey, request(), config)).toEqual(
      [],
    );
  });

  it.each(["success", "failure", "restart", "termination"])(
    "drains an in-flight broker (%s) before terminal revocation",
    async (scenario) => {
      const dir = mkdtempSync(resolve(tmpdir(), "render-drain-"));
      const python = resolve(dir, "broker");
      const output = resolve(dir, "output.png");
      writeFileSync(
        python,
        `#!/usr/bin/env python3
import sys,json,time,signal
json.load(sys.stdin)
${scenario === "termination" ? "signal.signal(signal.SIGTERM, signal.SIG_IGN)\nprint('X'*4096,flush=True)" : ""}
time.sleep(0.3)
with open(${JSON.stringify(output)}, "wb") as f: f.write(b"png")
${scenario === "failure" ? "sys.exit(1)" : ""}
print(json.dumps({"success":True,"path":${JSON.stringify(output)},"sha256":"${"b".repeat(64)}","dimensions":"1254x1254"}))
`,
      );
      chmodSync(python, 0o700);
      const config = {
        ...DEFAULT_HERMES_BRIDGE_CONFIG,
        enabled: true,
        mode: "live" as const,
        hermesMode: "real" as const,
        idempotencyDbPath: resolve(dir, "bridge.sqlite"),
        maxRequestBytes:
          scenario === "termination" ? 128 : DEFAULT_HERMES_BRIDGE_CONFIG.maxRequestBytes,
      };
      const sessionKey = "agent:missioncrew-content:subagent:drain";
      activateDeterministicImageRenderCapability(request(), sessionKey, config);
      const context = { agentId: "missioncrew-content", sessionKey } as OpenClawPluginToolContext;
      const tool = createDeterministicImageRenderTool(context, config)!;
      const previousPython = process.env.HERMES_PYTHON;
      process.env.HERMES_PYTHON = python;
      try {
        const execution = tool.execute("pending", {
          source_image: "/tmp/inherited-audio.png",
          output_filename: "Audio Brief.png",
          placement: "audio_brief_above_footer",
        });
        const outcome = execution.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        let drain = drainDeterministicImageRenderCapability;
        if (scenario === "restart") {
          vi.resetModules();
          drain = (await import("./deterministic-image-render-capability.js"))
            .drainDeterministicImageRenderCapability;
        }
        const draining = drain(sessionKey, config);
        expect(createDeterministicImageRenderTool(context, config)).toBeNull();
        await expect(
          tool.execute("late", { source_image: "/tmp/inherited-audio.png" }),
        ).rejects.toThrow(/no longer active/);
        expect(await draining).toBe(scenario === "success");
        const completed = await outcome;
        expect("error" in completed).toBe(["failure", "termination"].includes(scenario));
        expect(existsSync(output)).toBe(true);
        expect(peekDeterministicImageRenderReceipts(sessionKey, request(), config)).toHaveLength(
          ["failure", "termination"].includes(scenario) ? 0 : 1,
        );
        revokeDeterministicImageRenderCapability(sessionKey, config);
        expect(createDeterministicImageRenderTool(context, config)).toBeNull();
      } finally {
        if (previousPython === undefined) delete process.env.HERMES_PYTHON;
        else process.env.HERMES_PYTHON = previousPython;
      }
    },
  );

  it.each(["evidence", "audio"])("rejects duplicate inherited %s sources", (duplicate) => {
    const scoped = request();
    const contract = scoped.input.loopContract as Record<string, any>;
    const evidence = contract.durable_evidence_snapshot.referenced_task_evidence;
    if (duplicate === "evidence") evidence.push(structuredClone(evidence[0]));
    else
      evidence[0].latest_completed_run.acceptance_evidence.image_assets.push(
        structuredClone(evidence[0].latest_completed_run.acceptance_evidence.image_assets[0]),
      );
    const config = {
      ...DEFAULT_HERMES_BRIDGE_CONFIG,
      enabled: true,
      mode: "live" as const,
      hermesMode: "real" as const,
      idempotencyDbPath: resolve(
        mkdtempSync(resolve(tmpdir(), "duplicate-source-")),
        "bridge.sqlite",
      ),
    };
    expect(() =>
      activateDeterministicImageRenderCapability(scoped, "duplicate-source", config),
    ).toThrow(/no contract-bound inherited Audio Brief source/);
  });

  it("is visible only while an exact zero-effect content grant is active", async () => {
    const sessionKey = "agent:missioncrew-content:subagent:hermes-loop-test";
    const config = {
      ...DEFAULT_HERMES_BRIDGE_CONFIG,
      enabled: true,
      mode: "live" as const,
      hermesMode: "real" as const,
      idempotencyDbPath: resolve(
        mkdtempSync(resolve(tmpdir(), "deterministic-grant-")),
        "bridge.sqlite",
      ),
    };
    const context = {
      agentId: "missioncrew-content",
      sessionKey,
    } as OpenClawPluginToolContext;
    expect(createDeterministicImageRenderTool(context, config)).toBeNull();
    activateDeterministicImageRenderCapability(request(), sessionKey, config);
    const tool = createDeterministicImageRenderTool(context, config);
    expect(tool?.name).toBe("deterministic_image_render");
    await expect(
      tool!.execute("wrong-source", {
        source_image: "/tmp/unrelated-generated-image.png",
        output_filename: "Audio Brief.png",
        placement: "audio_brief_above_footer",
      }),
    ).rejects.toThrow(/exact contract-bound inherited Audio Brief/);
    vi.resetModules();
    const isolatedRuntime = await import("./deterministic-image-render-capability.js");
    const restoredTool = isolatedRuntime.createDeterministicImageRenderTool(context, config);
    expect(restoredTool?.name).toBe("deterministic_image_render");
    isolatedRuntime.revokeDeterministicImageRenderCapability(sessionKey, config);
    expect(isolatedRuntime.createDeterministicImageRenderTool(context, config)).toBeNull();
    await expect(
      tool!.execute("call-after-revoke", {
        source_image: "/tmp/source.png",
        output_filename: "Audio Brief.png",
        placement: "audio_brief_above_footer",
      }),
    ).rejects.toThrow(/no longer active/);
    revokeDeterministicImageRenderCapability(sessionKey, config);
    expect(createDeterministicImageRenderTool(context, config)).toBeNull();
  });

  it("admits a general single-image package without granting the Audio Brief renderer", () => {
    const config = {
      ...DEFAULT_HERMES_BRIDGE_CONFIG,
      enabled: true,
      mode: "live" as const,
      hermesMode: "real" as const,
      idempotencyDbPath: resolve(mkdtempSync(resolve(tmpdir(), "general-image-")), "bridge.sqlite"),
    };
    const single = request();
    single.input.loopContract.user_facing_delivery.asset_filenames = ["infographic.png"];
    const sessionKey = "agent:missioncrew-content:subagent:general-image";
    expect(() =>
      activateDeterministicImageRenderCapability(single, sessionKey, config),
    ).not.toThrow();
    expect(
      createDeterministicImageRenderTool(
        { agentId: "missioncrew-content", sessionKey } as OpenClawPluginToolContext,
        config,
      ),
    ).toBeNull();
  });

  it("does not activate a renderer for a text-only content stage and revokes an old grant", () => {
    const sessionKey = "agent:missioncrew-content:subagent:inline-source-binding";
    const config = {
      ...DEFAULT_HERMES_BRIDGE_CONFIG,
      enabled: true,
      mode: "live" as const,
      hermesMode: "real" as const,
      idempotencyDbPath: resolve(
        mkdtempSync(resolve(tmpdir(), "deterministic-inline-")),
        "bridge.sqlite",
      ),
    };
    const context = { agentId: "missioncrew-content", sessionKey } as OpenClawPluginToolContext;
    activateDeterministicImageRenderCapability(request(), sessionKey, config);
    expect(createDeterministicImageRenderTool(context, config)?.name).toBe(
      "deterministic_image_render",
    );
    const inline = request();
    inline.input.loopContract = {
      completion_mode: "intermediate",
      user_facing_delivery: {
        kind: "content_package",
        delivery: "inline_only",
        required: true,
        body_field: "domain_inventory_report",
      },
    };
    expect(() =>
      activateDeterministicImageRenderCapability(inline, sessionKey, config),
    ).not.toThrow();
    expect(createDeterministicImageRenderTool(context, config)).toBeNull();
    vi.resetModules();
  });

  it("rejects grants that include shell execution", () => {
    expect(() =>
      activateDeterministicImageRenderCapability(
        request({ allowedTools: ["image_generate", "deterministic_image_render", "exec"] }),
        "agent:missioncrew-content:subagent:unsafe",
        DEFAULT_HERMES_BRIDGE_CONFIG,
      ),
    ).toThrow(/zero-effect content-package contract/);
  });

  it("does not grant the Audio Brief renderer for an unrelated image package", () => {
    const invalid = request();
    invalid.input = {
      ...invalid.input,
      loopContract: {
        user_facing_delivery: {
          kind: "content_package",
          asset_filenames: ["Page Hero.png", "Other.png"],
        },
      },
    };
    expect(() =>
      activateDeterministicImageRenderCapability(
        invalid,
        "agent:missioncrew-content:subagent:wrong-asset",
        DEFAULT_HERMES_BRIDGE_CONFIG,
      ),
    ).not.toThrow();
  });

  it("rejects inherited evidence without concrete source task and run IDs", () => {
    const invalid = request();
    const contract = invalid.input.loopContract as Record<string, unknown>;
    contract.source_package_ref = {};
    expect(() =>
      activateDeterministicImageRenderCapability(
        invalid,
        "agent:missioncrew-content:subagent:missing-source-identity",
        DEFAULT_HERMES_BRIDGE_CONFIG,
      ),
    ).toThrow(/no contract-bound inherited Audio Brief source/);
  });
});
