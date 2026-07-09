// Memory Core provider module implements model/runtime integration.
import type { MemoryPluginRuntime } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveMemoryBackendConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import {
  closeAllMemorySearchManagers,
  closeMemorySearchManager,
  getMemorySearchManager,
} from "./memory/index.js";

function toRuntimeBackendConfig(
  resolved: ReturnType<typeof resolveMemoryBackendConfig>,
): ReturnType<MemoryPluginRuntime["resolveMemoryBackendConfig"]> {
  const activeMem0 = resolved.mem0?.enabled ? resolved.mem0 : undefined;
  if (resolved.backend === "mem0" && activeMem0) {
    return {
      backend: "mem0",
      mem0: {
        baseUrl: activeMem0.baseUrl,
        searchPath: activeMem0.searchPath,
        addPath: activeMem0.addPath,
        topK: activeMem0.topK,
        threshold: activeMem0.threshold,
        timeoutMs: activeMem0.timeoutMs,
      },
    };
  }
  if (resolved.backend === "hybrid") {
    return {
      backend: "hybrid",
      mem0: activeMem0
        ? {
            baseUrl: activeMem0.baseUrl,
            searchPath: activeMem0.searchPath,
            addPath: activeMem0.addPath,
            topK: activeMem0.topK,
            threshold: activeMem0.threshold,
            timeoutMs: activeMem0.timeoutMs,
          }
        : undefined,
      qmd: resolved.qmd ? { command: resolved.qmd.command } : undefined,
      hybrid: resolved.hybrid
        ? {
            readMode: resolved.hybrid.readMode,
            writeMode: resolved.hybrid.writeMode,
            successPolicy: resolved.hybrid.successPolicy,
          }
        : undefined,
    };
  }
  if (resolved.backend === "qmd") {
    return {
      backend: "qmd",
      qmd: resolved.qmd ? { command: resolved.qmd.command } : undefined,
    };
  }
  return { backend: "builtin" };
}

export const memoryRuntime: MemoryPluginRuntime = {
  async getMemorySearchManager(params) {
    const { manager, debug, error } = await getMemorySearchManager(params);
    return {
      manager,
      debug,
      error,
    };
  },
  resolveMemoryBackendConfig(params) {
    return toRuntimeBackendConfig(resolveMemoryBackendConfig(params));
  },
  async closeAllMemorySearchManagers() {
    await closeAllMemorySearchManagers();
  },
  async closeMemorySearchManager(params) {
    await closeMemorySearchManager(params);
  },
};
