// Memory Core provider tests cover plugin runtime integration.
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { describe, expect, it, vi } from "vitest";

const managerDebug = {
  backend: "qmd" as const,
  purpose: "default" as const,
  managerMs: 7,
  managerCacheState: "cached-full-hit" as const,
  qmdIdentityHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

const getMemorySearchManagerMock = vi.hoisted(() =>
  vi.fn(async () => ({
    manager: null,
    debug: managerDebug,
    error: undefined,
  })),
);

vi.mock("./memory/index.js", () => ({
  closeAllMemorySearchManagers: vi.fn(async () => {}),
  closeMemorySearchManager: vi.fn(async () => {}),
  getMemorySearchManager: getMemorySearchManagerMock,
}));

import { memoryRuntime } from "./runtime-provider.js";

describe("memoryRuntime", () => {
  it("preserves manager debug metadata", async () => {
    const cfg = {} as OpenClawConfig;

    const result = await memoryRuntime.getMemorySearchManager({
      cfg,
      agentId: "main",
    });

    expect(result.debug).toEqual(managerDebug);
    expect(getMemorySearchManagerMock).toHaveBeenCalledWith({
      cfg,
      agentId: "main",
    });
  });

  it("omits disabled mem0 from hybrid runtime backend config", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-runtime-test" } },
      memory: {
        backend: "hybrid",
        mem0: {
          enabled: false,
          baseUrl: "http://127.0.0.1:8000",
        },
        qmd: {},
      },
    } as OpenClawConfig;

    const result = memoryRuntime.resolveMemoryBackendConfig({
      cfg,
      agentId: "main",
    });

    expect(result).toMatchObject({
      backend: "hybrid",
      qmd: { command: "qmd" },
    });
    expect(result.mem0).toBeUndefined();
  });
});
