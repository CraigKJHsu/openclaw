import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const MODEL_ROUTING_POLICY_ID = "missioncrew-model-routing-v1";
const STANDARD_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Model routing policy must contain JSON objects.");
  }
  return value as Record<string, unknown>;
}

export function readModelRoutingPolicies(root: string): Map<string, ReadonlySet<string>> {
  // The operator-owned Hermes registry is the trust root. Workers submit only
  // a digest; they cannot supply a registry or snapshot through tool arguments.
  const directory = resolve(root, "policies", "registry", MODEL_ROUTING_POLICY_ID);
  const manifest = record(JSON.parse(readFileSync(resolve(directory, "manifest.json"), "utf8")));
  if (manifest.policy_id !== MODEL_ROUTING_POLICY_ID || !Array.isArray(manifest.versions)) {
    throw new Error("Model routing policy registry identity is invalid.");
  }
  const policies = new Map<string, ReadonlySet<string>>();
  for (const value of manifest.versions) {
    const version = record(value);
    if (version.status !== "active" && version.status !== "superseded") continue;
    if (typeof version.version !== "string" || !/^v\d+$/.test(version.version)) {
      throw new Error("Model routing policy version is invalid.");
    }
    const raw = readFileSync(resolve(directory, "versions", `${version.version}.md`));
    const sha256 = createHash("sha256").update(raw).digest("hex");
    const policy = record(JSON.parse(raw.toString("utf8")));
    if (
      sha256 !== version.sha256 ||
      policy.policy_id !== MODEL_ROUTING_POLICY_ID ||
      policy.version !== version.version ||
      typeof policy.pro_mode_enabled !== "boolean"
    ) {
      throw new Error("Model routing policy snapshot failed identity or digest verification.");
    }
    if (policy.pro_mode_enabled) continue;
    const routes = new Set<string>();
    const add = (model: unknown, effort: unknown) => {
      if (
        typeof model === "string" &&
        model.trim() &&
        typeof effort === "string" &&
        STANDARD_EFFORTS.has(effort.trim().toLowerCase())
      )
        routes.add(JSON.stringify([model.trim(), effort.trim().toLowerCase()]));
    };
    // Issuer requests each worker's model/reasoning pair. Fallback and minimum
    // fields never select requested_model; Grace formal routes prohibit fallback.
    for (const value of Object.values(record(policy.workers))) {
      const row = record(value);
      add(row.model, row.reasoning);
    }
    if (policy.grace != null) {
      const grace = record(policy.grace);
      for (const key of ["default_reasoning", "formal_review_reasoning", "critical_reasoning"])
        add(grace.model, grace[key]);
    }
    if (policies.has(sha256)) throw new Error("Model routing policy snapshot is ambiguous.");
    policies.set(sha256, routes);
  }
  return policies;
}

let policies: Map<string, ReadonlySet<string>> | undefined;

export function modelRoutingPolicyPermits(sha256: string, model: string, effort: string): boolean {
  // The issuer's immutable versions protect pinned jobs; reload the Bridge after
  // policy activation. One process snapshot avoids request-time freshness polling.
  policies ??= readModelRoutingPolicies(process.env.HERMES_HOME || resolve(homedir(), ".hermes"));
  return policies.get(sha256)?.has(JSON.stringify([model, effort])) === true;
}
