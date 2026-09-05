import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { HermesBridgeConfig, HermesBridgeMode } from "./config.js";
import type { HermesBridgeIdempotencyStore } from "./idempotency-store.js";
import type { HermesBridgeRequest, HermesBridgeResult } from "./schema.js";

export type { HermesBridgeRequest, HermesBridgeResult };

export type HermesBridgeTaskContext = {
  request: HermesBridgeRequest;
  mode: HermesBridgeMode;
  config: HermesBridgeConfig;
  subagent: PluginRuntime["subagent"];
  taskRuns?: PluginRuntime["tasks"]["runs"];
  recoveredLease: boolean;
  cleanupStore?: HermesBridgeIdempotencyStore;
};

export type HermesBridgeTask = {
  taskId: string;
  description: string;
  dangerous: boolean;
  mockOnly: boolean;
  requiresDryRun?: boolean;
  requiredTools: string[];
  successSummary?: string;
  execute: (ctx: HermesBridgeTaskContext) => unknown | Promise<unknown>;
};
