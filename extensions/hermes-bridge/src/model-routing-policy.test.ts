import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { readFileSync } = vi.hoisted(() => ({ readFileSync: vi.fn() }));
vi.mock("node:fs", () => ({ readFileSync }));
import {
  MODEL_ROUTING_POLICY_ID,
  modelRoutingPolicyPermits,
  readModelRoutingPolicies,
} from "./model-routing-policy.js";

function fixture(fault = "none", version = "v5") {
  const policy = {
    policy_id: MODEL_ROUTING_POLICY_ID,
    version,
    pro_mode_enabled: fault === "pro",
    grace: {
      model: "grace-primary",
      fallback_model: "grace-fallback",
      default_reasoning: "medium",
      formal_review_reasoning: "high",
    },
    memory_promotion: { minimum_model: "minimum-only", minimum_reasoning: "high" },
    workers: {
      default: {
        model: fault === "canonical" ? " fixture-model " : "fixture-model",
        fallback_model: "fixture-fallback",
        reasoning: fault === "ultra" ? "ultra" : fault === "canonical" ? " Medium " : "medium",
      },
    },
  };
  const raw = JSON.stringify(policy);
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const manifest = {
    policy_id: MODEL_ROUTING_POLICY_ID,
    active_version: version,
    versions: [
      {
        version: fault === "path" ? "../escape" : version,
        sha256,
        status: fault === "historical" ? "superseded" : "active",
      },
    ],
  };
  readFileSync.mockImplementation((path: string) =>
    path.endsWith("manifest.json")
      ? JSON.stringify(manifest)
      : Buffer.from(raw + (fault === "tamper" ? " " : "")),
  );
  return sha256;
}

beforeEach(() => {
  readFileSync.mockReset();
});

describe("issuer-verified model routing policy snapshots", () => {
  it.each(["none", "historical", "canonical"])("loads registered non-Pro routes: %s", (fault) => {
    const sha256 = fixture(fault);
    const routes = readModelRoutingPolicies("/fixture").get(sha256);
    expect(routes?.has(JSON.stringify(["fixture-model", "medium"]))).toBe(true);
    expect(routes?.has(JSON.stringify(["fixture-fallback", "medium"]))).toBe(false);
    expect(routes?.has(JSON.stringify(["grace-primary", "high"]))).toBe(true);
    expect(routes?.has(JSON.stringify(["grace-fallback", "high"]))).toBe(false);
    expect(routes?.has(JSON.stringify(["minimum-only", "high"]))).toBe(false);
    expect(routes?.has(JSON.stringify(["unregistered-model", "medium"]))).toBe(false);
  });

  it.each(["tamper", "path"])("rejects invalid registered snapshots: %s", (fault) => {
    fixture(fault);
    expect(() => readModelRoutingPolicies("/fixture")).toThrow();
  });

  it.each(["pro", "ultra"])("does not grant forbidden routes: %s", (fault) => {
    const sha256 = fixture(fault);
    const routes = readModelRoutingPolicies("/fixture").get(sha256);
    expect(
      routes?.has(JSON.stringify(["fixture-model", fault === "ultra" ? "ultra" : "medium"])) ===
        true,
    ).toBe(false);
  });

  it("accepts a new registered version without a code allowlist update", () => {
    const sha256 = fixture("none", "v123");
    expect(
      readModelRoutingPolicies("/fixture")
        .get(sha256)
        ?.has(JSON.stringify(["fixture-model", "medium"])),
    ).toBe(true);
  });

  it("keeps one bounded process snapshot until the Bridge reloads", () => {
    const sha256 = fixture();
    expect(modelRoutingPolicyPermits(sha256, "fixture-model", "medium")).toBe(true);
    readFileSync.mockImplementation(() => {
      throw new Error("unexpected freshness polling");
    });
    expect(modelRoutingPolicyPermits(sha256, "fixture-model", "medium")).toBe(true);
    expect(modelRoutingPolicyPermits("unregistered", "fixture-model", "medium")).toBe(false);
  });
});
