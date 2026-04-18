import fs from "node:fs";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../../../../src/agents/agent-scope.js";
import { parseDurationMs } from "../../../../src/cli/parse-duration.js";
import type { OpenClawConfig } from "../../../../src/config/config.js";
import type { SessionSendPolicyConfig } from "../../../../src/config/types.base.js";
import type {
  MemoryBackend,
  MemoryCitationsMode,
  MemoryHybridConfig,
  MemoryHybridReadOrder,
  MemoryHybridRouteRule,
  MemoryHybridRouteScope,
  MemoryHybridRouteSource,
  MemoryHybridRoutePriority,
  MemoryHybridSuccessPolicy,
  MemoryHybridTarget,
  MemoryMem0Config,
  MemoryQmdConfig,
  MemoryQmdIndexPath,
  MemoryQmdMcporterConfig,
  MemoryQmdSearchMode,
} from "../../../../src/config/types.memory.js";
import { normalizeAgentId } from "../../../../src/routing/session-key.js";
import { resolveUserPath } from "../../../../src/utils.js";
import { splitShellArgs } from "../../../../src/utils/shell-argv.js";

export type ResolvedMemoryBackendConfig = {
  backend: MemoryBackend;
  citations: MemoryCitationsMode;
  qmd?: ResolvedQmdConfig;
  mem0?: ResolvedMem0Config;
  hybrid?: ResolvedHybridConfig;
};

export type ResolvedMem0Config = {
  enabled: boolean;
  baseUrl: string;
  apiKey?: string;
  userIdPrefix: string;
  agentIdPrefix: string;
  searchPath: string;
  addPath: string;
  topK: number;
  threshold: number;
  timeoutMs: number;
};

export type ResolvedQmdCollection = {
  name: string;
  path: string;
  pattern: string;
  kind: "memory" | "custom" | "sessions";
};

export type ResolvedQmdUpdateConfig = {
  intervalMs: number;
  debounceMs: number;
  onBoot: boolean;
  waitForBootSync: boolean;
  embedIntervalMs: number;
  commandTimeoutMs: number;
  updateTimeoutMs: number;
  embedTimeoutMs: number;
};

export type ResolvedQmdLimitsConfig = {
  maxResults: number;
  maxSnippetChars: number;
  maxInjectedChars: number;
  timeoutMs: number;
};

export type ResolvedQmdSessionConfig = {
  enabled: boolean;
  exportDir?: string;
  retentionDays?: number;
};

export type ResolvedQmdMcporterConfig = {
  enabled: boolean;
  serverName: string;
  startDaemon: boolean;
};

export type ResolvedQmdConfig = {
  command: string;
  mcporter: ResolvedQmdMcporterConfig;
  searchMode: MemoryQmdSearchMode;
  searchTool?: string;
  collections: ResolvedQmdCollection[];
  sessions: ResolvedQmdSessionConfig;
  update: ResolvedQmdUpdateConfig;
  limits: ResolvedQmdLimitsConfig;
  includeDefaultMemory: boolean;
  scope?: SessionSendPolicyConfig;
};

export type ResolvedHybridRouteRule = {
  scope: MemoryHybridRouteScope;
  source: MemoryHybridRouteSource;
  priority: MemoryHybridRoutePriority;
  tags: string[];
  queryIncludes: string[];
  target: MemoryHybridTarget;
};

export type ResolvedHybridConfig = {
  readMode: "dual" | "routed";
  writeMode: "dual" | "routed";
  successPolicy: MemoryHybridSuccessPolicy;
  readOrder: MemoryHybridReadOrder[];
  maxResults: number;
  dedupe: boolean;
  routing: ResolvedHybridRouteRule[];
};

const DEFAULT_BACKEND: MemoryBackend = "builtin";
const DEFAULT_CITATIONS: MemoryCitationsMode = "auto";
const DEFAULT_MEM0_SEARCH_PATH = "/v2/memories/search/";
const DEFAULT_MEM0_ADD_PATH = "/v1/memories/";
const DEFAULT_MEM0_TOP_K = 8;
const DEFAULT_MEM0_THRESHOLD = 0.2;
const DEFAULT_MEM0_TIMEOUT_MS = 8_000;
const DEFAULT_QMD_INTERVAL = "5m";
const DEFAULT_QMD_DEBOUNCE_MS = 15_000;
const DEFAULT_QMD_TIMEOUT_MS = 4_000;
// Defaulting to `query` can be extremely slow on CPU-only systems (query expansion + rerank).
// Prefer a faster mode for interactive use; users can opt into `query` for best recall.
const DEFAULT_QMD_SEARCH_MODE: MemoryQmdSearchMode = "search";
const DEFAULT_QMD_EMBED_INTERVAL = "60m";
const DEFAULT_QMD_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_QMD_UPDATE_TIMEOUT_MS = 120_000;
const DEFAULT_QMD_EMBED_TIMEOUT_MS = 120_000;
const DEFAULT_QMD_LIMITS: ResolvedQmdLimitsConfig = {
  maxResults: 6,
  maxSnippetChars: 700,
  maxInjectedChars: 4_000,
  timeoutMs: DEFAULT_QMD_TIMEOUT_MS,
};
const DEFAULT_QMD_MCPORTER: ResolvedQmdMcporterConfig = {
  enabled: false,
  serverName: "qmd",
  startDaemon: true,
};

