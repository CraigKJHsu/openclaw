import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HermesBridgeRequest, HermesBridgeResult } from "./schema.js";

export type HermesBridgeIdempotencyEntry = {
  requestHash: string;
  result: HermesBridgeResult;
};

export type HermesBridgeIdempotencyClaim =
  | { status: "claimed"; recovered: boolean }
  | { status: "completed"; entry: HermesBridgeIdempotencyEntry }
  | { status: "conflict"; requestHash: string }
  | { status: "pending"; requestHash: string };

export type HermesBridgeIdempotencyClaimOptions = {
  ownerId: string;
  leaseMs: number;
  nowMs?: number;
};

export type HermesBridgeCleanupObligation = {
  idempotencyKey: string;
  requestHash: string;
  generation: string;
  backendAdmissionKey?: string;
  backendRunId?: string;
  backendStartAttempted?: boolean;
  backendSubmission?: HermesBridgeBackendSubmission;
  auditedTerminal?: HermesBridgeAsyncTerminalState;
  request: HermesBridgeRequest;
  dueAt: number;
};

export type HermesBridgeBackendSubmission = {
  sessionKey: string;
  message: string;
  extraSystemPrompt: string;
  lane: string;
  lightContext: true;
  deliver: false;
  toolsAllow: [];
  disableTools: true;
};

export type HermesBridgeAsyncTerminalState = {
  idempotencyKey: string;
  requestHash: string;
  generation: string;
  backendRunId: string;
  request: HermesBridgeRequest;
  output: Record<string, unknown>;
  completedAt: number;
};

export class HermesBridgeCleanupPendingError extends Error {
  constructor() {
    super("Cleanup obligation is pending for an earlier execution generation.");
    this.name = "HermesBridgeCleanupPendingError";
  }
}

export class HermesBridgeCleanupStoreUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      cause instanceof Error
        ? `Cleanup store is unavailable: ${cause.message}`
        : "Cleanup store is unavailable.",
      { cause },
    );
    this.name = "HermesBridgeCleanupStoreUnavailableError";
  }
}

export type HermesBridgeIdempotencyStore = {
  get: (key: string) => HermesBridgeIdempotencyEntry | undefined;
  claim: (
    key: string,
    requestHash: string,
    options: HermesBridgeIdempotencyClaimOptions,
  ) => HermesBridgeIdempotencyClaim;
  release: (key: string, requestHash: string, ownerId: string) => void;
  set: (key: string, value: HermesBridgeIdempotencyEntry, ownerId?: string) => void;
  registerCleanup: (obligation: HermesBridgeCleanupObligation, nowMs?: number) => boolean;
  markCleanupBackendStartAttempted: (
    key: string,
    requestHash: string,
    generation: string,
    backendAdmissionKey: string,
  ) => void;
  setCleanupBackendSubmission: (
    key: string,
    requestHash: string,
    generation: string,
    backendAdmissionKey: string,
    submission: HermesBridgeBackendSubmission,
  ) => void;
  confirmCleanupBackendAdmission: (
    key: string,
    requestHash: string,
    generation: string,
    backendAdmissionKey: string,
    admittedBackendRunId: string,
  ) => void;
  getCleanup: (key: string) => HermesBridgeCleanupObligation | undefined;
  listDueCleanup: (nowMs?: number) => HermesBridgeCleanupObligation[];
  claimCleanup: (
    key: string,
    requestHash: string,
    generation: string,
    options: HermesBridgeIdempotencyClaimOptions,
  ) => boolean;
  releaseCleanup: (key: string, requestHash: string, generation: string, ownerId: string) => void;
  setCleanupAuditedTerminal: (
    key: string,
    requestHash: string,
    generation: string,
    ownerId: string,
    terminal: HermesBridgeAsyncTerminalState,
  ) => void;
  completeCleanup: (
    key: string,
    requestHash: string,
    generation: string,
    ownerId: string,
    terminal: HermesBridgeAsyncTerminalState,
  ) => void;
  getCleanupTerminal: (key: string) => HermesBridgeAsyncTerminalState | undefined;
  clearCleanup: (key: string, requestHash: string, generation: string, ownerId?: string) => void;
  close?: () => void;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function hashHermesBridgeRequest(request: HermesBridgeRequest): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(request)))
    .digest("hex");
}

export class MemoryHermesBridgeIdempotencyStore implements HermesBridgeIdempotencyStore {
  readonly entries = new Map<string, HermesBridgeIdempotencyEntry>();
  readonly reservations = new Map<string, string>();
  readonly claims = new Map<string, { requestHash: string; ownerId: string; expiresAt: number }>();
  readonly cleanup = new Map<
    string,
    { obligation: HermesBridgeCleanupObligation; ownerId: string; expiresAt: number }
  >();
  readonly cleanupTerminals = new Map<string, HermesBridgeAsyncTerminalState>();

  get(key: string): HermesBridgeIdempotencyEntry | undefined {
    return this.entries.get(key);
  }

