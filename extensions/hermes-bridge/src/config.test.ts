import { describe, expect, it } from "vitest";
import { DEFAULT_HERMES_BRIDGE_CONFIG, resolveHermesBridgeConfig } from "./config.js";

describe("resolveHermesBridgeConfig", () => {
  it("defaults to disabled mock mode", () => {
    expect(resolveHermesBridgeConfig(undefined)).toEqual(DEFAULT_HERMES_BRIDGE_CONFIG);
  });

  it("normalizes supported config values", () => {
    expect(
      resolveHermesBridgeConfig({
        enabled: true,
        mode: "live",
        hermesMode: "real",
        hermesAgentPath: " ../hermes-agent ",
        sharedSecretEnv: " HERMES_TOKEN ",
        allowedTasks: ["status.echo", "status.echo", " message.preview ", "", 42],
        allowedTools: ["telegram.send", "telegram.send", " shell ", "", false],
        maxRequestBytes: 128,
      }),
    ).toEqual({
      enabled: true,
      mode: "live",
      hermesMode: "real",
      hermesAgentPath: "../hermes-agent",
      sharedSecretEnv: "HERMES_TOKEN",
      allowedTasks: ["status.echo", "message.preview"],
      allowedTools: ["telegram.send", "shell"],
      maxRequestBytes: 128,
      idempotencyDbPath: "~/.openclaw/hermes-bridge-idempotency.sqlite",
      readonlyBrowserAgentId: "missioncrew-browser-readonly",
      maxLiveRuntimeSeconds: 120,
    });
  });

  it("falls back from fractional limits and non-fixed reviewer identities", () => {
    expect(
      resolveHermesBridgeConfig({
        maxRequestBytes: 0.5,
        maxLiveRuntimeSeconds: 0.5,
        readonlyBrowserAgentId: "unexpected-agent",
      }),
    ).toMatchObject({
      maxRequestBytes: 262_144,
      maxLiveRuntimeSeconds: 120,
      readonlyBrowserAgentId: "missioncrew-browser-readonly",
    });
  });

  it("rejects live runtime values that can overflow timer or lease arithmetic", () => {
    expect(
      resolveHermesBridgeConfig({
        maxLiveRuntimeSeconds: Number.MAX_SAFE_INTEGER,
      }).maxLiveRuntimeSeconds,
    ).toBe(120);
    expect(resolveHermesBridgeConfig({ maxLiveRuntimeSeconds: 3_600 }).maxLiveRuntimeSeconds).toBe(
      3_600,
    );
  });
});