const DEFAULT_QMD_SCOPE: SessionSendPolicyConfig = {
  default: "deny",
  rules: [
    {
      action: "allow",
      match: { chatType: "direct" },
    },
  ],
};

const DEFAULT_HYBRID_MAX_RESULTS = 8;
const DEFAULT_HYBRID_READ_ORDER: MemoryHybridReadOrder[] = ["mem0", "qmd"];
const DEFAULT_HYBRID_ROUTING: ResolvedHybridRouteRule[] = [
  {
    scope: "write",
    source: "conversation",
    priority: "critical",
    tags: [],
    queryIncludes: [],
    target: "both",
  },
  {
    scope: "write",
    source: "conversation",
    priority: "normal",
    tags: ["task", "todo", "preference", "mood", "心態", "偏好", "任務"],
    queryIncludes: [],
    target: "mem0",
  },
  {
    scope: "write",
    source: "knowledge",
    priority: "normal",
    tags: [],
    queryIncludes: [],
    target: "qmd",
  },
  {
    scope: "read",
    source: "query",
    priority: "normal",
    tags: [],
    queryIncludes: ["task", "todo", "preference", "mood", "心態", "偏好", "任務"],
    target: "mem0",
  },
  {
    scope: "read",
    source: "query",
    priority: "normal",
    tags: [],
    queryIncludes: ["architecture", "engine", "rag", "course", "kb", "架構", "知識", "課程"],
    target: "qmd",
  },
];

function sanitizeName(input: string): string {
  const lower = input.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const trimmed = lower.replace(/^-+|-+$/g, "");
  return trimmed || "collection";
}

function scopeCollectionBase(base: string, agentId: string): string {
  return `${base}-${sanitizeName(agentId)}`;
}

function canonicalizePathForContainment(rawPath: string): string {
  const resolved = path.resolve(rawPath);
  let current = resolved;
  const suffix: string[] = [];
  while (true) {
    try {
      const canonical = path.normalize(fs.realpathSync.native(current));
      return path.normalize(path.join(canonical, ...suffix));
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return path.normalize(resolved);
      }
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(
    canonicalizePathForContainment(rootPath),
    canonicalizePathForContainment(candidatePath),
  );
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function ensureUniqueName(base: string, existing: Set<string>): string {
  let name = sanitizeName(base);
  if (!existing.has(name)) {
    existing.add(name);
    return name;
  }
  let suffix = 2;
  while (existing.has(`${name}-${suffix}`)) {
    suffix += 1;
  }
  const unique = `${name}-${suffix}`;
  existing.add(unique);
  return unique;
}

function resolvePath(raw: string, workspaceDir: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("path required");
  }
  if (trimmed.startsWith("~") || path.isAbsolute(trimmed)) {
    return path.normalize(resolveUserPath(trimmed));
  }
  return path.normalize(path.resolve(workspaceDir, trimmed));
}

function resolveIntervalMs(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) {
    return parseDurationMs(DEFAULT_QMD_INTERVAL, { defaultUnit: "m" });
  }
  try {
    return parseDurationMs(value, { defaultUnit: "m" });
  } catch {
    return parseDurationMs(DEFAULT_QMD_INTERVAL, { defaultUnit: "m" });
  }
}

function resolveEmbedIntervalMs(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) {
    return parseDurationMs(DEFAULT_QMD_EMBED_INTERVAL, { defaultUnit: "m" });
  }
  try {
    return parseDurationMs(value, { defaultUnit: "m" });
  } catch {
    return parseDurationMs(DEFAULT_QMD_EMBED_INTERVAL, { defaultUnit: "m" });
  }
}

function resolveDebounceMs(raw: number | undefined): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  return DEFAULT_QMD_DEBOUNCE_MS;
}

function resolveTimeoutMs(raw: number | undefined, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return fallback;
}

