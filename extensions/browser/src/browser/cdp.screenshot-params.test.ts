// Browser tests cover cdp.screenshot params plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withCdpSocket } from "./cdp.helpers.js";
import { captureScreenshot } from "./cdp.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { shouldUsePlaywrightForScreenshot } from "./profile-capabilities.js";

const sentMessages = vi.hoisted(() => {
  const msgs: Array<{ method: string; params?: Record<string, unknown> }> = [];
  return msgs;
});

const mockState = vi.hoisted(() => ({ viewport: { w: 800, h: 600 } }));

vi.mock("./cdp.helpers.js", () => ({
  withCdpSocket: vi.fn(
    async (
      _wsUrl: string,
      fn: (send: unknown) => Promise<unknown>,
      _opts?: { commandTimeoutMs?: number },
    ) => {
      const send = (method: string, params?: Record<string, unknown>) => {
        sentMessages.push({ method, params });
        if (method === "Page.captureScreenshot") {
          return Promise.resolve({ data: "AAAA" });
        }
        if (method === "Page.getLayoutMetrics") {
          return Promise.resolve({
            cssContentSize: { width: 1200, height: 3000 },
            contentSize: { width: 1200, height: 3000 },
            cssLayoutViewport: {
              clientWidth: mockState.viewport.w,
              clientHeight: mockState.viewport.h,
            },
          });
        }
        return Promise.resolve({});
      };
      return fn(send);
    },
  ),
  appendCdpPath: vi.fn(),
  fetchJson: vi.fn(),
  isLoopbackHost: vi.fn(),
  isWebSocketUrl: vi.fn(),
}));

vi.mock("./navigation-guard.js", () => ({
  assertBrowserNavigationAllowed: vi.fn(),
  withBrowserNavigationPolicy: vi.fn(() => ({})),
}));

const localProfile: ResolvedBrowserProfile = {
  name: "openclaw",
  cdpUrl: "http://127.0.0.1:18800",
  cdpPort: 18800,
  cdpHost: "127.0.0.1",
  cdpIsLoopback: true,
  color: "#FF4500",
  driver: "openclaw",
  headless: false,
  attachOnly: false,
};

beforeEach(() => {
  sentMessages.length = 0;
  mockState.viewport = { w: 800, h: 600 };
});

function requireSentMessage(method: string) {
  const message = sentMessages.find((m) => m.method === method);
  if (!message) {
    throw new Error(`expected ${method} CDP message`);
  }
  return message;
}

describe("CDP screenshot params", () => {
  it("captures full-page with a clip without mutating viewport state", async () => {
    await captureScreenshot({ wsUrl: "ws://localhost:9222/devtools/page/X", fullPage: true });

    expect(requireSentMessage("Page.captureScreenshot").params).toMatchObject({
      clip: { x: 0, y: 0, width: 1200, height: 3000, scale: 1 },
      captureBeyondViewport: true,
    });
    expect(sentMessages.some(({ method }) => method.startsWith("Emulation."))).toBe(false);
  });

  it("viewport screenshot omits fromSurface and captureBeyondViewport", async () => {
    await captureScreenshot({ wsUrl: "ws://localhost:9222/devtools/page/X", format: "png" });

    const call = requireSentMessage("Page.captureScreenshot");
    expect(call.params?.format).toBe("png");
    expect(call.params).not.toHaveProperty("fromSurface");
    expect(call.params).not.toHaveProperty("captureBeyondViewport");
    expect(call.params).not.toHaveProperty("clip");

    const emulationCalls = sentMessages.filter(
      (m) => m.method === "Emulation.setDeviceMetricsOverride",
    );
    expect(emulationCalls).toHaveLength(0);
  });

  it("uses the requested timeout as the raw CDP command timeout", async () => {
    await captureScreenshot({
      wsUrl: "ws://localhost:9222/devtools/page/X",
      format: "png",
      timeoutMs: 12_345,
    });

    const [wsUrl, sendCallback, options] =
      (withCdpSocket as unknown as { mock: { calls: Array<Array<unknown>> } }).mock.calls.at(-1) ??
      [];
    expect(wsUrl).toBe("ws://localhost:9222/devtools/page/X");
    expect(typeof sendCallback).toBe("function");
    expect(options).toEqual({ commandTimeoutMs: 12_345 });
  });

  it("full-page clip never shrinks below the current CSS viewport", async () => {
    mockState.viewport = { w: 1920, h: 4096 };
    await captureScreenshot({ wsUrl: "ws://localhost:9222/devtools/page/X", fullPage: true });
    expect(requireSentMessage("Page.captureScreenshot").params?.clip).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 4096,
      scale: 1,
    });
    expect(sentMessages.some(({ method }) => method.startsWith("Emulation."))).toBe(false);
  });
});

describe("shouldUsePlaywrightForScreenshot routing", () => {
  it("returns false for a normal viewport screenshot with wsUrl", () => {
    expect(shouldUsePlaywrightForScreenshot({ profile: localProfile, wsUrl: "ws://x" })).toBe(
      false,
    );
  });

  it("returns true when wsUrl is missing", () => {
    expect(shouldUsePlaywrightForScreenshot({ profile: localProfile })).toBe(true);
  });

  it("returns true when ref is specified", () => {
    expect(
      shouldUsePlaywrightForScreenshot({ profile: localProfile, wsUrl: "ws://x", ref: "btn-1" }),
    ).toBe(true);
  });

  it("returns true when element is specified", () => {
    expect(
      shouldUsePlaywrightForScreenshot({
        profile: localProfile,
        wsUrl: "ws://x",
        element: "#submit",
      }),
    ).toBe(true);
  });
});