  claim(
    key: string,
    requestHash: string,
    options: HermesBridgeIdempotencyClaimOptions,
  ): HermesBridgeIdempotencyClaim {
    const completed = this.entries.get(key);
    if (completed) {
      return completed.requestHash === requestHash
        ? { status: "completed", entry: completed }
        : { status: "conflict", requestHash: completed.requestHash };
    }
    const reservedHash = this.reservations.get(key);
    if (reservedHash && reservedHash !== requestHash) {
      return { status: "conflict", requestHash: reservedHash };
    }
    this.reservations.set(key, requestHash);
    const pending = this.claims.get(key);
    const nowMs = options.nowMs ?? Date.now();
    if (pending) {
      if (pending.requestHash !== requestHash) {
        return { status: "conflict", requestHash: pending.requestHash };
      }
      if (pending.expiresAt > nowMs) {
        return { status: "pending", requestHash: pending.requestHash };
      }
    }
    this.claims.set(key, {
      requestHash,
      ownerId: options.ownerId,
      expiresAt: nowMs + options.leaseMs,
    });
    return { status: "claimed", recovered: Boolean(pending) };
  }

  release(key: string, requestHash: string, ownerId: string): void {
    const pending = this.claims.get(key);
    if (pending?.requestHash === requestHash && pending.ownerId === ownerId) {
      this.claims.delete(key);
    }
  }

  set(key: string, value: HermesBridgeIdempotencyEntry, ownerId?: string): void {
    const reservedHash = this.reservations.get(key);
    if (reservedHash && reservedHash !== value.requestHash) {
      throw new Error("Idempotency key is reserved for a different request hash.");
    }
    this.reservations.set(key, value.requestHash);
    if (ownerId) {
      const pending = this.claims.get(key);
      if (!pending || pending.requestHash !== value.requestHash || pending.ownerId !== ownerId) {
        throw new Error("Idempotency claim ownership was lost before result persistence.");
      }
    }
    this.entries.set(key, value);
    if (ownerId) {
      this.release(key, value.requestHash, ownerId);
    } else {
      this.claims.delete(key);
    }
  }

  registerCleanup(obligation: HermesBridgeCleanupObligation, _nowMs = Date.now()): boolean {
    const reservedHash = this.reservations.get(obligation.idempotencyKey);
    if (reservedHash && reservedHash !== obligation.requestHash) {
      throw new Error("Idempotency key is reserved for a different request hash.");
    }
    if (this.cleanupTerminals.has(obligation.idempotencyKey)) {
      return false;
    }
    this.reservations.set(obligation.idempotencyKey, obligation.requestHash);
    if (this.cleanup.has(obligation.idempotencyKey)) {
      throw new HermesBridgeCleanupPendingError();
    }
    this.cleanup.set(obligation.idempotencyKey, {
      obligation,
      ownerId: "",
      expiresAt: 0,
    });
    return true;
  }

  markCleanupBackendStartAttempted(
    key: string,
    requestHash: string,
    generation: string,
    backendAdmissionKey: string,
  ): void {
    const entry = this.cleanup.get(key);
    if (
      !entry ||
      entry.obligation.requestHash !== requestHash ||
      entry.obligation.generation !== generation ||
      entry.obligation.backendAdmissionKey !== backendAdmissionKey
    ) {
      throw new Error("Cleanup obligation no longer matches the planned backend run.");
    }
    this.cleanup.set(key, {
      ...entry,
      obligation: {
        ...entry.obligation,
        backendStartAttempted: true,
      },
    });
  }

  setCleanupBackendSubmission(
    key: string,
    requestHash: string,
    generation: string,
    backendAdmissionKey: string,
    submission: HermesBridgeBackendSubmission,
  ): void {
    const entry = this.cleanup.get(key);
    if (
      !entry ||
      entry.obligation.requestHash !== requestHash ||
      entry.obligation.generation !== generation ||
      entry.obligation.backendAdmissionKey !== backendAdmissionKey
    ) {
      throw new Error("Cleanup obligation no longer matches the planned backend run.");
    }
    this.cleanup.set(key, {
      ...entry,
      obligation: {
        ...entry.obligation,
        backendSubmission: structuredClone(submission),
      },
    });
  }

  confirmCleanupBackendAdmission(
    key: string,
    requestHash: string,
    generation: string,
    backendAdmissionKey: string,
    admittedBackendRunId: string,
  ): void {
    const entry = this.cleanup.get(key);
    if (
      !entry ||
      entry.obligation.requestHash !== requestHash ||
      entry.obligation.generation !== generation ||
      entry.obligation.backendAdmissionKey !== backendAdmissionKey
    ) {
      throw new Error("Cleanup obligation no longer matches the planned backend run.");
    }
    this.cleanup.set(key, {
      ...entry,
      obligation: {
        ...entry.obligation,
        backendRunId: admittedBackendRunId,
        backendStartAttempted: true,
      },
    });
  }

  listDueCleanup(nowMs = Date.now()): HermesBridgeCleanupObligation[] {
    return [...this.cleanup.values()]
      .map((entry) => entry.obligation)
      .filter((entry) => entry.dueAt <= nowMs);
  }

  getCleanup(key: string): HermesBridgeCleanupObligation | undefined {
    return this.cleanup.get(key)?.obligation;
  }

  claimCleanup(
    key: string,
    requestHash: string,
    generation: string,
    options: HermesBridgeIdempotencyClaimOptions,
  ): boolean {
    const entry = this.cleanup.get(key);
    const nowMs = options.nowMs ?? Date.now();
    if (
      !entry ||
      entry.obligation.requestHash !== requestHash ||
      entry.obligation.generation !== generation ||
      (entry.ownerId && entry.expiresAt > nowMs)
    ) {
      return false;
    }
    this.cleanup.set(key, {
      obligation: entry.obligation,
      ownerId: options.ownerId,
      expiresAt: nowMs + options.leaseMs,
    });
    return true;
  }