function resolveLimits(raw?: MemoryQmdConfig["limits"]): ResolvedQmdLimitsConfig {
  const parsed: ResolvedQmdLimitsConfig = { ...DEFAULT_QMD_LIMITS };
  if (raw?.maxResults && raw.maxResults > 0) {
    parsed.maxResults = Math.floor(raw.maxResults);
  }
  if (raw?.maxSnippetChars && raw.maxSnippetChars > 0) {
    parsed.maxSnippetChars = Math.floor(raw.maxSnippetChars);
  }
  if (raw?.maxInjectedChars && raw.maxInjectedChars > 0) {
    parsed.maxInjectedChars = Math.floor(raw.maxInjectedChars);
  }
  if (raw?.timeoutMs && raw.timeoutMs > 0) {
    parsed.timeoutMs = Math.floor(raw.timeoutMs);
  }
  return parsed;
}

function resolveSearchMode(raw?: MemoryQmdConfig["searchMode"]): MemoryQmdSearchMode {
  if (raw === "search" || raw === "vsearch" || raw === "query") {
    return raw;
  }
  return DEFAULT_QMD_SEARCH_MODE;
}

function resolveSearchTool(raw?: MemoryQmdConfig["searchTool"]): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}

function joinUrlPath(basePath: string, fallbackPath: string): string {
  const trimmed = basePath.trim();
  if (!trimmed) {
    return fallbackPath;
  }
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return prefixed.endsWith("/") ? prefixed : `${prefixed}/`;
}

function resolveMem0Config(raw: MemoryMem0Config | undefined): ResolvedMem0Config {
  const baseUrl = raw?.baseUrl?.trim() || "http://127.0.0.1:8000";
  const parsedBaseUrl = new URL(baseUrl);
  const normalizedBaseUrl = parsedBaseUrl.toString().replace(/\/+$/, "");
  const topK =
    typeof raw?.topK === "number" && Number.isFinite(raw.topK) && raw.topK > 0
      ? Math.floor(raw.topK)
      : DEFAULT_MEM0_TOP_K;
  const threshold =
    typeof raw?.threshold === "number" && Number.isFinite(raw.threshold)
      ? Math.min(1, Math.max(0, raw.threshold))
      : DEFAULT_MEM0_THRESHOLD;
  const timeoutMs =
    typeof raw?.timeoutMs === "number" && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0
      ? Math.floor(raw.timeoutMs)
      : DEFAULT_MEM0_TIMEOUT_MS;
  return {
    enabled: raw?.enabled !== false,
    baseUrl: normalizedBaseUrl,
    apiKey: typeof raw?.apiKey === "string" ? raw.apiKey.trim() || undefined : undefined,
    userIdPrefix: raw?.userIdPrefix?.trim() || "openclaw-user",
    agentIdPrefix: raw?.agentIdPrefix?.trim() || "openclaw-agent",
    searchPath: joinUrlPath(raw?.searchPath ?? "", DEFAULT_MEM0_SEARCH_PATH),
    addPath: joinUrlPath(raw?.addPath ?? "", DEFAULT_MEM0_ADD_PATH),
    topK,
    threshold,
    timeoutMs,
  };
}

function sanitizeNonEmptyList(values: string[] | undefined): string[] {
  if (!values?.length) {
    return [];
  }
  return Array.from(
    new Set(
      values
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
        .map((value) => value.toLowerCase()),
    ),
  );
}

function resolveHybridRouteRule(raw: MemoryHybridRouteRule): ResolvedHybridRouteRule {
  const scope =
    raw.scope === "read" || raw.scope === "write" || raw.scope === "both" ? raw.scope : "both";
  const source =
    raw.source === "query" || raw.source === "conversation" || raw.source === "knowledge"
      ? raw.source
      : "query";
  const priority = raw.priority === "critical" ? "critical" : "normal";
  const target =
    raw.target === "qmd" || raw.target === "mem0" || raw.target === "both" ? raw.target : "both";
  return {
    scope,
    source,
    priority,
    tags: sanitizeNonEmptyList(raw.tags),
    queryIncludes: sanitizeNonEmptyList(raw.queryIncludes),
    target,
  };
}

