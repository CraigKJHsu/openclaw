import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerMemoryCli } from "./src/cli.js";
import {
  buildMemoryFlushPlan,
  DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES,
  DEFAULT_MEMORY_FLUSH_PROMPT,
  DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
} from "./src/flush-plan.js";
import { getMemorySearchManager } from "./src/memory/index.js";
import { registerBuiltInMemoryEmbeddingProviders } from "./src/memory/provider-adapters.js";
import { buildPromptSection } from "./src/prompt-section.js";
import { memoryRuntime } from "./src/runtime-provider.js";
import { createMemoryGetTool, createMemorySearchTool } from "./src/tools.js";

type ConversationCaptureManager = {
  captureConversation?: (params: { sessionKey?: string; messages: unknown[] }) => Promise<void>;
};
export {
  buildMemoryFlushPlan,
  DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES,
  DEFAULT_MEMORY_FLUSH_PROMPT,
  DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
} from "./src/flush-plan.js";
export { buildPromptSection } from "./src/prompt-section.js";

export default definePluginEntry({
  id: "memory-core",
  name: "Memory (Core)",
  description: "File-backed memory search tools and CLI",
  kind: "memory",
  register(api) {
    registerBuiltInMemoryEmbeddingProviders(api);
    api.registerMemoryPromptSection(buildPromptSection);
    api.registerMemoryFlushPlan(buildMemoryFlushPlan);
    api.registerMemoryRuntime(memoryRuntime);

    api.registerTool(
      (ctx) =>
        createMemorySearchTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        }),
      { names: ["memory_search"] },
    );

    api.registerTool(
      (ctx) =>
        createMemoryGetTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        }),
      { names: ["memory_get"] },
    );

    api.registerCli(
      ({ program }) => {
        registerMemoryCli(program);
      },
      {
        descriptors: [
          {
            name: "memory",
            description: "Search, inspect, and reindex memory files",
            hasSubcommands: true,
          },
        ],
      },
    );

    api.on("before_prompt_build", async (event, ctx) => {
      const agentId = ctx.agentId?.trim();
      if (!agentId) {
        return;
      }
      const { resolveMemoryBackendConfig } =
        await import("openclaw/plugin-sdk/memory-core-host-engine-storage");
      const resolved = resolveMemoryBackendConfig({ cfg: api.config, agentId });
      const mem0Config =
        resolved.backend === "mem0" || resolved.backend === "hybrid" ? resolved.mem0 : undefined;
      const isMem0 = resolved.backend === "mem0" && mem0Config?.enabled;
      const isHybrid = resolved.backend === "hybrid";
      if (!isMem0 && !isHybrid) {
        return;
      }
      const memory = await getMemorySearchManager({ cfg: api.config, agentId, purpose: "status" });
      if (!memory.manager || memory.error) {
        return;
      }
      try {
        const results = await memory.manager.search(event.prompt, {
          maxResults: isMem0 ? mem0Config?.topK : resolved.hybrid?.maxResults,
          minScore: isMem0 ? mem0Config?.threshold : undefined,
          sessionKey: ctx.sessionKey,
        });
        if (results.length === 0) {
          return;
        }
        const lines = results.map(
          (entry, index) =>
            `${index + 1}. ${entry.snippet}${entry.path ? `\n   Source: ${entry.path}` : ""}`,
        );
        return {
          prependContext: ["Relevant long-term memories from Mem0:", ...lines].join("\n"),
        };
      } catch (error) {
        api.logger.warn(`mem0 prompt recall failed: ${String(error)}`);
        return;
      }
    });

    api.on("agent_end", async (event, ctx) => {
      if (!event.success) {
        return;
      }
      const agentId = ctx.agentId?.trim();
      if (!agentId) {
        return;
      }
      const { resolveMemoryBackendConfig } =
        await import("openclaw/plugin-sdk/memory-core-host-engine-storage");
      const resolved = resolveMemoryBackendConfig({ cfg: api.config, agentId });
      const mem0Config =
        resolved.backend === "mem0" || resolved.backend === "hybrid" ? resolved.mem0 : undefined;
      const isMem0 = resolved.backend === "mem0" && mem0Config?.enabled;
      const isHybrid = resolved.backend === "hybrid";
      if (!isMem0 && !isHybrid) {
        return;
      }
      const memory = await getMemorySearchManager({ cfg: api.config, agentId });
      if (!memory.manager || memory.error) {
        return;
      }
      const captureManager = memory.manager as ConversationCaptureManager;
      if (typeof captureManager.captureConversation !== "function") {
        return;
      }
      try {
        await captureManager.captureConversation({
          sessionKey: ctx.sessionKey,
          messages: event.messages,
        });
      } catch (error) {
        api.logger.warn(`mem0 capture failed: ${String(error)}`);
      }
    });
  },
});
