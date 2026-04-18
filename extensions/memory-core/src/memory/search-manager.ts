import {
  createSubsystemLogger,
  resolveAgentWorkspaceDir,
  resolveGlobalSingleton,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { checkQmdBinaryAvailability } from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import {
  resolveMemoryBackendConfig,
  type MemoryEmbeddingProbeResult,
  type MemorySearchManager,
  type MemorySyncProgressUpdate,
  type ResolvedHybridConfig,
  type ResolvedMem0Config,
  type ResolvedQmdConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

const MEMORY_SEARCH_MANAGER_CACHE_KEY = Symbol.for("openclaw.memorySearchManagerCache");
type MemorySearchManagerCacheStore = {
  qmdManagerCache: Map<string, MemorySearchManager>;
  mem0ManagerCache: Map<string, MemorySearchManager>;
  hybridManagerCache: Map<string, MemorySearchManager>;
};

function getMemorySearchManagerCacheStore(): MemorySearchManagerCacheStore {
  // Keep caches reachable across `vi.resetModules()` so later cleanup can close older instances.
  return resolveGlobalSingleton<MemorySearchManagerCacheStore>(
    MEMORY_SEARCH_MANAGER_CACHE_KEY,
    () => ({
      qmdManagerCache: new Map<string, MemorySearchManager>(),
      mem0ManagerCache: new Map<string, MemorySearchManager>(),
      hybridManagerCache: new Map<string, MemorySearchManager>(),
    }),
  );
}

const log = createSubsystemLogger("memory");
const {
  qmdManagerCache: QMD_MANAGER_CACHE,
  mem0ManagerCache: MEM0_MANAGER_CACHE,
  hybridManagerCache: HYBRID_MANAGER_CACHE,
} = getMemorySearchManagerCacheStore();
let managerRuntimePromise: Promise<typeof import("./manager-runtime.js")> | null = null;

function loadManagerRuntime() {
  managerRuntimePromise ??= import("./manager-runtime.js");
  return managerRuntimePromise;
}

export type MemorySearchManagerResult = {
  manager: MemorySearchManager | null;
  error?: string;
};

async function getOrCreateMem0Manager(params: {
  cfg: OpenClawConfig;
  agentId: string;
  resolvedMem0?: ResolvedMem0Config;
}): Promise<MemorySearchManager | null> {
  if (!params.resolvedMem0?.enabled) {
    return null;
  }
  const cacheKey = `${params.agentId}:${JSON.stringify(params.resolvedMem0)}`;
  const cached = MEM0_MANAGER_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }
  try {
    const { Mem0MemoryManager } = await import("./mem0-manager.js");
    const manager = await Mem0MemoryManager.create({
      cfg: params.cfg,
      agentId: params.agentId,
      resolved: params.resolvedMem0,
    });
    if (manager) {
      MEM0_MANAGER_CACHE.set(cacheKey, manager);
      return manager;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`mem0 memory unavailable; falling back to builtin: ${message}`);
  }
  return null;
}

async function getOrCreateQmdManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
  resolvedQmd?: ResolvedQmdConfig;
  purpose?: "default" | "status";
}): Promise<MemorySearchManager | null> {
  if (!params.resolvedQmd) {
    return null;
  }
  const statusOnly = params.purpose === "status";
  const baseCacheKey = buildQmdCacheKey(params.agentId, params.resolvedQmd);
  const cacheKey = `${baseCacheKey}:${statusOnly ? "status" : "full"}`;
  const cached = QMD_MANAGER_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }
  if (statusOnly) {
    const fullCached = QMD_MANAGER_CACHE.get(`${baseCacheKey}:full`);
    if (fullCached) {
      return new BorrowedMemoryManager(fullCached);
    }
  }
  const qmdBinary = await checkQmdBinaryAvailability({
    command: params.resolvedQmd.command,
    env: process.env,
    cwd: resolveAgentWorkspaceDir(params.cfg, params.agentId),
  });
  if (!qmdBinary.available) {
    log.warn(
      `qmd binary unavailable (${params.resolvedQmd.command}); falling back to builtin: ${qmdBinary.error ?? "unknown error"}`,
    );
    return null;
  }
  try {
    const { QmdMemoryManager } = await import("./qmd-manager.js");
    const primary = await QmdMemoryManager.create({
      cfg: params.cfg,
      agentId: params.agentId,
      resolved: {
        backend: "qmd",
        citations: "auto",
        qmd: params.resolvedQmd,
      },
      mode: statusOnly ? "status" : "full",
    });
    if (!primary) {
      return null;
    }
    if (statusOnly) {
      return primary;
    }
    const wrapper = new FallbackMemoryManager(
      {
        primary,
        fallbackFactory: async () => {
          const { MemoryIndexManager } = await loadManagerRuntime();
          return await MemoryIndexManager.get(params);
        },
      },
      () => {
        QMD_MANAGER_CACHE.delete(cacheKey);
      },
    );
    QMD_MANAGER_CACHE.set(cacheKey, wrapper);
    return wrapper;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`qmd memory unavailable; falling back to builtin: ${message}`);
    return null;
  }
}