function resolveHybridConfig(raw?: MemoryHybridConfig): ResolvedHybridConfig {
  const readMode = raw?.read?.mode === "dual" ? "dual" : "routed";
  const writeMode = raw?.write?.mode === "dual" ? "dual" : "routed";
  const successPolicy: MemoryHybridSuccessPolicy =
    raw?.write?.successPolicy === "all" ? "all" : "any";
  const configuredOrder = raw?.read?.order?.filter(
    (value): value is MemoryHybridReadOrder => value === "qmd" || value === "mem0",
  );
  const readOrder =
    configuredOrder && configuredOrder.length > 0
      ? Array.from(new Set(configuredOrder))
      : [...DEFAULT_HYBRID_READ_ORDER];
  const maxResults =
    typeof raw?.read?.maxResults === "number" &&
    Number.isFinite(raw.read.maxResults) &&
    raw.read.maxResults > 0
      ? Math.floor(raw.read.maxResults)
      : DEFAULT_HYBRID_MAX_RESULTS;
  const dedupe = raw?.read?.dedupe !== false;
  const rules = raw?.routing?.map(resolveHybridRouteRule).filter(Boolean) ?? [];
  return {
    readMode,
    writeMode,
    successPolicy,
    readOrder,
    maxResults,
    dedupe,
    routing: rules.length > 0 ? rules : [...DEFAULT_HYBRID_ROUTING],
  };
}

function resolveSessionConfig(
  cfg: MemoryQmdConfig["sessions"],
  workspaceDir: string,
): ResolvedQmdSessionConfig {
  const enabled = Boolean(cfg?.enabled);
  const exportDirRaw = cfg?.exportDir?.trim();
  const exportDir = exportDirRaw ? resolvePath(exportDirRaw, workspaceDir) : undefined;
  const retentionDays =
    cfg?.retentionDays && cfg.retentionDays > 0 ? Math.floor(cfg.retentionDays) : undefined;
  return {
    enabled,
    exportDir,
    retentionDays,
  };
}

function resolveCustomPaths(
  rawPaths: MemoryQmdIndexPath[] | undefined,
  workspaceDir: string,
  existing: Set<string>,
  agentId: string,
): ResolvedQmdCollection[] {
  if (!rawPaths?.length) {
    return [];
  }
  const collections: ResolvedQmdCollection[] = [];
  const seenRoots = new Set<string>();
  rawPaths.forEach((entry, index) => {
    const trimmedPath = entry?.path?.trim();
    if (!trimmedPath) {
      return;
    }
    let resolved: string;
    try {
      resolved = resolvePath(trimmedPath, workspaceDir);
    } catch {
      return;
    }
    const pattern = entry.pattern?.trim() || "**/*.md";
    const dedupeKey = `${resolved}\u0000${pattern}`;
    if (seenRoots.has(dedupeKey)) {
      return;
    }
    seenRoots.add(dedupeKey);
    const explicitName = entry.name?.trim();
    const baseName =
      explicitName && !isPathInsideRoot(resolved, workspaceDir)
        ? explicitName
        : scopeCollectionBase(explicitName || `custom-${index + 1}`, agentId);
    const name = ensureUniqueName(baseName, existing);
    collections.push({
      name,
      path: resolved,
      pattern,
      kind: "custom",
    });
  });
  return collections;
}

function resolveMcporterConfig(raw?: MemoryQmdMcporterConfig): ResolvedQmdMcporterConfig {
  const parsed: ResolvedQmdMcporterConfig = { ...DEFAULT_QMD_MCPORTER };
  if (!raw) {
    return parsed;
  }
  if (raw.enabled !== undefined) {
    parsed.enabled = raw.enabled;
  }
  if (typeof raw.serverName === "string" && raw.serverName.trim()) {
    parsed.serverName = raw.serverName.trim();
  }
  if (raw.startDaemon !== undefined) {
    parsed.startDaemon = raw.startDaemon;
  }
  // When enabled, default startDaemon to true.
  if (parsed.enabled && raw.startDaemon === undefined) {
    parsed.startDaemon = true;
  }
  return parsed;
}

function resolveDefaultCollections(
  include: boolean,
  workspaceDir: string,
  existing: Set<string>,
  agentId: string,
): ResolvedQmdCollection[] {
  if (!include) {
    return [];
  }
  const entries: Array<{ path: string; pattern: string; base: string }> = [
    { path: workspaceDir, pattern: "MEMORY.md", base: "memory-root" },
    { path: workspaceDir, pattern: "memory.md", base: "memory-alt" },
    { path: path.join(workspaceDir, "memory"), pattern: "**/*.md", base: "memory-dir" },
  ];
  return entries.map((entry) => ({
    name: ensureUniqueName(scopeCollectionBase(entry.base, agentId), existing),
    path: entry.path,
    pattern: entry.pattern,
    kind: "memory",
  }));
}