  releaseCleanup(key: string, requestHash: string, generation: string, ownerId: string): void {
    const entry = this.cleanup.get(key);
    if (
      entry?.obligation.requestHash === requestHash &&
      entry.obligation.generation === generation &&
      entry.ownerId === ownerId
    ) {
      this.cleanup.set(key, {
        obligation: entry.obligation,
        ownerId: "",
        expiresAt: 0,
      });
    }
  }

  setCleanupAuditedTerminal(
    key: string,
    requestHash: string,
    generation: string,
    ownerId: string,
    terminal: HermesBridgeAsyncTerminalState,
  ): void {
    const entry = this.cleanup.get(key);
    if (
      !entry ||
      entry.obligation.requestHash !== requestHash ||
      entry.obligation.generation !== generation ||
      entry.ownerId !== ownerId ||
      terminal.idempotencyKey !== key ||
      terminal.requestHash !== requestHash ||
      terminal.generation !== generation ||
      terminal.backendRunId !== entry.obligation.backendRunId
    ) {
      throw new Error("Cleanup audited terminal identity no longer matches.");
    }
    this.cleanup.set(key, {
      ...entry,
      obligation: {
        ...entry.obligation,
        auditedTerminal: structuredClone(terminal),
      },
    });
  }

  completeCleanup(
    key: string,
    requestHash: string,
    generation: string,
    ownerId: string,
    terminal: HermesBridgeAsyncTerminalState,
  ): void {
    const entry = this.cleanup.get(key);
    if (
      !entry ||
      entry.obligation.requestHash !== requestHash ||
      entry.obligation.generation !== generation ||
      entry.ownerId !== ownerId ||
      terminal.idempotencyKey !== key ||
      terminal.requestHash !== requestHash ||
      terminal.generation !== generation ||
      terminal.backendRunId !== entry.obligation.backendRunId
    ) {
      throw new Error("Cleanup obligation ownership or terminal identity no longer matches.");
    }
    const existing = this.cleanupTerminals.get(key);
    if (
      existing &&
      (existing.requestHash !== requestHash ||
        existing.generation !== generation ||
        existing.backendRunId !== terminal.backendRunId)
    ) {
      throw new Error("Cleanup terminal tombstone conflicts with an earlier execution.");
    }
    this.cleanupTerminals.set(key, structuredClone(terminal));
    this.cleanup.delete(key);
  }

  getCleanupTerminal(key: string): HermesBridgeAsyncTerminalState | undefined {
    const terminal = this.cleanupTerminals.get(key);
    return terminal ? structuredClone(terminal) : undefined;
  }

  clearCleanup(key: string, requestHash: string, generation: string, ownerId?: string): void {
    const entry = this.cleanup.get(key);
    if (
      entry?.obligation.requestHash === requestHash &&
      entry.obligation.generation === generation &&
      (!entry.ownerId || entry.ownerId === ownerId || entry.expiresAt <= Date.now())
    ) {
      this.cleanup.delete(key);
    }
  }
}

function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }
  return path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path;
}

