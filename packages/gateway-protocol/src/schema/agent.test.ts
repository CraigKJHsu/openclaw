// Gateway Protocol tests cover agent behavior.
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { AgentParamsSchema } from "./agent.js";

/**
 * Regression coverage for agent-run schema payloads that carry internal
 * completion events. These events are produced by child automation and consumed
 * by parent agent runs, so the fixture mirrors the cross-runtime boundary.
 */
type AgentInternalEvent = {
  type: "task_completion";
  source: string;
  childSessionKey: string;
  childSessionId: string;
  announceType: string;
  taskLabel: string;
  status: "ok" | "error";
  statusLabel: string;
  result: string;
  attachments?: unknown[];
  mediaUrls?: string[];
  replyInstruction?: string;
};

/** Builds the smallest valid agent request that embeds one internal event. */
function makeAgentParamsWithInternalEvent(event: AgentInternalEvent) {
  return {
    message: "A music generation task finished. Process the completion update now.",
    sessionKey: "agent:main:discord:channel:1456744319972282449",
    internalEvents: [event],
    idempotencyKey: "music_generate:task-123:ok",
  };
}

/** Representative generated-media completion event from a child task. */
const musicCompletionEvent: AgentInternalEvent = {
  type: "task_completion",
  source: "music_generation",
  childSessionKey: "music_generate:task-123",
  childSessionId: "task-123",
  announceType: "music generation task",
  taskLabel: "OpenClaw release anthem",
  status: "ok",
  statusLabel: "completed successfully",
  result: "Generated 1 track.",
  attachments: [
    {
      type: "audio",
      path: "/tmp/openclaw/generated-release-anthem.mp3",
      mimeType: "audio/mpeg",
      name: "generated-release-anthem.mp3",
    },
  ],
  mediaUrls: ["/tmp/openclaw/generated-release-anthem.mp3"],
  replyInstruction: "Deliver the generated music.",
};

describe("AgentParamsSchema", () => {
  it("accepts an explicit empty per-run tool allowlist", () => {
    expect(
      Value.Check(AgentParamsSchema, {
        message: "review evidence",
        idempotencyKey: "run-without-tools",
        toolsAllow: [],
        disableTools: true,
      }),
    ).toBe(true);
  });

  it("accepts generated music attachments on internal completion events", () => {
    const params = makeAgentParamsWithInternalEvent(musicCompletionEvent);

    expect(Value.Check(AgentParamsSchema, params)).toBe(true);
  });

  it.each([
    [{}, true],
    [{ width: 0 }, false],
    [{ height: 1.5 }, false],
    [{ dimensions: "unknown" }, false],
    [{ sha256: "invalid" }, false],
    [{ unexpected: true }, false],
  ])("validates image completion metadata: %j", (override, valid) => {
    const params = makeAgentParamsWithInternalEvent({
      ...musicCompletionEvent,
      source: "image_generation",
      attachments: [{
        type: "image",
        path: "/tmp/openclaw/hero.png",
        mimeType: "image/png",
        name: "hero.png",
        width: 1536,
        height: 864,
        dimensions: "1536x864",
        sha256: "a".repeat(64),
        ...override,
      }],
    });
    expect(Value.Check(AgentParamsSchema, params)).toBe(valid);
  });

  it("keeps task completion internal events strict", () => {
    const params = makeAgentParamsWithInternalEvent({
      ...musicCompletionEvent,
      unexpected: true,
    } as AgentInternalEvent);

    expect(Value.Check(AgentParamsSchema, params)).toBe(false);
  });

  it("rejects malformed generated attachment entries on internal events", () => {
    const params = makeAgentParamsWithInternalEvent({
      ...musicCompletionEvent,
      attachments: [null],
    } as unknown as AgentInternalEvent);

    expect(Value.Check(AgentParamsSchema, params)).toBe(false);
  });
});
