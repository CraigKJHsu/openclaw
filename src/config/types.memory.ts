import type { SessionSendPolicyConfig } from "./types.base.js";
import type { SecretInput } from "./types.secrets.js";

export type MemoryBackend = "builtin" | "qmd" | "mem0" | "hybrid";
export type MemoryCitationsMode = "auto" | "on" | "off";
export type MemoryQmdSearchMode = "query" | "search" | "vsearch";
export type MemoryHybridTarget = "qmd" | "mem0" | "both";
export type MemoryHybridReadOrder = "qmd" | "mem0";
export type MemoryHybridMode = "dual" | "routed";
export type MemoryHybridSuccessPolicy = "any" | "all";
export type MemoryHybridRouteScope = "read" | "write" | "both";
export type MemoryHybridRouteSource = "query" | "conversation" | "knowledge";
export type MemoryHybridRoutePriority = "normal" | "critical";

export type MemoryConfig = {
  backend?: MemoryBackend;
  citations?: MemoryCitationsMode;
  qmd?: MemoryQmdConfig;
  mem0?: MemoryMem0Config;
  hybrid?: MemoryHybridConfig;
};

export type MemoryHybridConfig = {
  read?: MemoryHybridReadConfig;
  write?: MemoryHybridWriteConfig;
  routing?: MemoryHybridRouteRule[];
};

export type MemoryHybridReadConfig = {
  mode?: MemoryHybridMode;
  order?: MemoryHybridReadOrder[];
  maxResults?: number;
  dedupe?: boolean;
};

export type MemoryHybridWriteConfig = {
  mode?: MemoryHybridMode;
  successPolicy?: MemoryHybridSuccessPolicy;
};

export type MemoryHybridRouteRule = {
  scope?: MemoryHybridRouteScope;
  source?: MemoryHybridRouteSource;
  priority?: MemoryHybridRoutePriority;
  tags?: string[];
  queryIncludes?: string[];
  target: MemoryHybridTarget;
};

export type MemoryMem0Config = {
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: SecretInput;
  userIdPrefix?: string;
  agentIdPrefix?: string;
  searchPath?: string;
  addPath?: string;
  topK?: number;
  threshold?: number;
  timeoutMs?: number;
};

export type MemoryQmdConfig = {
  command?: string;
  mcporter?: MemoryQmdMcporterConfig;
  searchMode?: MemoryQmdSearchMode;
  searchTool?: string;
  includeDefaultMemory?: boolean;
  paths?: MemoryQmdIndexPath[];
  sessions?: MemoryQmdSessionConfig;
  update?: MemoryQmdUpdateConfig;
  limits?: MemoryQmdLimitsConfig;
  scope?: SessionSendPolicyConfig;
};

export type MemoryQmdMcporterConfig = {
  /**
   * Route QMD searches through mcporter (MCP runtime) instead of spawning `qmd` per query.
   * Requires:
   * - `mcporter` installed and on PATH
   * - A configured mcporter server that runs `qmd mcp` with `lifecycle: keep-alive`
   */
  enabled?: boolean;
  /** mcporter server name (defaults to "qmd") */
  serverName?: string;
  /** Start the mcporter daemon automatically (defaults to true when enabled). */
  startDaemon?: boolean;
};

export type MemoryQmdIndexPath = {
  path: string;
  name?: string;
  pattern?: string;
};

export type MemoryQmdSessionConfig = {
  enabled?: boolean;
  exportDir?: string;
  retentionDays?: number;
};

export type MemoryQmdUpdateConfig = {
  interval?: string;
  debounceMs?: number;
  onBoot?: boolean;
  waitForBootSync?: boolean;
  embedInterval?: string;
  commandTimeoutMs?: number;
  updateTimeoutMs?: number;
  embedTimeoutMs?: number;
};

export type MemoryQmdLimitsConfig = {
  maxResults?: number;
  maxSnippetChars?: number;
  maxInjectedChars?: number;
  timeoutMs?: number;
};