function buildHybridCacheKey(params: {
  agentId: string;
  qmd?: ResolvedQmdConfig;
  mem0?: unknown;
  hybrid?: ResolvedHybridConfig;
  purpose?: "default" | "status";
}): string {
  return `${params.agentId}:${params.purpose ?? "default"}:${JSON.stringify({
    qmd: params.qmd,
    mem0: params.mem0,
    hybrid: params.hybrid,
  })}`;
}

export async function getMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status";
}): Promise<MemorySearchManagerResult> {
  const resolved = resolveMemoryBackendConfig(params);
  if (resolved.backend === "mem0") {
    const manager = await getOrCreateMem0Manager({
      cfg: params.cfg,
      agentId: params.agentId,
      resolvedMem0: resolved.mem0,
    });
    if (manager) {
      return { manager };
    }
  } else if (resolved.backend === "qmd") {
    const manager = await getOrCreateQmdManager({
      cfg: params.cfg,
      agentId: params.agentId,
      resolvedQmd: resolved.qmd,
      purpose: params.purpose,
    });
    if (manager) {
      return { manager };
    }
  } else if (resolved.backend === "hybrid") {
    const cacheKey = buildHybridCacheKey({
      agentId: params.agentId,
      qmd: resolved.qmd,
      mem0: resolved.mem0,
      hybrid: resolved.hybrid,
      purpose: params.purpose,
    });
    const cached = HYBRID_MANAGER_CACHE.get(cacheKey);
    if (cached) {
      return { manager: cached };
    }
    const [qmdManager, mem0Manager] = await Promise.all([
      getOrCreateQmdManager({
        cfg: params.cfg,
        agentId: params.agentId,
        resolvedQmd: resolved.qmd,
        purpose: params.purpose,
      }),
      getOrCreateMem0Manager({
        cfg: params.cfg,
        agentId: params.agentId,
        resolvedMem0: resolved.mem0,
      }),
    ]);
    if (qmdManager || mem0Manager) {
      const { MemoryIndexManager } = await loadManagerRuntime();
      const fallback = await MemoryIndexManager.get(params);
      const { HybridMemoryManager } = await import("./hybrid-manager.js");
      const manager = new HybridMemoryManager({
        config: resolved.hybrid ?? {
          readMode: "routed",
          writeMode: "routed",
          successPolicy: "any",
          readOrder: ["mem0", "qmd"],
          maxResults: 8,
          dedupe: true,
          routing: [],
        },
        qmd: qmdManager,
        mem0: mem0Manager as MemorySearchManager & {
          captureConversation?: (params: {
            sessionKey?: string;
            messages: unknown[];
          }) => Promise<void>;
        },
        fallback,
      });
      HYBRID_MANAGER_CACHE.set(cacheKey, manager);
      return { manager };
    }
  }

  try {
    const { MemoryIndexManager } = await loadManagerRuntime();
    const manager = await MemoryIndexManager.get(params);
    return { manager };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { manager: null, error: message };
  }
}

class BorrowedMemoryManager implements MemorySearchManager {
  constructor(private readonly inner: MemorySearchManager) {}

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ) {
    return await this.inner.search(query, opts);
  }

  async readFile(params: { relPath: string; from?: number; lines?: number }) {
    return await this.inner.readFile(params);
  }

  status() {
    return this.inner.status();
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }) {
    await this.inner.sync?.(params);
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    return await this.inner.probeEmbeddingAvailability();
  }

  async probeVectorAvailability() {
    return await this.inner.probeVectorAvailability();
  }

  async close() {}
}

export async function closeAllMemorySearchManagers(): Promise<void> {
  const managers = Array.from(QMD_MANAGER_CACHE.values());
  QMD_MANAGER_CACHE.clear();
  for (const manager of managers) {
    try {
      await manager.close?.();
    } catch (err) {
      log.warn(`failed to close qmd memory manager: ${String(err)}`);
    }
  }
  const mem0Managers = Array.from(MEM0_MANAGER_CACHE.values());
  MEM0_MANAGER_CACHE.clear();
  for (const manager of mem0Managers) {
    try {
      await manager.close?.();
    } catch (err) {
      log.warn(`failed to close mem0 memory manager: ${String(err)}`);
    }
  }
  const hybridManagers = Array.from(HYBRID_MANAGER_CACHE.values());
  HYBRID_MANAGER_CACHE.clear();
  for (const manager of hybridManagers) {
    try {
      await manager.close?.();
    } catch (err) {
      log.warn(`failed to close hybrid memory manager: ${String(err)}`);
    }
  }
  if (managerRuntimePromise !== null) {
    const { closeAllMemoryIndexManagers } = await loadManagerRuntime();
    await closeAllMemoryIndexManagers();
  }
}

