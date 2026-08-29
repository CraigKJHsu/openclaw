import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("hermes-bridge plugin entry", () => {
  it("registers a gateway-auth HTTP route and optional tool", () => {
    const routes: Array<{
      path: string;
      auth: string;
      match?: string;
      gatewayRuntimeScopeSurface?: string;
    }> = [];
    const toolOptions: Array<{ name?: string; names?: string[]; optional?: boolean }> = [];
    const api = createTestPluginApi({
      pluginConfig: {
        enabled: true,
        allowedTasks: ["status.echo"],
      },
      registerHttpRoute(route) {
        routes.push(route);
      },
      registerTool(_tool, opts) {
        toolOptions.push(opts ?? {});
      },
    });

    plugin.register(api);

    expect(routes).toMatchObject([
      {
        path: "/api/plugins/hermes-bridge/tasks",
        auth: "gateway",
        match: "exact",
        gatewayRuntimeScopeSurface: "trusted-operator",
      },
    ]);
    expect(toolOptions).toContainEqual({
      name: "hermes_bridge",
      optional: true,
    });
    expect(toolOptions).toContainEqual({
      names: [
        "facebook_page_publish_preflight",
        "facebook_page_graph_status",
        "facebook_page_graph_publish",
      ],
      optional: true,
    });
  });

  it("does not open the SQLite store when the plugin is disabled", () => {
    const api = createTestPluginApi({
      pluginConfig: {
        enabled: false,
        idempotencyDbPath: "/dev/null/hermes-bridge.sqlite",
      },
    });

    expect(() => plugin.register(api)).not.toThrow();
  });
});
