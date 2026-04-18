import { Command } from "commander";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin, {
  buildMemoryFlushPlan,
  buildPromptSection,
  DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES,
  DEFAULT_MEMORY_FLUSH_PROMPT,
  DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
} from "./index.js";
import * as memoryIndex from "./src/memory/index.js";
import { Mem0MemoryManager } from "./src/memory/mem0-manager.js";
import { memoryRuntime } from "./src/runtime-provider.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildPromptSection", () => {
  it("returns empty when no memory tools are available", () => {
    expect(buildPromptSection({ availableTools: new Set() })).toEqual([]);
  });

  it("describes the two-step flow when both memory tools are available", () => {
    const result = buildPromptSection({
      availableTools: new Set(["memory_search", "memory_get"]),
    });
    expect(result[0]).toBe("## Memory Recall");
    expect(result[1]).toContain("run memory_search");
    expect(result[1]).toContain("then use memory_get");
    expect(result).toContain(
      "Citations: include Source: <path#line> when it helps the user verify memory snippets.",
    );
    expect(result.at(-1)).toBe("");
  });

  it("limits the guidance to memory_search when only search is available", () => {
    const result = buildPromptSection({ availableTools: new Set(["memory_search"]) });
    expect(result[0]).toBe("## Memory Recall");
    expect(result[1]).toContain("run memory_search");
    expect(result[1]).not.toContain("then use memory_get");
  });

  it("limits the guidance to memory_get when only get is available", () => {
    const result = buildPromptSection({ availableTools: new Set(["memory_get"]) });
    expect(result[0]).toBe("## Memory Recall");
    expect(result[1]).toContain("run memory_get");
    expect(result[1]).not.toContain("run memory_search");
  });

  it("includes citations-off instruction when citationsMode is off", () => {
    const result = buildPromptSection({
      availableTools: new Set(["memory_search"]),
      citationsMode: "off",
    });
    expect(result).toContain(
      "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks.",
    );
  });
});

describe("buildMemoryFlushPlan", () => {
  const cfg = {
    agents: {
      defaults: {
        userTimezone: "America/New_York",
        timeFormat: "12",
      },
    },
  } as OpenClawConfig;

  it("replaces YYYY-MM-DD using user timezone and appends current time", () => {
    const plan = buildMemoryFlushPlan({
      cfg: {
        ...cfg,
        agents: {
          ...cfg.agents,
          defaults: {
            ...cfg.agents?.defaults,
            compaction: {
              memoryFlush: {
                prompt: "Store durable notes in memory/YYYY-MM-DD.md",
              },
            },
          },
        },
      },
      nowMs: Date.UTC(2026, 1, 16, 15, 0, 0),
    });

    expect(plan?.prompt).toContain("memory/2026-02-16.md");
    expect(plan?.prompt).toContain(
      "Current time: Monday, February 16th, 2026 — 10:00 AM (America/New_York) / 2026-02-16 15:00 UTC",
    );
    expect(plan?.relativePath).toBe("memory/2026-02-16.md");
  });

  it("does not append a duplicate current time line", () => {
    const plan = buildMemoryFlushPlan({
      cfg: {
        ...cfg,
        agents: {
          ...cfg.agents,
          defaults: {
            ...cfg.agents?.defaults,
            compaction: {
              memoryFlush: {
                prompt: "Store notes.\nCurrent time: already present",
              },
            },
          },
        },
      },
      nowMs: Date.UTC(2026, 1, 16, 15, 0, 0),
    });

    expect(plan?.prompt).toContain("Current time: already present");
    expect((plan?.prompt.match(/Current time:/g) ?? []).length).toBe(1);
  });

  it("defaults to safe prompts and gating values", () => {
    const plan = buildMemoryFlushPlan();
    expect(plan).not.toBeNull();
    expect(plan?.softThresholdTokens).toBe(DEFAULT_MEMORY_FLUSH_SOFT_TOKENS);
    expect(plan?.forceFlushTranscriptBytes).toBe(DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES);
    expect(plan?.prompt).toContain("memory/");
    expect(plan?.prompt).toContain("MEMORY.md");
    expect(plan?.systemPrompt).toContain("MEMORY.md");
  });

  it("respects disable flag", () => {
    expect(
      buildMemoryFlushPlan({
        cfg: {
          agents: {
            defaults: { compaction: { memoryFlush: { enabled: false } } },
          },
        },
      }),
    ).toBeNull();
  });

  it("falls back to defaults when numeric values are invalid", () => {
    const plan = buildMemoryFlushPlan({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              reserveTokensFloor: Number.NaN,
              memoryFlush: {
                softThresholdTokens: -100,
              },
            },
          },
        },
      },
    });

    expect(plan?.softThresholdTokens).toBe(DEFAULT_MEMORY_FLUSH_SOFT_TOKENS);
    expect(plan?.forceFlushTranscriptBytes).toBe(DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES);
    expect(plan?.reserveTokensFloor).toBe(20_000);
  });

  it("parses forceFlushTranscriptBytes from byte-size strings", () => {
    const plan = buildMemoryFlushPlan({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              memoryFlush: {
                forceFlushTranscriptBytes: "3mb",
              },
            },
          },
        },
      },
    });

    expect(plan?.forceFlushTranscriptBytes).toBe(3 * 1024 * 1024);
  });

  it("keeps overwrite guards in the default prompt", () => {
    expect(DEFAULT_MEMORY_FLUSH_PROMPT).toMatch(/APPEND/i);
    expect(DEFAULT_MEMORY_FLUSH_PROMPT).toContain("do not overwrite");
    expect(DEFAULT_MEMORY_FLUSH_PROMPT).toContain("timestamped variant");
    expect(DEFAULT_MEMORY_FLUSH_PROMPT).toContain("YYYY-MM-DD.md");
  });
});

