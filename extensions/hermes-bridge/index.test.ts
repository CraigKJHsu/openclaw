import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { createHermesBridgeHttpHandler } from "./src/http-route.js";

vi.mock("./src/http-route.js", () => ({ createHermesBridgeHttpHandler: vi.fn() }));
vi.mock("./src/task-registry.js", () => ({
  sweepHermesBridgeCleanupObligations: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("reopens the same durable store after runtime cleanup without losing a claim", () => {
  vi.useFakeTimers();
  const directory = mkdtempSync(join(tmpdir(), "hermes-lifecycle-"));
  const registerRuntimeLifecycle = vi.fn();
  plugin.register({
    pluginConfig: { enabled: true, idempotencyDbPath: join(directory, "bridge.sqlite") },
    runtime: { subagent: {}, tasks: {} },
    lifecycle: { registerRuntimeLifecycle },
    registerHttpRoute: vi.fn(),
    registerTool: vi.fn(),
  } as never);
  const resolveStore = vi.mocked(createHermesBridgeHttpHandler).mock.calls[0]![0]
    .resolveIdempotencyStore!;
  const cleanup = registerRuntimeLifecycle.mock.calls[0]![0].cleanup;
  try {
    const first = resolveStore();
    expect(
      first.claim("request", "hash", { ownerId: "first", leaseMs: 1000, nowMs: 1000 }),
    ).toEqual({ status: "claimed", recovered: false });
    cleanup();
    cleanup();
    const reopened = resolveStore();
    expect(reopened === first).toBe(false);
    expect(
      reopened.claim("request", "hash", { ownerId: "second", leaseMs: 1000, nowMs: 1500 }),
    ).toEqual({ status: "pending", requestHash: "hash" });
    expect(
      reopened.claim("request", "hash", { ownerId: "second", leaseMs: 1000, nowMs: 2001 }),
    ).toEqual({ status: "claimed", recovered: true });
  } finally {
    cleanup();
  }
});