class FallbackMemoryManager implements MemorySearchManager {
  private fallback: MemorySearchManager | null = null;
  private primaryFailed = false;
  private lastError?: string;
  private cacheEvicted = false;

  constructor(
    private readonly deps: {
      primary: MemorySearchManager;
      fallbackFactory: () => Promise<MemorySearchManager | null>;
    },
    private readonly onClose?: () => void,
  ) {}

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ) {
    if (!this.primaryFailed) {
      try {
        return await this.deps.primary.search(query, opts);
      } catch (err) {
        this.primaryFailed = true;
        this.lastError = err instanceof Error ? err.message : String(err);
        log.warn(`qmd memory failed; switching to builtin index: ${this.lastError}`);
        await this.deps.primary.close?.().catch(() => {});
        // Evict the failed wrapper so the next request can retry QMD with a fresh manager.
        this.evictCacheEntry();
      }
    }
    const fallback = await this.ensureFallback();
    if (fallback) {
      return await fallback.search(query, opts);
    }
    throw new Error(this.lastError ?? "memory search unavailable");
  }

  async readFile(params: { relPath: string; from?: number; lines?: number }) {
    if (!this.primaryFailed) {
      return await this.deps.primary.readFile(params);
    }
    const fallback = await this.ensureFallback();
    if (fallback) {
      return await fallback.readFile(params);
    }
    throw new Error(this.lastError ?? "memory read unavailable");
  }

  status() {
    if (!this.primaryFailed) {
      return this.deps.primary.status();
    }
    const fallbackStatus = this.fallback?.status();
    const fallbackInfo = { from: "qmd", reason: this.lastError ?? "unknown" };
    if (fallbackStatus) {
      const custom = fallbackStatus.custom ?? {};
      return {
        ...fallbackStatus,
        fallback: fallbackInfo,
        custom: {
          ...custom,
          fallback: { disabled: true, reason: this.lastError ?? "unknown" },
        },
      };
    }
    const primaryStatus = this.deps.primary.status();
    const custom = primaryStatus.custom ?? {};
    return {
      ...primaryStatus,
      fallback: fallbackInfo,
      custom: {
        ...custom,
        fallback: { disabled: true, reason: this.lastError ?? "unknown" },
      },
    };
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }) {
    if (!this.primaryFailed) {
      await this.deps.primary.sync?.(params);
      return;
    }
    const fallback = await this.ensureFallback();
    await fallback?.sync?.(params);
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    if (!this.primaryFailed) {
      return await this.deps.primary.probeEmbeddingAvailability();
    }
    const fallback = await this.ensureFallback();
    if (fallback) {
      return await fallback.probeEmbeddingAvailability();
    }
    return { ok: false, error: this.lastError ?? "memory embeddings unavailable" };
  }

  async probeVectorAvailability() {
    if (!this.primaryFailed) {
      return await this.deps.primary.probeVectorAvailability();
    }
    const fallback = await this.ensureFallback();
    return (await fallback?.probeVectorAvailability()) ?? false;
  }

  async close() {
    await this.deps.primary.close?.();
    await this.fallback?.close?.();
    this.evictCacheEntry();
  }

  private async ensureFallback(): Promise<MemorySearchManager | null> {
    if (this.fallback) {
      return this.fallback;
    }
    let fallback: MemorySearchManager | null;
    try {
      fallback = await this.deps.fallbackFactory();
      if (!fallback) {
        log.warn("memory fallback requested but builtin index is unavailable");
        return null;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`memory fallback unavailable: ${message}`);
      return null;
    }
    this.fallback = fallback;
    return this.fallback;
  }

  private evictCacheEntry(): void {
    if (this.cacheEvicted) {
      return;
    }
    this.cacheEvicted = true;
    this.onClose?.();
  }
}

function buildQmdCacheKey(agentId: string, config: ResolvedQmdConfig): string {
  // ResolvedQmdConfig is assembled in a stable field order in resolveMemoryBackendConfig.
  // Fast stringify avoids deep key-sorting overhead on this hot path.
  return `${agentId}:${JSON.stringify(config)}`;
}
