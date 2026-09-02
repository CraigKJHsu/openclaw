import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveHermesBridgeConfig } from "./src/config.js";
import { createFacebookPageCapabilityTools } from "./src/facebook-page-capability.js";
import { createHermesBridgeHttpHandler } from "./src/http-route.js";
import { SqliteHermesBridgeIdempotencyStore } from "./src/idempotency-store.js";
import { sweepHermesBridgeCleanupObligations } from "./src/task-registry.js";
import { createHermesBridgeTool } from "./src/tool.js";

export default definePluginEntry({
  id: "hermes-bridge",
  name: "Hermes Bridge",
  description: "Local delegation bridge from Hermes Agent to OpenClaw task templates.",
  register(api) {
    const resolveConfig = () => resolveHermesBridgeConfig(api.pluginConfig);
    let idempotencyStore: SqliteHermesBridgeIdempotencyStore | undefined;
    let cleanupTimer: ReturnType<typeof setInterval> | undefined;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupRunning = false;
    const runCleanupSweep = async () => {
      if (!idempotencyStore || cleanupRunning) {
        return;
      }
      cleanupRunning = true;
      try {
        await sweepHermesBridgeCleanupObligations({
          store: idempotencyStore,
          subagent: api.runtime.subagent,
          config: resolveConfig(),
        });
      } finally {
        cleanupRunning = false;
      }
    };
    const resolveIdempotencyStore = () => {
      idempotencyStore ??= new SqliteHermesBridgeIdempotencyStore(
        resolveConfig().idempotencyDbPath,
      );
      if (!cleanupTimer) {
        cleanupTimer = setInterval(() => {
          void runCleanupSweep().catch(() => undefined);
        }, 30_000);
        cleanupTimer.unref();
        void runCleanupSweep().catch(() => undefined);
      }
      return idempotencyStore;
    };
    if (resolveConfig().enabled) {
      startupTimer = setTimeout(() => {
        try {
          resolveIdempotencyStore();
        } catch {
          // Keep plugin registration alive. The first request returns the
          // structured idempotency_store_unavailable result with details.
        }
      }, 0);
      startupTimer.unref();
    }
    api.lifecycle.registerRuntimeLifecycle({
      id: "hermes-bridge-idempotency",
      description: "Close the Hermes bridge persistent idempotency database.",
      cleanup: () => {
        if (cleanupTimer) {
          clearInterval(cleanupTimer);
        }
        if (startupTimer) {
          clearTimeout(startupTimer);
        }
        idempotencyStore?.close();
      },
    });

    api.registerHttpRoute({
      path: "/api/plugins/hermes-bridge/tasks",
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: createHermesBridgeHttpHandler({
        resolveConfig,
        env: process.env,
        resolveIdempotencyStore,
        subagent: api.runtime.subagent,
        taskRuns: api.runtime.tasks?.runs,
      }),
    });

    api.registerTool(
      () => {
        const config = resolveConfig();
        if (!config.enabled) {
          return null;
        }
        return createHermesBridgeTool({ config });
      },
      { name: "hermes_bridge", optional: true },
    );
    api.registerTool((ctx) => createFacebookPageCapabilityTools(ctx, resolveConfig()), {
      names: [
        "facebook_page_publish_preflight",
        "facebook_page_graph_status",
        "facebook_page_graph_publish",
      ],
      optional: true,
    });
  },
});
