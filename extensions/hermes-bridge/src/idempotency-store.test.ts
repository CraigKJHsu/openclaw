import { chmodSync, existsSync, mkdtempSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  hashHermesBridgeRequest,
  SqliteHermesBridgeIdempotencyStore,
} from "./idempotency-store.js";
import { createHermesBridgeResult, normalizeHermesBridgeRequest } from "./schema.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const directory of cleanupPaths.splice(0)) {
    for (const name of ["idempotency.sqlite-wal", "idempotency.sqlite-shm", "idempotency.sqlite"]) {
      const path = join(directory, name);
      if (existsSync(path)) {
        unlinkSync(path);
      }
    }
    rmdirSync(directory);
  }
});

function request() {
  const normalized = normalizeHermesBridgeRequest({
    taskId: "status.echo",
    idempotencyKey: "persisted-key",
    input: { message: "hello" },
  });
  if (!normalized.ok) {
    throw new Error(normalized.error.message);
  }
  return normalized.request;
}

describe("SqliteHermesBridgeIdempotencyStore", () => {
  it("refuses to create the database inside a group- or world-accessible directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "hermes-bridge-"));
    cleanupPaths.push(directory);
    const path = join(directory, "idempotency.sqlite");
    chmodSync(directory, 0o755);

    expect(() => new SqliteHermesBridgeIdempotencyStore(path)).toThrow(
      "idempotency directory must be owner-only",
    );
    expect(existsSync(path)).toBe(false);
    chmodSync(directory, 0o700);
  });

  it("persists a completed result across store recreation", () => {
    const directory = mkdtempSync(join(tmpdir(), "hermes-bridge-"));
    cleanupPaths.push(directory);
    const path = join(directory, "idempotency.sqlite");
    const normalized = request();
    const requestHash = hashHermesBridgeRequest(normalized);
    const result = createHermesBridgeResult({
      ok: true,
      request: normalized,
      mode: "mock",
      status: "succeeded",
      summary: "persisted",
      output: { message: "hello" },
    });

    const first = new SqliteHermesBridgeIdempotencyStore(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    first.set("persisted-key", { requestHash, result });
    first.close();

    const reopened = new SqliteHermesBridgeIdempotencyStore(path);
    expect(reopened.get("persisted-key")).toEqual({ requestHash, result });
    reopened.close();
  });

  it("atomically reserves one request hash and rejects conflicting claimants", () => {
    const directory = mkdtempSync(join(tmpdir(), "hermes-bridge-"));
    cleanupPaths.push(directory);
    const path = join(directory, "idempotency.sqlite");
    const first = new SqliteHermesBridgeIdempotencyStore(path);

    expect(
      first.claim("concurrent-key", "hash-1", {
        ownerId: "owner-1",
        leaseMs: 1_000,
        nowMs: 1_000,
      }),
    ).toEqual({ status: "claimed", recovered: false });
    expect(
      first.claim("concurrent-key", "hash-1", {
        ownerId: "owner-2",
        leaseMs: 1_000,
        nowMs: 1_500,
      }),
    ).toEqual({
      status: "pending",
      requestHash: "hash-1",
    });
    expect(
      first.claim("concurrent-key", "hash-2", {
        ownerId: "owner-2",
        leaseMs: 1_000,
        nowMs: 1_500,
      }),
    ).toEqual({
      status: "conflict",
      requestHash: "hash-1",
    });

    expect(
      first.claim("concurrent-key", "hash-1", {
        ownerId: "owner-2",
        leaseMs: 1_000,
        nowMs: 2_001,
      }),
    ).toEqual({ status: "claimed", recovered: true });
    expect(() =>
      first.set(
        "concurrent-key",
        {
          requestHash: "hash-1",
          result: createHermesBridgeResult({
            ok: true,
            mode: "mock",
            status: "succeeded",
            summary: "late owner",
          }),
        },
        "owner-1",
      ),
    ).toThrow("claim ownership was lost");
    first.release("concurrent-key", "hash-1", "owner-2");
    expect(
      first.claim("concurrent-key", "hash-2", {
        ownerId: "owner-3",
        leaseMs: 1_000,
        nowMs: 2_100,
      }),
    ).toEqual({ status: "conflict", requestHash: "hash-1" });
    first.close();
  });

  it("persists durable cleanup obligations across store recreation", () => {
    const directory = mkdtempSync(join(tmpdir(), "hermes-bridge-"));
    cleanupPaths.push(directory);
    const path = join(directory, "idempotency.sqlite");
    const normalized = request();
    const requestHash = hashHermesBridgeRequest(normalized);

    const first = new SqliteHermesBridgeIdempotencyStore(path);
    first.registerCleanup({
      idempotencyKey: normalized.idempotencyKey,
      requestHash,
      generation: "generation-1",
      request: normalized,
      dueAt: 2_000,
    });
    expect(first.listDueCleanup(1_999)).toEqual([]);
    first.close();

    const reopened = new SqliteHermesBridgeIdempotencyStore(path);
    const staleSweep = reopened.listDueCleanup(2_000);
    expect(staleSweep).toEqual([
      {
        idempotencyKey: normalized.idempotencyKey,
        requestHash,
        generation: "generation-1",
        request: normalized,
        dueAt: 2_000,
      },
    ]);
    reopened.clearCleanup(normalized.idempotencyKey, requestHash, "generation-1");
    reopened.registerCleanup({
      idempotencyKey: normalized.idempotencyKey,
      requestHash,
      generation: "generation-2",
      request: normalized,
      dueAt: 3_000,
    });
    reopened.clearCleanup(normalized.idempotencyKey, requestHash, "generation-1");
    expect(reopened.listDueCleanup(3_000)).toEqual([
      {
        idempotencyKey: normalized.idempotencyKey,
        requestHash,
        generation: "generation-2",
        request: normalized,
        dueAt: 3_000,
      },
    ]);
    reopened.clearCleanup(normalized.idempotencyKey, requestHash, "generation-2");
    expect(reopened.listDueCleanup(3_000)).toEqual([]);
    reopened.close();
  });

  it("atomically fences cleanup ownership before a newer generation can register", () => {
    const directory = mkdtempSync(join(tmpdir(), "hermes-bridge-"));
    cleanupPaths.push(directory);
    const path = join(directory, "idempotency.sqlite");
    const normalized = request();
    const requestHash = hashHermesBridgeRequest(normalized);
    const nowMs = Date.now();
    const store = new SqliteHermesBridgeIdempotencyStore(path);

    store.registerCleanup(
      {
        idempotencyKey: normalized.idempotencyKey,
        requestHash,
        generation: "generation-1",
        request: normalized,
        dueAt: nowMs,
      },
      nowMs,
    );
    expect(
      store.claimCleanup(normalized.idempotencyKey, requestHash, "generation-1", {
        ownerId: "sweeper-1",
        leaseMs: 30_000,
        nowMs,
      }),
    ).toBe(true);
    expect(() =>
      store.registerCleanup(
        {
          idempotencyKey: normalized.idempotencyKey,
          requestHash,
          generation: "generation-2",
          request: normalized,
          dueAt: nowMs + 1,
        },
        nowMs + 1,
      ),
    ).toThrow("earlier execution generation");

    store.releaseCleanup(normalized.idempotencyKey, requestHash, "generation-1", "sweeper-1");
    expect(() =>
      store.registerCleanup(
        {
          idempotencyKey: normalized.idempotencyKey,
          requestHash,
          generation: "generation-2",
          request: normalized,
          dueAt: nowMs + 1,
        },
        nowMs + 1,
      ),
    ).toThrow("earlier execution generation");
    expect(
      store.claimCleanup(normalized.idempotencyKey, requestHash, "generation-1", {
        ownerId: "sweeper-2",
        leaseMs: 30_000,
        nowMs: nowMs + 1,
      }),
    ).toBe(true);
    store.clearCleanup(normalized.idempotencyKey, requestHash, "generation-1", "sweeper-2");
    store.registerCleanup(
      {
        idempotencyKey: normalized.idempotencyKey,
        requestHash,
        generation: "generation-2",
        request: normalized,
        dueAt: nowMs + 1,
      },
      nowMs + 1,
    );
    expect(
      store.claimCleanup(normalized.idempotencyKey, requestHash, "generation-1", {
        ownerId: "stale-sweeper",
        leaseMs: 30_000,
        nowMs: nowMs + 2,
      }),
    ).toBe(false);
    expect(
      store.claimCleanup(normalized.idempotencyKey, requestHash, "generation-2", {
        ownerId: "sweeper-3",
        leaseMs: 30_000,
        nowMs: nowMs + 2,
      }),
    ).toBe(true);
    store.clearCleanup(normalized.idempotencyKey, requestHash, "generation-2", "wrong-owner");
    expect(store.listDueCleanup(nowMs + 2)).toHaveLength(1);
    store.clearCleanup(normalized.idempotencyKey, requestHash, "generation-2", "sweeper-3");
    expect(store.listDueCleanup(nowMs + 2)).toEqual([]);
    store.close();
  });

  it("persists the exact planned backend run and start-attempt marker", () => {
    const directory = mkdtempSync(join(tmpdir(), "hermes-bridge-"));
    cleanupPaths.push(directory);
    const path = join(directory, "idempotency.sqlite");
    const normalized = request();
    const requestHash = hashHermesBridgeRequest(normalized);
    const store = new SqliteHermesBridgeIdempotencyStore(path);

    store.registerCleanup({
      idempotencyKey: normalized.idempotencyKey,
      requestHash,
      generation: "generation-run",
      backendAdmissionKey: "admission-generation-run",
      request: normalized,
      dueAt: 1,
    });
    const backendSubmission = {
      sessionKey: "agent:missioncrew-browser-readonly:subagent:test",
      message: "Review captured evidence.",
      extraSystemPrompt: "Do not use tools.",
      lane: "hermes-bridge:test",
      lightContext: true as const,
      deliver: false as const,
      toolsAllow: [] as [],
      disableTools: true as const,
    };
    store.setCleanupBackendSubmission(
      normalized.idempotencyKey,
      requestHash,
      "generation-run",
      "admission-generation-run",
      backendSubmission,
    );
    store.markCleanupBackendStartAttempted(
      normalized.idempotencyKey,
      requestHash,
      "generation-run",
      "admission-generation-run",
    );
    store.confirmCleanupBackendAdmission(
      normalized.idempotencyKey,
      requestHash,
      "generation-run",
      "admission-generation-run",
      "run-generation-run",
    );
    expect(store.listDueCleanup(1)).toEqual([
      {
        idempotencyKey: normalized.idempotencyKey,
        requestHash,
        generation: "generation-run",
        backendAdmissionKey: "admission-generation-run",
        backendRunId: "run-generation-run",
        backendStartAttempted: true,
        backendSubmission,
        request: normalized,
        dueAt: 1,
      },
    ]);
    expect(() =>
      store.markCleanupBackendStartAttempted(
        normalized.idempotencyKey,
        requestHash,
        "generation-run",
        "wrong-run",
      ),
    ).toThrow("planned backend run");
    store.close();
  });

  it("atomically replaces a claimed cleanup obligation with a terminal tombstone", () => {
    const directory = mkdtempSync(join(tmpdir(), "hermes-bridge-"));
    cleanupPaths.push(directory);
    const path = join(directory, "idempotency.sqlite");
    const normalized = request();
    const requestHash = hashHermesBridgeRequest(normalized);
    const store = new SqliteHermesBridgeIdempotencyStore(path);
    const backendSubmission = {
      sessionKey: "agent:missioncrew-browser-readonly:subagent:terminal",
      message: "Complete zero-effect work.",
      extraSystemPrompt: "Do not use tools.",
      lane: "hermes-bridge:test",
      lightContext: true as const,
      deliver: false as const,
      toolsAllow: [] as [],
      disableTools: true as const,
    };

    store.registerCleanup({
      idempotencyKey: normalized.idempotencyKey,
      requestHash,
      generation: "generation-terminal",
      backendAdmissionKey: "admission-terminal",
      backendRunId: "run-terminal",
      backendStartAttempted: true,
      backendSubmission,
      request: normalized,
      dueAt: 1,
    });
    expect(
      store.claimCleanup(normalized.idempotencyKey, requestHash, "generation-terminal", {
        ownerId: "terminal-owner",
        leaseMs: 30_000,
        nowMs: 1,
      }),
    ).toBe(true);
    store.completeCleanup(
      normalized.idempotencyKey,
      requestHash,
      "generation-terminal",
      "terminal-owner",
      {
        idempotencyKey: normalized.idempotencyKey,
        requestHash,
        generation: "generation-terminal",
        backendRunId: "run-terminal",
        request: normalized,
        output: { bridgeStatus: "succeeded", evidence: { terminal: true } },
        completedAt: 2,
      },
    );
    expect(store.getCleanup(normalized.idempotencyKey)).toBeUndefined();
    store.close();

    const reopened = new SqliteHermesBridgeIdempotencyStore(path);
    expect(reopened.getCleanupTerminal(normalized.idempotencyKey)).toEqual({
      idempotencyKey: normalized.idempotencyKey,
      requestHash,
      generation: "generation-terminal",
      backendRunId: "run-terminal",
      request: normalized,
      output: { bridgeStatus: "succeeded", evidence: { terminal: true } },
      completedAt: 2,
    });
    expect(
      reopened.registerCleanup({
        idempotencyKey: normalized.idempotencyKey,
        requestHash,
        generation: "generation-after-terminal",
        request: normalized,
        dueAt: 3,
      }),
    ).toBe(false);
    expect(reopened.getCleanup(normalized.idempotencyKey)).toBeUndefined();
    expect(reopened.listDueCleanup(Number.MAX_SAFE_INTEGER)).toEqual([]);
    reopened.close();
  });

  it("persists an audited terminal phase before destructive cleanup", () => {
    const directory = mkdtempSync(join(tmpdir(), "hermes-bridge-"));
    cleanupPaths.push(directory);
    const path = join(directory, "idempotency.sqlite");
    const normalized = request();
    const requestHash = hashHermesBridgeRequest(normalized);
    const auditedTerminal = {
      idempotencyKey: normalized.idempotencyKey,
      requestHash,
      generation: "generation-audited",
      backendRunId: "run-audited",
      request: normalized,
      output: {
        bridgeStatus: "succeeded",
        evidence: { terminal: true, sessionCleaned: false },
      },
      completedAt: 2,
    };
    const first = new SqliteHermesBridgeIdempotencyStore(path);
    first.registerCleanup({
      idempotencyKey: normalized.idempotencyKey,
      requestHash,
      generation: "generation-audited",
      backendAdmissionKey: "admission-audited",
      backendRunId: "run-audited",
      backendStartAttempted: true,
      backendSubmission: {
        sessionKey: "agent:missioncrew-browser-readonly:subagent:audited",
        message: "Audited result.",
        extraSystemPrompt: "Do not use tools.",
        lane: "hermes-bridge:test",
        lightContext: true,
        deliver: false,
        toolsAllow: [],
        disableTools: true,
      },
      request: normalized,
      dueAt: 1,
    });
    expect(
      first.claimCleanup(normalized.idempotencyKey, requestHash, "generation-audited", {
        ownerId: "auditor",
        leaseMs: 30_000,
        nowMs: 1,
      }),
    ).toBe(true);
    first.setCleanupAuditedTerminal(
      normalized.idempotencyKey,
      requestHash,
      "generation-audited",
      "auditor",
      auditedTerminal,
    );
    first.close();

    const reopened = new SqliteHermesBridgeIdempotencyStore(path);
    expect(reopened.getCleanup(normalized.idempotencyKey)).toMatchObject({
      auditedTerminal,
    });
    expect(
      reopened.claimCleanup(normalized.idempotencyKey, requestHash, "generation-audited", {
        ownerId: "cleaner",
        leaseMs: 30_000,
        nowMs: 30_002,
      }),
    ).toBe(true);
    reopened.completeCleanup(
      normalized.idempotencyKey,
      requestHash,
      "generation-audited",
      "cleaner",
      {
        ...auditedTerminal,
        output: {
          bridgeStatus: "succeeded",
          evidence: { terminal: true, sessionCleaned: true },
        },
      },
    );
    expect(reopened.getCleanup(normalized.idempotencyKey)).toBeUndefined();
    expect(reopened.getCleanupTerminal(normalized.idempotencyKey)).toMatchObject({
      output: { evidence: { sessionCleaned: true } },
    });
    reopened.close();
  });

  it("quarantines legacy cleanup rows that lack authoritative backend admission identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "hermes-bridge-"));
    cleanupPaths.push(directory);
    const path = join(directory, "idempotency.sqlite");
    const normalized = request();
    const requestHash = hashHermesBridgeRequest(normalized);
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE hermes_bridge_cleanup_obligations (
        idempotency_key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        request_json TEXT NOT NULL,
        due_at INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    legacy
      .prepare(
        `INSERT INTO hermes_bridge_cleanup_obligations
           (idempotency_key, request_hash, request_json, due_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        normalized.idempotencyKey,
        requestHash,
        JSON.stringify(normalized),
        1,
        new Date(0).toISOString(),
      );
    legacy.close();

    const store = new SqliteHermesBridgeIdempotencyStore(path);
    expect(store.listDueCleanup(Number.MAX_SAFE_INTEGER)).toEqual([]);
    store.registerCleanup({
      idempotencyKey: normalized.idempotencyKey,
      requestHash,
      generation: "replacement-generation",
      request: normalized,
      dueAt: 2,
    });
    expect(store.listDueCleanup(2)).toEqual([
      expect.objectContaining({ generation: "replacement-generation" }),
    ]);
    store.close();

    const inspection = new DatabaseSync(path, { readOnly: true });
    const quarantine = inspection
      .prepare(
        `SELECT idempotency_key, reason
           FROM hermes_bridge_cleanup_quarantine
          WHERE idempotency_key = ?`,
      )
      .get(normalized.idempotencyKey) as
      | { idempotency_key?: unknown; reason?: unknown }
      | undefined;
    expect(quarantine).toEqual({
      idempotency_key: normalized.idempotencyKey,
      reason: "legacy cleanup row predates authoritative backend submission identity",
    });
    inspection.close();
  });

  it("quarantines a legacy writer row inserted after the schema was upgraded", () => {
    const directory = mkdtempSync(join(tmpdir(), "hermes-bridge-"));
    cleanupPaths.push(directory);
    const path = join(directory, "idempotency.sqlite");
    const normalized = request();
    const requestHash = hashHermesBridgeRequest(normalized);
    const initialized = new SqliteHermesBridgeIdempotencyStore(path);
    initialized.close();

    const legacyWriter = new DatabaseSync(path);
    legacyWriter
      .prepare(
        `INSERT INTO hermes_bridge_cleanup_obligations
           (
             idempotency_key,
             request_hash,
             generation,
             backend_run_id,
             request_json,
             due_at,
             created_at
           )
         VALUES (?, ?, ?, '', ?, ?, ?)`,
      )
      .run(
        normalized.idempotencyKey,
        requestHash,
        "legacy-writer-generation",
        JSON.stringify(normalized),
        1,
        new Date(0).toISOString(),
      );
    legacyWriter.close();

    const reopened = new SqliteHermesBridgeIdempotencyStore(path);
    expect(reopened.listDueCleanup(Number.MAX_SAFE_INTEGER)).toEqual([]);
    reopened.close();

    const inspection = new DatabaseSync(path, { readOnly: true });
    const quarantined = inspection
      .prepare(
        `SELECT reason
           FROM hermes_bridge_cleanup_quarantine
          WHERE idempotency_key = ?`,
      )
      .get(normalized.idempotencyKey) as { reason?: unknown } | undefined;
    expect(quarantined).toEqual({
      reason: "cleanup row lacks authoritative backend submission identity",
    });
    inspection.close();
  });
});
