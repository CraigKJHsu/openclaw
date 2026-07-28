export type HermesBridgeMode = "mock" | "live";
export type HermesRuntimeMode = "mock" | "real";
export const MAX_HERMES_BRIDGE_LIVE_RUNTIME_SECONDS = 3_600;

export type HermesBridgeConfig = {
  enabled: boolean;
  mode: HermesBridgeMode;
  hermesMode: HermesRuntimeMode;
  hermesAgentPath: string;
  sharedSecretEnv: string;
  allowedTasks: string[];
  allowedTools: string[];
  maxRequestBytes: number;
  idempotencyDbPath: string;
  readonlyBrowserAgentId: string;
  maxLiveRuntimeSeconds: number;
};

export const DEFAULT_HERMES_BRIDGE_CONFIG: HermesBridgeConfig = {
  enabled: false,
  mode: "mock",
  hermesMode: "mock",
  hermesAgentPath: "../hermes-agent",
  sharedSecretEnv: "OPENCLAW_HERMES_BRIDGE_TOKEN",
  allowedTasks: [],
  allowedTools: [],
  maxRequestBytes: 65_536,
  idempotencyDbPath: "~/.openclaw/hermes-bridge-idempotency.sqlite",
  readonlyBrowserAgentId: "missioncrew-browser-readonly",
  maxLiveRuntimeSeconds: 120,
};

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readMode(value: unknown): HermesBridgeMode {
  return value === "live" ? "live" : "mock";
}

function readHermesMode(value: unknown): HermesRuntimeMode {
  return value === "real" ? "real" : "mock";
}

function readHermesAgentPath(value: unknown): string {
  if (typeof value !== "string") {
    return DEFAULT_HERMES_BRIDGE_CONFIG.hermesAgentPath;
  }
  const trimmed = value.trim();
  return trimmed || DEFAULT_HERMES_BRIDGE_CONFIG.hermesAgentPath;
}

function readSecretEnv(value: unknown): string {
  if (typeof value !== "string") {
    return DEFAULT_HERMES_BRIDGE_CONFIG.sharedSecretEnv;
  }
  const trimmed = value.trim();
  return trimmed || DEFAULT_HERMES_BRIDGE_CONFIG.sharedSecretEnv;
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    items.push(trimmed);
  }
  return items;
}

function readMaxRequestBytes(value: unknown): number {
  if (!Number.isFinite(value) || typeof value !== "number" || value <= 0) {
    return DEFAULT_HERMES_BRIDGE_CONFIG.maxRequestBytes;
  }
  const resolved = Math.floor(value);
  return resolved >= 1 ? resolved : DEFAULT_HERMES_BRIDGE_CONFIG.maxRequestBytes;
}

function readPositiveInteger(value: unknown, fallback: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const resolved = Math.floor(value);
  return resolved >= 1 && resolved <= maximum ? resolved : fallback;
}

export function resolveHermesBridgeConfig(raw: unknown): HermesBridgeConfig {
  const config = readObject(raw);
  return {
    enabled: config.enabled === true,
    mode: readMode(config.mode),
    hermesMode: readHermesMode(config.hermesMode),
    hermesAgentPath: readHermesAgentPath(config.hermesAgentPath),
    sharedSecretEnv: readSecretEnv(config.sharedSecretEnv),
    allowedTasks: readStringList(config.allowedTasks),
    allowedTools: readStringList(config.allowedTools),
    maxRequestBytes: readMaxRequestBytes(config.maxRequestBytes),
    idempotencyDbPath:
      typeof config.idempotencyDbPath === "string" && config.idempotencyDbPath.trim()
        ? config.idempotencyDbPath.trim()
        : DEFAULT_HERMES_BRIDGE_CONFIG.idempotencyDbPath,
    readonlyBrowserAgentId: DEFAULT_HERMES_BRIDGE_CONFIG.readonlyBrowserAgentId,
    maxLiveRuntimeSeconds: readPositiveInteger(
      config.maxLiveRuntimeSeconds,
      DEFAULT_HERMES_BRIDGE_CONFIG.maxLiveRuntimeSeconds,
      MAX_HERMES_BRIDGE_LIVE_RUNTIME_SECONDS,
    ),
  };
}