function resolveQmdConfigForAgent(params: {
  cfg: OpenClawConfig;
  normalizedAgentId: string;
}): ResolvedQmdConfig {
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.normalizedAgentId);
  const qmdCfg = params.cfg.memory?.qmd;
  const includeDefaultMemory = qmdCfg?.includeDefaultMemory !== false;
  const nameSet = new Set<string>();
  const agentEntry = params.cfg.agents?.list?.find(
    (entry) => normalizeAgentId(entry?.id) === params.normalizedAgentId,
  );
  const mergedExtraPaths = [
    ...(params.cfg.agents?.defaults?.memorySearch?.extraPaths ?? []),
    ...(agentEntry?.memorySearch?.extraPaths ?? []),
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  const dedupedExtraPaths = Array.from(new Set(mergedExtraPaths));
  const searchExtraPaths = dedupedExtraPaths.map(
    (pathValue): { path: string; pattern?: string; name?: string } => ({ path: pathValue }),
  );
  const mergedExtraCollections = [
    ...(params.cfg.agents?.defaults?.memorySearch?.qmd?.extraCollections ?? []),
    ...(agentEntry?.memorySearch?.qmd?.extraCollections ?? []),
  ].filter((value): value is MemoryQmdIndexPath =>
    Boolean(value && typeof value === "object" && typeof value.path === "string"),
  );

  const allQmdPaths: MemoryQmdIndexPath[] = [
    ...(qmdCfg?.paths ?? []),
    ...searchExtraPaths,
    ...mergedExtraCollections,
  ];

  const collections = [
    ...resolveDefaultCollections(
      includeDefaultMemory,
      workspaceDir,
      nameSet,
      params.normalizedAgentId,
    ),
    ...resolveCustomPaths(allQmdPaths, workspaceDir, nameSet, params.normalizedAgentId),
  ];

  const rawCommand = qmdCfg?.command?.trim() || "qmd";
  const parsedCommand = splitShellArgs(rawCommand);
  const command = parsedCommand?.[0] || rawCommand.split(/\s+/)[0] || "qmd";
  return {
    command,
    mcporter: resolveMcporterConfig(qmdCfg?.mcporter),
    searchMode: resolveSearchMode(qmdCfg?.searchMode),
    searchTool: resolveSearchTool(qmdCfg?.searchTool),
    collections,
    includeDefaultMemory,
    sessions: resolveSessionConfig(qmdCfg?.sessions, workspaceDir),
    update: {
      intervalMs: resolveIntervalMs(qmdCfg?.update?.interval),
      debounceMs: resolveDebounceMs(qmdCfg?.update?.debounceMs),
      onBoot: qmdCfg?.update?.onBoot !== false,
      waitForBootSync: qmdCfg?.update?.waitForBootSync === true,
      embedIntervalMs: resolveEmbedIntervalMs(qmdCfg?.update?.embedInterval),
      commandTimeoutMs: resolveTimeoutMs(
        qmdCfg?.update?.commandTimeoutMs,
        DEFAULT_QMD_COMMAND_TIMEOUT_MS,
      ),
      updateTimeoutMs: resolveTimeoutMs(
        qmdCfg?.update?.updateTimeoutMs,
        DEFAULT_QMD_UPDATE_TIMEOUT_MS,
      ),
      embedTimeoutMs: resolveTimeoutMs(
        qmdCfg?.update?.embedTimeoutMs,
        DEFAULT_QMD_EMBED_TIMEOUT_MS,
      ),
    },
    limits: resolveLimits(qmdCfg?.limits),
    scope: qmdCfg?.scope ?? DEFAULT_QMD_SCOPE,
  };
}

export function resolveMemoryBackendConfig(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): ResolvedMemoryBackendConfig {
  const normalizedAgentId = normalizeAgentId(params.agentId);
  const backend = params.cfg.memory?.backend ?? DEFAULT_BACKEND;
  const citations = params.cfg.memory?.citations ?? DEFAULT_CITATIONS;
  if (backend === "mem0") {
    return {
      backend: "mem0",
      citations,
      mem0: resolveMem0Config(params.cfg.memory?.mem0),
    };
  }
  if (backend === "hybrid") {
    return {
      backend: "hybrid",
      citations,
      mem0: resolveMem0Config(params.cfg.memory?.mem0),
      qmd: resolveQmdConfigForAgent({
        cfg: params.cfg,
        normalizedAgentId,
      }),
      hybrid: resolveHybridConfig(params.cfg.memory?.hybrid),
    };
  }
  if (backend !== "qmd") {
    return { backend: "builtin", citations };
  }
  return {
    backend: "qmd",
    citations,
    qmd: resolveQmdConfigForAgent({
      cfg: params.cfg,
      normalizedAgentId,
    }),
  };
}