export class SqliteHermesBridgeIdempotencyStore implements HermesBridgeIdempotencyStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    const resolvedPath = expandHome(path);
    const storeDirectory = dirname(resolvedPath);
    mkdirSync(storeDirectory, { recursive: true, mode: 0o700 });
    const directoryStat = statSync(storeDirectory);
    if (!directoryStat.isDirectory() || (directoryStat.mode & 0o077) !== 0) {
      throw new Error("Hermes bridge idempotency directory must be owner-only (mode 0700).");
    }
    if (typeof process.getuid === "function" && directoryStat.uid !== process.getuid()) {
      throw new Error("Hermes bridge idempotency directory must be owned by the Gateway user.");
    }
    for (const storePath of [resolvedPath, `${resolvedPath}-wal`, `${resolvedPath}-shm`]) {
      if (existsSync(storePath)) {
        chmodSync(storePath, 0o600);
      }
    }
    this.db = new DatabaseSync(resolvedPath);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS hermes_bridge_idempotency (
        idempotency_key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hermes_bridge_idempotency_claims (
        idempotency_key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        owner_id TEXT NOT NULL DEFAULT '',
        expires_at INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hermes_bridge_idempotency_reservations (
        idempotency_key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hermes_bridge_cleanup_obligations (
        idempotency_key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        generation TEXT NOT NULL,
        backend_admission_key TEXT NOT NULL DEFAULT '',
        backend_run_id TEXT NOT NULL DEFAULT '',
        backend_start_attempted INTEGER NOT NULL DEFAULT 1,
        backend_submission_json TEXT NOT NULL DEFAULT '',
        audited_terminal_json TEXT NOT NULL DEFAULT '',
        request_json TEXT NOT NULL,
        due_at INTEGER NOT NULL,
        cleanup_owner TEXT NOT NULL DEFAULT '',
        cleanup_expires_at INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hermes_bridge_cleanup_quarantine (
        idempotency_key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        request_json TEXT NOT NULL,
        due_at INTEGER NOT NULL,
        reason TEXT NOT NULL,
        quarantined_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hermes_bridge_async_terminal (
        idempotency_key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        generation TEXT NOT NULL,
        backend_run_id TEXT NOT NULL,
        request_json TEXT NOT NULL,
        output_json TEXT NOT NULL,
        completed_at INTEGER NOT NULL
      );
    `);
    const claimColumns = new Set(
      (
        this.db.prepare("PRAGMA table_info(hermes_bridge_idempotency_claims)").all() as Array<{
          name?: unknown;
        }>
      )
        .map((row) => row.name)
        .filter((name): name is string => typeof name === "string"),
    );
    if (!claimColumns.has("owner_id")) {
      this.db.exec(
        "ALTER TABLE hermes_bridge_idempotency_claims ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''",
      );
    }
    const cleanupColumns = new Set(
      (
        this.db.prepare("PRAGMA table_info(hermes_bridge_cleanup_obligations)").all() as Array<{
          name?: unknown;
        }>
      )
        .map((row) => row.name)
        .filter((name): name is string => typeof name === "string"),
    );
    const legacyCleanupNeedsQuarantine =
      cleanupColumns.size > 0 &&
      (!cleanupColumns.has("generation") ||
        !cleanupColumns.has("backend_admission_key") ||
        !cleanupColumns.has("backend_run_id") ||
        !cleanupColumns.has("backend_start_attempted") ||
        !cleanupColumns.has("backend_submission_json"));
    if (legacyCleanupNeedsQuarantine) {
      this.quarantineCleanupRows(
        "legacy cleanup row predates authoritative backend submission identity",
      );
    }
    if (!cleanupColumns.has("generation")) {
      this.db.exec(
        "ALTER TABLE hermes_bridge_cleanup_obligations ADD COLUMN generation TEXT NOT NULL DEFAULT ''",
      );
    }
    if (!cleanupColumns.has("backend_run_id")) {
      this.db.exec(
        "ALTER TABLE hermes_bridge_cleanup_obligations ADD COLUMN backend_run_id TEXT NOT NULL DEFAULT ''",
      );
    }
    if (!cleanupColumns.has("backend_admission_key")) {
      this.db.exec(
        "ALTER TABLE hermes_bridge_cleanup_obligations ADD COLUMN backend_admission_key TEXT NOT NULL DEFAULT ''",
      );
    }
    if (!cleanupColumns.has("backend_start_attempted")) {
      this.db.exec(
        "ALTER TABLE hermes_bridge_cleanup_obligations ADD COLUMN backend_start_attempted INTEGER NOT NULL DEFAULT 1",
      );
    }
    if (!cleanupColumns.has("backend_submission_json")) {
      this.db.exec(
        "ALTER TABLE hermes_bridge_cleanup_obligations ADD COLUMN backend_submission_json TEXT NOT NULL DEFAULT ''",
      );
    }
    if (!cleanupColumns.has("audited_terminal_json")) {
      this.db.exec(
        "ALTER TABLE hermes_bridge_cleanup_obligations ADD COLUMN audited_terminal_json TEXT NOT NULL DEFAULT ''",
      );
    }
    if (!cleanupColumns.has("cleanup_owner")) {
      this.db.exec(
        "ALTER TABLE hermes_bridge_cleanup_obligations ADD COLUMN cleanup_owner TEXT NOT NULL DEFAULT ''",
      );
    }
    if (!cleanupColumns.has("cleanup_expires_at")) {
      this.db.exec(
        "ALTER TABLE hermes_bridge_cleanup_obligations ADD COLUMN cleanup_expires_at INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!claimColumns.has("expires_at")) {
      this.db.exec(
        "ALTER TABLE hermes_bridge_idempotency_claims ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0",
      );
    }
    this.db.exec(`
      INSERT OR IGNORE INTO hermes_bridge_idempotency_reservations
        (idempotency_key, request_hash, created_at)
      SELECT idempotency_key, request_hash, created_at
        FROM hermes_bridge_idempotency;
      INSERT OR IGNORE INTO hermes_bridge_idempotency_reservations
        (idempotency_key, request_hash, created_at)
      SELECT idempotency_key, request_hash, created_at
        FROM hermes_bridge_idempotency_claims;
      INSERT OR IGNORE INTO hermes_bridge_idempotency_reservations
        (idempotency_key, request_hash, created_at)
      SELECT idempotency_key, request_hash, created_at
        FROM hermes_bridge_cleanup_obligations;
      INSERT OR IGNORE INTO hermes_bridge_idempotency_reservations
        (idempotency_key, request_hash, created_at)
      SELECT idempotency_key, request_hash, quarantined_at
        FROM hermes_bridge_cleanup_quarantine;
      INSERT OR IGNORE INTO hermes_bridge_idempotency_reservations
        (idempotency_key, request_hash, created_at)
      SELECT idempotency_key, request_hash, datetime(completed_at / 1000, 'unixepoch')
        FROM hermes_bridge_async_terminal;
    `);
    this.quarantineCleanupRows(
      "cleanup row lacks authoritative backend submission identity",
      `generation = ''
       OR (
         backend_start_attempted = 1
         AND (backend_admission_key = '' OR backend_submission_json = '')
       )`,
    );
    for (const storePath of [resolvedPath, `${resolvedPath}-wal`, `${resolvedPath}-shm`]) {
      if (existsSync(storePath)) {
        chmodSync(storePath, 0o600);
      }
    }
  }

  private quarantineCleanupRows(reason: string, predicate = "1 = 1"): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO hermes_bridge_cleanup_quarantine
             (
               idempotency_key,
               request_hash,
               request_json,
               due_at,
               reason,
               quarantined_at
             )
           SELECT
             idempotency_key,
             request_hash,
             request_json,
             due_at,
             ?,
             ?
           FROM hermes_bridge_cleanup_obligations
           WHERE ${predicate}`,
        )
        .run(reason, new Date().toISOString());
      this.db.exec(`DELETE FROM hermes_bridge_cleanup_obligations WHERE ${predicate}`);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  get(key: string): HermesBridgeIdempotencyEntry | undefined {
    const row = this.db
      .prepare(
        "SELECT request_hash, result_json FROM hermes_bridge_idempotency WHERE idempotency_key = ?",
      )
      .get(key) as { request_hash?: unknown; result_json?: unknown } | undefined;
    if (typeof row?.request_hash !== "string" || typeof row.result_json !== "string") {
      return undefined;
    }
    return {
      requestHash: row.request_hash,
      result: JSON.parse(row.result_json) as HermesBridgeResult,
    };
  }

  claim(
    key: string,
    requestHash: string,
    options: HermesBridgeIdempotencyClaimOptions,
  ): HermesBridgeIdempotencyClaim {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const completed = this.get(key);
      if (completed) {
        this.db.exec("COMMIT");
        return completed.requestHash === requestHash
          ? { status: "completed", entry: completed }
          : { status: "conflict", requestHash: completed.requestHash };
      }
      const reservation = this.db
        .prepare(
          `SELECT request_hash
             FROM hermes_bridge_idempotency_reservations
            WHERE idempotency_key = ?`,
        )
        .get(key) as { request_hash?: unknown } | undefined;
      if (typeof reservation?.request_hash === "string") {
        if (reservation.request_hash !== requestHash) {
          this.db.exec("COMMIT");
          return { status: "conflict", requestHash: reservation.request_hash };
        }
      } else {
        this.db
          .prepare(
            `INSERT INTO hermes_bridge_idempotency_reservations
               (idempotency_key, request_hash, created_at)
             VALUES (?, ?, ?)`,
          )
          .run(key, requestHash, new Date().toISOString());
      }
      const pending = this.db
        .prepare(
          `SELECT request_hash, owner_id, expires_at
           FROM hermes_bridge_idempotency_claims
           WHERE idempotency_key = ?`,
        )
        .get(key) as
        | { request_hash?: unknown; owner_id?: unknown; expires_at?: unknown }
        | undefined;
      const nowMs = options.nowMs ?? Date.now();
      if (typeof pending?.request_hash === "string") {
        if (pending.request_hash !== requestHash) {
          this.db.exec("COMMIT");
          return { status: "conflict", requestHash: pending.request_hash };
        }
        if (typeof pending.expires_at === "number" && pending.expires_at > nowMs) {
          this.db.exec("COMMIT");
          return { status: "pending", requestHash: pending.request_hash };
        }
        this.db
          .prepare(
            `UPDATE hermes_bridge_idempotency_claims
             SET owner_id = ?, expires_at = ?, created_at = ?
             WHERE idempotency_key = ? AND request_hash = ?`,
          )
          .run(
            options.ownerId,
            nowMs + options.leaseMs,
            new Date(nowMs).toISOString(),
            key,
            requestHash,
          );
        this.db.exec("COMMIT");
        return { status: "claimed", recovered: true };
      }
      this.db
        .prepare(
          `INSERT INTO hermes_bridge_idempotency_claims
             (idempotency_key, request_hash, owner_id, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          key,
          requestHash,
          options.ownerId,
          nowMs + options.leaseMs,
          new Date(nowMs).toISOString(),
        );
      this.db.exec("COMMIT");
      return { status: "claimed", recovered: false };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  release(key: string, requestHash: string, ownerId: string): void {
    this.db
      .prepare(
        `DELETE FROM hermes_bridge_idempotency_claims
         WHERE idempotency_key = ? AND request_hash = ? AND owner_id = ?`,
      )
      .run(key, requestHash, ownerId);
  }

  set(key: string, value: HermesBridgeIdempotencyEntry, ownerId?: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const reservation = this.db
        .prepare(
          `SELECT request_hash
             FROM hermes_bridge_idempotency_reservations
            WHERE idempotency_key = ?`,
        )
        .get(key) as { request_hash?: unknown } | undefined;
      if (
        typeof reservation?.request_hash === "string" &&
        reservation.request_hash !== value.requestHash
      ) {
        throw new Error("Idempotency key is reserved for a different request hash.");
      }
      if (!reservation) {
        this.db
          .prepare(
            `INSERT INTO hermes_bridge_idempotency_reservations
               (idempotency_key, request_hash, created_at)
             VALUES (?, ?, ?)`,
          )
          .run(key, value.requestHash, new Date().toISOString());
      }
      if (ownerId) {
        const pending = this.db
          .prepare(
            `SELECT request_hash, owner_id
             FROM hermes_bridge_idempotency_claims
             WHERE idempotency_key = ?`,
          )
          .get(key) as { request_hash?: unknown; owner_id?: unknown } | undefined;
        if (pending?.request_hash !== value.requestHash || pending.owner_id !== ownerId) {
          throw new Error("Idempotency claim ownership was lost before result persistence.");
        }
      }
      this.db
        .prepare(
          `INSERT INTO hermes_bridge_idempotency
             (idempotency_key, request_hash, result_json, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(idempotency_key) DO NOTHING`,
        )
        .run(key, value.requestHash, JSON.stringify(value.result), new Date().toISOString());
      if (ownerId) {
        this.release(key, value.requestHash, ownerId);
      } else {
        this.db
          .prepare(
            `DELETE FROM hermes_bridge_idempotency_claims
             WHERE idempotency_key = ? AND request_hash = ?`,
          )
          .run(key, value.requestHash);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  registerCleanup(obligation: HermesBridgeCleanupObligation, nowMs = Date.now()): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const terminal = this.db
        .prepare(
          `SELECT 1
             FROM hermes_bridge_async_terminal
            WHERE idempotency_key = ?`,
        )
        .get(obligation.idempotencyKey);
      if (terminal) {
        this.db.exec("COMMIT");
        return false;
      }
      const reservation = this.db
        .prepare(
          `SELECT request_hash
             FROM hermes_bridge_idempotency_reservations
            WHERE idempotency_key = ?`,
        )
        .get(obligation.idempotencyKey) as { request_hash?: unknown } | undefined;
      if (
        typeof reservation?.request_hash === "string" &&
        reservation.request_hash !== obligation.requestHash
      ) {
        throw new Error("Idempotency key is reserved for a different request hash.");
      }
      if (!reservation) {
        this.db
          .prepare(
            `INSERT INTO hermes_bridge_idempotency_reservations
               (idempotency_key, request_hash, created_at)
             VALUES (?, ?, ?)`,
          )
          .run(obligation.idempotencyKey, obligation.requestHash, new Date(nowMs).toISOString());
      }
      const result = this.db
        .prepare(
          `INSERT INTO hermes_bridge_cleanup_obligations
             (
               idempotency_key,
               request_hash,
               generation,
               backend_admission_key,
               backend_run_id,
               backend_start_attempted,
               backend_submission_json,
               audited_terminal_json,
               request_json,
               due_at,
               cleanup_owner,
               cleanup_expires_at,
               created_at
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, ?)
           ON CONFLICT(idempotency_key) DO NOTHING`,
        )
        .run(
          obligation.idempotencyKey,
          obligation.requestHash,
          obligation.generation,
          obligation.backendAdmissionKey ?? "",
          obligation.backendRunId ?? "",
          obligation.backendStartAttempted ? 1 : 0,
          obligation.backendSubmission ? JSON.stringify(obligation.backendSubmission) : "",
          obligation.auditedTerminal ? JSON.stringify(obligation.auditedTerminal) : "",
          JSON.stringify(obligation.request),
          obligation.dueAt,
          new Date(nowMs).toISOString(),
        );
      if (result.changes !== 1) {
        throw new HermesBridgeCleanupPendingError();
      }
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markCleanupBackendStartAttempted(
    key: string,
    requestHash: string,
    generation: string,
    backendAdmissionKey: string,
  ): void {
    const result = this.db
      .prepare(
        `UPDATE hermes_bridge_cleanup_obligations
            SET backend_start_attempted = 1
          WHERE idempotency_key = ?
            AND request_hash = ?
            AND generation = ?
            AND backend_admission_key = ?`,
      )
      .run(key, requestHash, generation, backendAdmissionKey);
    if (result.changes !== 1) {
      throw new Error("Cleanup obligation no longer matches the planned backend run.");
    }
  }

  setCleanupBackendSubmission(
    key: string,
    requestHash: string,
    generation: string,
    backendAdmissionKey: string,
    submission: HermesBridgeBackendSubmission,
  ): void {
    const result = this.db
      .prepare(
        `UPDATE hermes_bridge_cleanup_obligations
            SET backend_submission_json = ?
          WHERE idempotency_key = ?
            AND request_hash = ?
            AND generation = ?
            AND backend_admission_key = ?`,
      )
      .run(JSON.stringify(submission), key, requestHash, generation, backendAdmissionKey);
    if (result.changes !== 1) {
      throw new Error("Cleanup obligation no longer matches the planned backend run.");
    }
  }

  confirmCleanupBackendAdmission(
    key: string,
    requestHash: string,
    generation: string,
    backendAdmissionKey: string,
    admittedBackendRunId: string,
  ): void {
    const result = this.db
      .prepare(
        `UPDATE hermes_bridge_cleanup_obligations
            SET backend_run_id = ?, backend_start_attempted = 1
          WHERE idempotency_key = ?
            AND request_hash = ?
            AND generation = ?
            AND backend_admission_key = ?`,
      )
      .run(admittedBackendRunId, key, requestHash, generation, backendAdmissionKey);
    if (result.changes !== 1) {
      throw new Error("Cleanup obligation no longer matches the planned backend run.");
    }
  }

  listDueCleanup(nowMs = Date.now()): HermesBridgeCleanupObligation[] {
    const rows = this.db
      .prepare(
        `SELECT idempotency_key, request_hash, generation, backend_admission_key, backend_run_id,
                backend_start_attempted, backend_submission_json, audited_terminal_json,
                request_json, due_at
           FROM hermes_bridge_cleanup_obligations
          WHERE due_at <= ?
            AND generation <> ''
            AND (
              backend_start_attempted = 0
              OR (backend_admission_key <> '' AND backend_submission_json <> '')
            )
          ORDER BY due_at ASC`,
      )
      .all(nowMs) as Array<{
      idempotency_key?: unknown;
      request_hash?: unknown;
      generation?: unknown;
      backend_admission_key?: unknown;
      backend_run_id?: unknown;
      backend_start_attempted?: unknown;
      backend_submission_json?: unknown;
      audited_terminal_json?: unknown;
      request_json?: unknown;
      due_at?: unknown;
    }>;
    const obligations: HermesBridgeCleanupObligation[] = [];
    for (const row of rows) {
      if (
        typeof row.idempotency_key !== "string" ||
        typeof row.request_hash !== "string" ||
        typeof row.generation !== "string" ||
        typeof row.request_json !== "string" ||
        typeof row.due_at !== "number"
      ) {
        continue;
      }
      try {
        obligations.push({
          idempotencyKey: row.idempotency_key,
          requestHash: row.request_hash,
          generation: row.generation,
          ...(typeof row.backend_admission_key === "string" && row.backend_admission_key
            ? { backendAdmissionKey: row.backend_admission_key }
            : {}),
          ...(typeof row.backend_run_id === "string" && row.backend_run_id
            ? { backendRunId: row.backend_run_id }
            : {}),
          ...(row.backend_start_attempted === 1 ? { backendStartAttempted: true } : {}),
          ...(typeof row.backend_submission_json === "string" && row.backend_submission_json
            ? {
                backendSubmission: JSON.parse(
                  row.backend_submission_json,
                ) as HermesBridgeBackendSubmission,
              }
            : {}),
          ...(typeof row.audited_terminal_json === "string" && row.audited_terminal_json
            ? {
                auditedTerminal: JSON.parse(
                  row.audited_terminal_json,
                ) as HermesBridgeAsyncTerminalState,
              }
            : {}),
          request: JSON.parse(row.request_json) as HermesBridgeRequest,
          dueAt: row.due_at,
        });
      } catch {
        // Keep malformed rows for operator inspection instead of deleting
        // cleanup evidence that cannot be reconstructed safely.
      }
    }
    return obligations;
  }

  getCleanup(key: string): HermesBridgeCleanupObligation | undefined {
    const row = this.db
      .prepare(
        `SELECT idempotency_key, request_hash, generation, backend_admission_key, backend_run_id,
                backend_start_attempted, backend_submission_json, audited_terminal_json,
                request_json, due_at
           FROM hermes_bridge_cleanup_obligations
          WHERE idempotency_key = ?`,
      )
      .get(key) as
      | {
          idempotency_key?: unknown;
          request_hash?: unknown;
          generation?: unknown;
          backend_admission_key?: unknown;
          backend_run_id?: unknown;
          backend_start_attempted?: unknown;
          backend_submission_json?: unknown;
          audited_terminal_json?: unknown;
          request_json?: unknown;
          due_at?: unknown;
        }
      | undefined;
    if (
      typeof row?.idempotency_key !== "string" ||
      typeof row.request_hash !== "string" ||
      typeof row.generation !== "string" ||
      typeof row.request_json !== "string" ||
      typeof row.due_at !== "number"
    ) {
      return undefined;
    }
    try {
      return {
        idempotencyKey: row.idempotency_key,
        requestHash: row.request_hash,
        generation: row.generation,
        ...(typeof row.backend_admission_key === "string" && row.backend_admission_key
          ? { backendAdmissionKey: row.backend_admission_key }
          : {}),
        ...(typeof row.backend_run_id === "string" && row.backend_run_id
          ? { backendRunId: row.backend_run_id }
          : {}),
        ...(row.backend_start_attempted === 1 ? { backendStartAttempted: true } : {}),
        ...(typeof row.backend_submission_json === "string" && row.backend_submission_json
          ? {
              backendSubmission: JSON.parse(
                row.backend_submission_json,
              ) as HermesBridgeBackendSubmission,
            }
          : {}),
        ...(typeof row.audited_terminal_json === "string" && row.audited_terminal_json
          ? {
              auditedTerminal: JSON.parse(
                row.audited_terminal_json,
              ) as HermesBridgeAsyncTerminalState,
            }
          : {}),
        request: JSON.parse(row.request_json) as HermesBridgeRequest,
        dueAt: row.due_at,
      };
    } catch {
      return undefined;
    }
  }

  claimCleanup(
    key: string,
    requestHash: string,
    generation: string,
    options: HermesBridgeIdempotencyClaimOptions,
  ): boolean {
    const nowMs = options.nowMs ?? Date.now();
    const result = this.db
      .prepare(
        `UPDATE hermes_bridge_cleanup_obligations
            SET cleanup_owner = ?, cleanup_expires_at = ?
          WHERE idempotency_key = ?
            AND request_hash = ?
            AND generation = ?
            AND (cleanup_owner = '' OR cleanup_expires_at <= ?)`,
      )
      .run(options.ownerId, nowMs + options.leaseMs, key, requestHash, generation, nowMs);
    return result.changes === 1;
  }

  releaseCleanup(key: string, requestHash: string, generation: string, ownerId: string): void {
    this.db
      .prepare(
        `UPDATE hermes_bridge_cleanup_obligations
            SET cleanup_owner = '', cleanup_expires_at = 0
          WHERE idempotency_key = ?
            AND request_hash = ?
            AND generation = ?
            AND cleanup_owner = ?`,
      )
      .run(key, requestHash, generation, ownerId);
  }

  setCleanupAuditedTerminal(
    key: string,
    requestHash: string,
    generation: string,
    ownerId: string,
    terminal: HermesBridgeAsyncTerminalState,
  ): void {
    if (
      terminal.idempotencyKey !== key ||
      terminal.requestHash !== requestHash ||
      terminal.generation !== generation
    ) {
      throw new Error("Cleanup audited terminal identity does not match.");
    }
    const result = this.db
      .prepare(
        `UPDATE hermes_bridge_cleanup_obligations
            SET audited_terminal_json = ?
          WHERE idempotency_key = ?
            AND request_hash = ?
            AND generation = ?
            AND cleanup_owner = ?
            AND backend_run_id = ?`,
      )
      .run(JSON.stringify(terminal), key, requestHash, generation, ownerId, terminal.backendRunId);
    if (result.changes !== 1) {
      throw new Error("Cleanup audited terminal identity no longer matches.");
    }
  }

  completeCleanup(
    key: string,
    requestHash: string,
    generation: string,
    ownerId: string,
    terminal: HermesBridgeAsyncTerminalState,
  ): void {
    if (
      terminal.idempotencyKey !== key ||
      terminal.requestHash !== requestHash ||
      terminal.generation !== generation
    ) {
      throw new Error("Cleanup terminal identity does not match the cleanup obligation.");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const obligation = this.db
        .prepare(
          `SELECT backend_run_id
             FROM hermes_bridge_cleanup_obligations
            WHERE idempotency_key = ?
              AND request_hash = ?
              AND generation = ?
              AND cleanup_owner = ?`,
        )
        .get(key, requestHash, generation, ownerId) as { backend_run_id?: unknown } | undefined;
      if (
        typeof obligation?.backend_run_id !== "string" ||
        !obligation.backend_run_id ||
        obligation.backend_run_id !== terminal.backendRunId
      ) {
        throw new Error("Cleanup obligation ownership or terminal identity no longer matches.");
      }
      const inserted = this.db
        .prepare(
          `INSERT INTO hermes_bridge_async_terminal
             (
               idempotency_key,
               request_hash,
               generation,
               backend_run_id,
               request_json,
               output_json,
               completed_at
             )
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(idempotency_key) DO NOTHING`,
        )
        .run(
          key,
          requestHash,
          generation,
          terminal.backendRunId,
          JSON.stringify(terminal.request),
          JSON.stringify(terminal.output),
          terminal.completedAt,
        );
      if (inserted.changes !== 1) {
        const existing = this.db
          .prepare(
            `SELECT request_hash, generation, backend_run_id
               FROM hermes_bridge_async_terminal
              WHERE idempotency_key = ?`,
          )
          .get(key) as
          | { request_hash?: unknown; generation?: unknown; backend_run_id?: unknown }
          | undefined;
        if (
          existing?.request_hash !== requestHash ||
          existing.generation !== generation ||
          existing.backend_run_id !== terminal.backendRunId
        ) {
          throw new Error("Cleanup terminal tombstone conflicts with an earlier execution.");
        }
      }
      const removed = this.db
        .prepare(
          `DELETE FROM hermes_bridge_cleanup_obligations
            WHERE idempotency_key = ?
              AND request_hash = ?
              AND generation = ?
              AND cleanup_owner = ?`,
        )
        .run(key, requestHash, generation, ownerId);
      if (removed.changes !== 1) {
        throw new Error("Cleanup obligation ownership was lost before terminal persistence.");
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getCleanupTerminal(key: string): HermesBridgeAsyncTerminalState | undefined {
    const row = this.db
      .prepare(
        `SELECT request_hash, generation, backend_run_id, request_json, output_json, completed_at
           FROM hermes_bridge_async_terminal
          WHERE idempotency_key = ?`,
      )
      .get(key) as
      | {
          request_hash?: unknown;
          generation?: unknown;
          backend_run_id?: unknown;
          request_json?: unknown;
          output_json?: unknown;
          completed_at?: unknown;
        }
      | undefined;
    if (
      typeof row?.request_hash !== "string" ||
      typeof row.generation !== "string" ||
      typeof row.backend_run_id !== "string" ||
      typeof row.request_json !== "string" ||
      typeof row.output_json !== "string" ||
      typeof row.completed_at !== "number"
    ) {
      return undefined;
    }
    return {
      idempotencyKey: key,
      requestHash: row.request_hash,
      generation: row.generation,
      backendRunId: row.backend_run_id,
      request: JSON.parse(row.request_json) as HermesBridgeRequest,
      output: JSON.parse(row.output_json) as Record<string, unknown>,
      completedAt: row.completed_at,
    };
  }

  clearCleanup(key: string, requestHash: string, generation: string, ownerId?: string): void {
    const ownershipClause = ownerId
      ? "AND cleanup_owner = ?"
      : "AND (cleanup_owner = '' OR cleanup_expires_at <= ?)";
    this.db
      .prepare(
        `DELETE FROM hermes_bridge_cleanup_obligations
         WHERE idempotency_key = ?
           AND request_hash = ?
           AND generation = ?
           ${ownershipClause}`,
      )
      .run(key, requestHash, generation, ownerId ?? Date.now());
  }

  close(): void {
    this.db.close();
  }
}