describe("Mem0 lifecycle hooks", () => {
  it("injects prepend context via before_prompt_build for mem0 backend", async () => {
    const hooks = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const mockManager = {
      search: vi.fn(async () => [
        {
          path: "mem0/abc",
          startLine: 1,
          endLine: 1,
          score: 0.91,
          snippet: "使用者偏好在晚上 9 點後通知。",
          source: "memory" as const,
        },
      ]),
      captureConversation: vi.fn(async () => {}),
    };
    Object.setPrototypeOf(mockManager, Mem0MemoryManager.prototype);
    const getManagerSpy = vi
      .spyOn(memoryIndex, "getMemorySearchManager")
      .mockResolvedValue({ manager: mockManager as unknown as Mem0MemoryManager });
    const api = {
      config: {
        memory: { backend: "mem0", mem0: { baseUrl: "http://127.0.0.1:8000" } },
      } as OpenClawConfig,
      registerMemoryPromptSection: vi.fn(),
      registerMemoryFlushPlan: vi.fn(),
      registerMemoryRuntime: vi.fn(),
      registerTool: vi.fn(),
      registerCli: vi.fn(),
      registerMemoryEmbeddingProvider: vi.fn(),
      on: vi.fn((name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
        hooks.set(name, handler);
      }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as Parameters<NonNullable<typeof plugin.register>>[0];

    plugin.register?.(api);
    const handler = hooks.get("before_prompt_build");
    expect(handler).toBeDefined();
    const result = await handler?.(
      { prompt: "我什麼時候喜歡收到提醒？", messages: [] },
      { agentId: "main", sessionKey: "telegram:direct:u1" },
    );

    expect(getManagerSpy).toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        prependContext: expect.stringContaining("Relevant long-term memories from Mem0"),
      }),
    );
  });

  it("captures user messages on agent_end for mem0 backend", async () => {
    const hooks = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const mockManager = {
      search: vi.fn(async () => []),
      captureConversation: vi.fn(async () => {}),
    };
    Object.setPrototypeOf(mockManager, Mem0MemoryManager.prototype);
    const getManagerSpy = vi
      .spyOn(memoryIndex, "getMemorySearchManager")
      .mockResolvedValue({ manager: mockManager as unknown as Mem0MemoryManager });
    const api = {
      config: {
        memory: { backend: "mem0", mem0: { baseUrl: "http://127.0.0.1:8000" } },
      } as OpenClawConfig,
      registerMemoryPromptSection: vi.fn(),
      registerMemoryFlushPlan: vi.fn(),
      registerMemoryRuntime: vi.fn(),
      registerTool: vi.fn(),
      registerCli: vi.fn(),
      registerMemoryEmbeddingProvider: vi.fn(),
      on: vi.fn((name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
        hooks.set(name, handler);
      }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as Parameters<NonNullable<typeof plugin.register>>[0];

    plugin.register?.(api);
    const handler = hooks.get("agent_end");
    expect(handler).toBeDefined();
    await handler?.(
      {
        success: true,
        messages: [{ role: "user", content: "我偏好每週報表。" }],
      },
      { agentId: "main", sessionKey: "telegram:direct:u1" },
    );

    expect(getManagerSpy).toHaveBeenCalled();
    expect(mockManager.captureConversation).toHaveBeenCalledWith({
      sessionKey: "telegram:direct:u1",
      messages: [{ role: "user", content: "我偏好每週報表。" }],
    });
  });

  it("captures user messages on agent_end for hybrid backend", async () => {
    const hooks = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const mockManager = {
      search: vi.fn(async () => []),
      captureConversation: vi.fn(async () => {}),
    };
    const getManagerSpy = vi
      .spyOn(memoryIndex, "getMemorySearchManager")
      .mockResolvedValue({ manager: mockManager as unknown as Mem0MemoryManager });
    const api = {
      config: {
        memory: {
          backend: "hybrid",
          mem0: { baseUrl: "http://127.0.0.1:8000" },
          qmd: {},
          hybrid: {
            read: { mode: "routed", order: ["mem0", "qmd"] },
            write: { mode: "routed", successPolicy: "any" },
          },
        },
      } as OpenClawConfig,
      registerMemoryPromptSection: vi.fn(),
      registerMemoryFlushPlan: vi.fn(),
      registerMemoryRuntime: vi.fn(),
      registerTool: vi.fn(),
      registerCli: vi.fn(),
      registerMemoryEmbeddingProvider: vi.fn(),
      on: vi.fn((name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
        hooks.set(name, handler);
      }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as Parameters<NonNullable<typeof plugin.register>>[0];

    plugin.register?.(api);
    const handler = hooks.get("agent_end");
    expect(handler).toBeDefined();
    await handler?.(
      {
        success: true,
        messages: [{ role: "user", content: "目前交易心態偏保守。" }],
      },
      { agentId: "main", sessionKey: "telegram:direct:u1" },
    );

    expect(getManagerSpy).toHaveBeenCalled();
    expect(mockManager.captureConversation).toHaveBeenCalledWith({
      sessionKey: "telegram:direct:u1",
      messages: [{ role: "user", content: "目前交易心態偏保守。" }],
    });
  });
});
