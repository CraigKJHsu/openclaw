import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { describe, expect, it, vi } from "vitest";
import { resolveHermesBridgeConfig } from "./config.js";
import { createHermesBridgeHttpHandler } from "./http-route.js";
import {
  hashHermesBridgeRequest,
  MemoryHermesBridgeIdempotencyStore,
} from "./idempotency-store.js";
import { createHermesBridgeResult } from "./schema.js";

function makeRequest(params: {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): IncomingMessage {
  const rawBody = params.body === undefined ? "" : JSON.stringify(params.body);
  const req = Readable.from(rawBody ? [rawBody] : []) as IncomingMessage;
  req.method = params.method ?? "POST";
  Object.defineProperty(req, "headers", {
    value: params.headers ?? {},
    configurable: true,
  });
  return req;
}

function makeResponse() {
  const headers = new Map<string, string>();
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    end(body?: string) {
      this.body = body ?? "";
    },
    body: "",
  } as unknown as ServerResponse & { body: string };
  return { res, headers };
}

async function invoke(params: {
  token?: string;
  envToken?: string;
  config?: unknown;
  body?: unknown;
}) {
  const handler = createHermesBridgeHttpHandler({
    resolveConfig: () =>
      resolveHermesBridgeConfig(
        params.config ?? {
          enabled: true,
          sharedSecretEnv: "HERMES_TOKEN",
          allowedTasks: ["status.echo"],
          allowedTools: [],
        },
      ),
    env: { HERMES_TOKEN: params.envToken ?? "secret" },
  });
  const { res } = makeResponse();
  await handler(
    makeRequest({
      headers: params.token ? { "x-openclaw-hermes-token": params.token } : {},
      body: params.body ?? {
        requestId: "req-1",
        taskId: "status.echo",
        requestedBy: "hermes",
        intent: "echo hello",
        input: { message: "hello" },
      },
    }),
    res,
  );
  return { statusCode: res.statusCode, body: JSON.parse(res.body) as unknown };
}

describe("Hermes bridge HTTP route", () => {
  it("rejects requests without the plugin-local Hermes token", async () => {
    await expect(invoke({ token: undefined })).resolves.toMatchObject({
      statusCode: 401,
      body: { ok: false, status: "blocked", error: { type: "invalid_token" } },
    });
  });

  it("fails closed when the shared-secret env var is missing", async () => {
    await expect(invoke({ token: "secret", envToken: "" })).resolves.toMatchObject({
      statusCode: 503,
      body: { ok: false, status: "failed", error: { type: "missing_secret" } },
    });
  });

  it("executes allowlisted mock tasks when gateway and plugin auth have passed", async () => {
    await expect(invoke({ token: "secret" })).resolves.toMatchObject({
      statusCode: 200,
      body: {
        ok: true,
        requestId: "req-1",
        idempotencyKey: "req-1",
        taskId: "status.echo",
        mode: "mock",
        status: "succeeded",
        output: { message: "hello" },
      },
    });
  });

  it("returns a structured error when lazy SQLite initialization fails", async () => {
    const handler = createHermesBridgeHttpHandler({
      resolveConfig: () =>
        resolveHermesBridgeConfig({
          enabled: true,
          sharedSecretEnv: "HERMES_TOKEN",
          allowedTasks: ["status.echo"],
        }),
      env: { HERMES_TOKEN: "secret" },
      resolveIdempotencyStore: () => {
        throw new Error("database path is unavailable");
      },
    });
    const { res } = makeResponse();

    await handler(
      makeRequest({
        headers: { "x-openclaw-hermes-token": "secret" },
        body: {
          requestId: "lazy-store-failure",
          taskId: "status.echo",
          input: { message: "hello" },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: false,
      status: "failed",
      error: {
        type: "idempotency_store_unavailable",
        message: "database path is unavailable",
      },
    });
  });

  it("executes status.health as a dry-run bridge contract probe", async () => {
    await expect(
      invoke({
        token: "secret",
        config: {
          enabled: true,
          sharedSecretEnv: "HERMES_TOKEN",
          allowedTasks: ["status.health"],
          allowedTools: [],
        },
        body: {
          requestId: "health-contract",
          taskId: "status.health",
          intent: "bridge health",
          dryRun: true,
        },
      }),
    ).resolves.toMatchObject({
      statusCode: 200,
      body: {
        ok: true,
        requestId: "health-contract",
        taskId: "status.health",
        status: "succeeded",
        output: {
          status: "ok",
          bridge: "hermes-bridge",
          mode: "mock",
          dryRun: true,
        },
      },
    });
  });

  it("rejects unknown or unallowlisted task IDs", async () => {
    await expect(
      invoke({
        token: "secret",
        body: { taskId: "email.send", input: { body: "no side effects" } },
      }),
    ).resolves.toMatchObject({
      statusCode: 404,
      body: { ok: false, status: "failed", error: { type: "unknown_task" } },
    });
  });

  it("deduplicates requests with the same idempotencyKey", async () => {
    const store = new MemoryHermesBridgeIdempotencyStore();
    const handler = createHermesBridgeHttpHandler({
      resolveConfig: () =>
        resolveHermesBridgeConfig({
          enabled: true,
          sharedSecretEnv: "HERMES_TOKEN",
          allowedTasks: ["status.echo"],
        }),
      env: { HERMES_TOKEN: "secret" },
      idempotencyStore: store,
    });
    for (const message of ["first", "first"]) {
      const { res } = makeResponse();
      await handler(
        makeRequest({
          headers: { "x-openclaw-hermes-token": "secret" },
          body: {
            idempotencyKey: "same-key",
            taskId: "status.echo",
            input: { message },
          },
        }),
        res,
      );
    }

    expect(store.get("same-key")).toMatchObject({
      result: { output: { message: "first" } },
    });
  });

  it("releases the idempotency claim instead of caching cleanup-in-progress", async () => {
    const store = new MemoryHermesBridgeIdempotencyStore();
    const executeTask = vi
      .fn()
      .mockImplementationOnce(async ({ request }) =>
        createHermesBridgeResult({
          ok: false,
          request,
          mode: "live",
          status: "running",
          summary: "cleanup pending",
          error: {
            type: "cleanup_in_progress",
            message: "retry after cleanup",
          },
        }),
      )
      .mockImplementationOnce(async ({ request }) =>
        createHermesBridgeResult({
          ok: true,
          request,
          mode: "mock",
          status: "succeeded",
          summary: "retry succeeded",
        }),
      );
    const handler = createHermesBridgeHttpHandler({
      resolveConfig: () =>
        resolveHermesBridgeConfig({
          enabled: true,
          sharedSecretEnv: "HERMES_TOKEN",
          allowedTasks: ["status.echo"],
        }),
      env: { HERMES_TOKEN: "secret" },
      idempotencyStore: store,
      executeTask,
    });
    const body = {
      idempotencyKey: "retryable-cleanup-key",
      taskId: "status.echo",
      input: { message: "same" },
    };
    const first = makeResponse();
    await handler(
      makeRequest({ headers: { "x-openclaw-hermes-token": "secret" }, body }),
      first.res,
    );

    expect(first.res.statusCode).toBe(409);
    expect(JSON.parse(first.res.body)).toMatchObject({
      status: "running",
      error: { type: "cleanup_in_progress" },
    });
    expect(store.get("retryable-cleanup-key")).toBeUndefined();

    const conflicting = makeResponse();
    await handler(
      makeRequest({
        headers: { "x-openclaw-hermes-token": "secret" },
        body: {
          ...body,
          input: { message: "different" },
        },
      }),
      conflicting.res,
    );
    expect(conflicting.res.statusCode).toBe(409);
    expect(JSON.parse(conflicting.res.body)).toMatchObject({
      error: { type: "idempotency_conflict" },
    });
    expect(executeTask).toHaveBeenCalledOnce();

    const second = makeResponse();
    await handler(
      makeRequest({ headers: { "x-openclaw-hermes-token": "secret" }, body }),
      second.res,
    );
    expect(second.res.statusCode).toBe(200);
    expect(executeTask).toHaveBeenCalledTimes(2);
    expect(store.get("retryable-cleanup-key")).toMatchObject({
      result: { status: "succeeded" },
    });
  });

  it("rejects reuse of an idempotency key for a different request", async () => {
    const store = new MemoryHermesBridgeIdempotencyStore();
    const handler = createHermesBridgeHttpHandler({
      resolveConfig: () =>
        resolveHermesBridgeConfig({
          enabled: true,
          sharedSecretEnv: "HERMES_TOKEN",
          allowedTasks: ["status.echo"],
        }),
      env: { HERMES_TOKEN: "secret" },
      idempotencyStore: store,
    });
    for (const message of ["first", "different"]) {
      const { res } = makeResponse();
      await handler(
        makeRequest({
          headers: { "x-openclaw-hermes-token": "secret" },
          body: {
            idempotencyKey: "conflicting-key",
            taskId: "status.echo",
            input: { message },
          },
        }),
        res,
      );
      if (message === "different") {
        expect(res.statusCode).toBe(409);
        expect(JSON.parse(res.body)).toMatchObject({
          error: { type: "idempotency_conflict" },
        });
      }
    }
  });

  it("coalesces concurrent requests with the same idempotency key", async () => {
    let releaseExecution: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const executeTask = vi.fn(async ({ request }) => {
      await gate;
      return createHermesBridgeResult({
        ok: true,
        request,
        mode: "mock",
        status: "succeeded",
        summary: "executed once",
        output: { message: "first" },
      });
    });
    const handler = createHermesBridgeHttpHandler({
      resolveConfig: () =>
        resolveHermesBridgeConfig({
          enabled: true,
          sharedSecretEnv: "HERMES_TOKEN",
          allowedTasks: ["status.echo"],
        }),
      env: { HERMES_TOKEN: "secret" },
      idempotencyStore: new MemoryHermesBridgeIdempotencyStore(),
      executeTask,
    });
    const first = makeResponse();
    const second = makeResponse();
    const body = {
      idempotencyKey: "concurrent-key",
      taskId: "status.echo",
      input: { message: "first" },
    };
    const firstCall = handler(
      makeRequest({ headers: { "x-openclaw-hermes-token": "secret" }, body }),
      first.res,
    );
    await vi.waitFor(() => expect(executeTask).toHaveBeenCalledOnce());
    const secondCall = handler(
      makeRequest({ headers: { "x-openclaw-hermes-token": "secret" }, body }),
      second.res,
    );
    releaseExecution?.();
    await Promise.all([firstCall, secondCall]);

    expect(executeTask).toHaveBeenCalledOnce();
    expect(JSON.parse(first.res.body)).toMatchObject({ output: { message: "first" } });
    expect(JSON.parse(second.res.body)).toMatchObject({ output: { message: "first" } });
  });

  it("returns the same persistence failure to every coalesced caller", async () => {
    let releaseExecution: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const store = new MemoryHermesBridgeIdempotencyStore();
    const claim = vi.spyOn(store, "claim");
    vi.spyOn(store, "set").mockImplementation(() => {
      throw new Error("disk unavailable");
    });
    const executeTask = vi.fn(async ({ request }) => {
      await gate;
      return createHermesBridgeResult({
        ok: true,
        request,
        mode: "mock",
        status: "succeeded",
        summary: "execution finished",
      });
    });
    const handler = createHermesBridgeHttpHandler({
      resolveConfig: () =>
        resolveHermesBridgeConfig({
          enabled: true,
          sharedSecretEnv: "HERMES_TOKEN",
          allowedTasks: ["status.echo"],
        }),
      env: { HERMES_TOKEN: "secret" },
      idempotencyStore: store,
      executeTask,
    });
    const first = makeResponse();
    const second = makeResponse();
    const body = {
      idempotencyKey: "persistence-failure-key",
      taskId: "status.echo",
      input: { message: "same" },
    };
    const firstCall = handler(
      makeRequest({ headers: { "x-openclaw-hermes-token": "secret" }, body }),
      first.res,
    );
    await vi.waitFor(() => expect(executeTask).toHaveBeenCalledOnce());
    const secondCall = handler(
      makeRequest({ headers: { "x-openclaw-hermes-token": "secret" }, body }),
      second.res,
    );
    await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(2));
    releaseExecution?.();
    await Promise.all([firstCall, secondCall]);

    for (const response of [first.res, second.res]) {
      expect(response.statusCode).toBe(503);
      expect(JSON.parse(response.body)).toMatchObject({
        error: { type: "idempotency_persistence_failed" },
      });
    }
    expect(executeTask).toHaveBeenCalledOnce();

    const third = makeResponse();
    await handler(
      makeRequest({
        headers: { "x-openclaw-hermes-token": "secret" },
        body,
      }),
      third.res,
    );
    expect(third.res.statusCode).toBe(409);
    expect(JSON.parse(third.res.body)).toMatchObject({
      error: { type: "idempotency_in_progress" },
    });
    expect(executeTask).toHaveBeenCalledOnce();
  });

  it("replays an async terminal tombstone after poll result persistence fails", async () => {
    const store = new MemoryHermesBridgeIdempotencyStore();
    const subagent = {
      run: vi.fn().mockResolvedValue({ runId: "terminal-replay-run" }),
      waitForRun: vi.fn().mockResolvedValue({ status: "ok", terminal: true }),
      getSessionMessages: vi.fn().mockResolvedValue({
        messages: [
          {
            role: "assistant",
            content: '{"result":"zero-effect async completed","sideEffectsPerformed":false}',
          },
        ],
      }),
      getSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    } satisfies PluginRuntime["subagent"];
    const handler = createHermesBridgeHttpHandler({
      resolveConfig: () =>
        resolveHermesBridgeConfig({
          enabled: true,
          mode: "live",
          hermesMode: "real",
          sharedSecretEnv: "HERMES_TOKEN",
          allowedTasks: [
            "openclaw.agent.zero_effect_async_start",
            "openclaw.agent.zero_effect_async_poll",
          ],
          allowedTools: [],
        }),
      env: { HERMES_TOKEN: "secret" },
      idempotencyStore: store,
      subagent,
    });
    const identity = {
      delegationId: "terminal-replay-delegation",
      attemptId: "terminal-replay-attempt",
      contractFingerprint: "sha256:terminal-replay",
      project: "hub_ops",
      topicId: "zero-effect-async",
    };
    const base = {
      protocolVersion: "2.0",
      dryRun: false,
      allowedTools: [],
      identity,
      routing: {
        executorBackend: "openclaw",
        executorProfile: "zero-effect-async",
        backendAgentId: "missioncrew-browser-readonly",
      },
      policy: {
        externalEffectBudget: 0,
        workspacePolicy: "dedicated",
        sessionPolicy: "ephemeral",
        credentialRefs: [],
      },
    };
    const call = async (body: Record<string, unknown>) => {
      const { res } = makeResponse();
      await handler(
        makeRequest({
          headers: { "x-openclaw-hermes-token": "secret" },
          body,
        }),
        res,
      );
      return { statusCode: res.statusCode, body: JSON.parse(res.body) };
    };

    await expect(
      call({
        ...base,
        taskId: "openclaw.agent.zero_effect_async_start",
        idempotencyKey: "terminal-replay-start",
        input: {},
      }),
    ).resolves.toMatchObject({
      statusCode: 200,
      body: { status: "accepted", backendExecution: { backendRunId: "terminal-replay-run" } },
    });

    vi.spyOn(store, "set").mockImplementationOnce(() => {
      throw new Error("injected terminal result persistence failure");
    });
    const pollBody = {
      ...base,
      taskId: "openclaw.agent.zero_effect_async_poll",
      idempotencyKey: "terminal-replay-poll",
      input: {
        startIdempotencyKey: "terminal-replay-start",
        backendRunId: "terminal-replay-run",
      },
    };
    await expect(call(pollBody)).resolves.toMatchObject({
      statusCode: 503,
      body: {
        status: "failed",
        error: { type: "idempotency_persistence_failed" },
      },
    });
    expect(store.getCleanup("terminal-replay-start")).toBeUndefined();
    expect(store.getCleanupTerminal("terminal-replay-start")).toMatchObject({
      backendRunId: "terminal-replay-run",
      output: { bridgeStatus: "succeeded", evidence: { terminal: true } },
    });

    await expect(call(pollBody)).resolves.toMatchObject({
      statusCode: 200,
      body: {
        status: "succeeded",
        backendExecution: { backendRunId: "terminal-replay-run" },
        output: { evidence: { terminal: true, sessionCleaned: true } },
      },
    });
    expect(subagent.waitForRun).toHaveBeenCalledOnce();
    expect(subagent.deleteSession).toHaveBeenCalledOnce();
  });

  it("releases a browser start claim after its terminal result persistence fails", async () => {
    const store = new MemoryHermesBridgeIdempotencyStore();
    const executeTask = vi.fn(async ({ request }) => {
      const requestHash = hashHermesBridgeRequest(request);
      if (!store.getCleanupTerminal(request.idempotencyKey)) {
        const generation = "browser-start-terminal-generation";
        store.registerCleanup({
          idempotencyKey: request.idempotencyKey,
          requestHash,
          generation,
          backendRunId: "browser-start-terminal-run",
          request,
          dueAt: 1,
        });
        expect(
          store.claimCleanup(request.idempotencyKey, requestHash, generation, {
            ownerId: "browser-start-terminal-owner",
            leaseMs: 30_000,
          }),
        ).toBe(true);
        store.completeCleanup(
          request.idempotencyKey,
          requestHash,
          generation,
          "browser-start-terminal-owner",
          {
            idempotencyKey: request.idempotencyKey,
            requestHash,
            generation,
            backendRunId: "browser-start-terminal-run",
            request,
            output: {
              bridgeStatus: "succeeded",
              evidence: { terminal: true, sessionCleaned: true },
            },
            completedAt: 2,
          },
        );
      }
      return createHermesBridgeResult({
        ok: true,
        request,
        mode: "live",
        status: "succeeded",
        summary: "browser snapshot completed",
      });
    });
    const handler = createHermesBridgeHttpHandler({
      resolveConfig: () =>
        resolveHermesBridgeConfig({
          enabled: true,
          mode: "live",
          hermesMode: "real",
          sharedSecretEnv: "HERMES_TOKEN",
          allowedTasks: ["openclaw.browser.read_snapshot"],
          allowedTools: ["browser.read"],
        }),
      env: { HERMES_TOKEN: "secret" },
      idempotencyStore: store,
      executeTask,
    });
    const body = {
      protocolVersion: "2.0",
      taskId: "openclaw.browser.read_snapshot",
      idempotencyKey: "browser-start-terminal-key",
      dryRun: false,
      allowedTools: ["browser.read"],
      identity: {
        delegationId: "browser-start-terminal-delegation",
        attemptId: "browser-start-terminal-attempt",
        contractFingerprint: "sha256:browser-start-terminal",
        project: "hub_ops",
        topicId: "browser-start-terminal",
      },
      routing: {
        executorBackend: "openclaw",
        executorProfile: "browser-readonly",
        backendAgentId: "missioncrew-browser-readonly",
      },
      policy: {
        externalEffectBudget: 0,
        workspacePolicy: "dedicated",
        sessionPolicy: "ephemeral",
        credentialRefs: [],
      },
      input: { url: "https://example.com" },
    };
    const call = async () => {
      const { res } = makeResponse();
      await handler(
        makeRequest({
          headers: { "x-openclaw-hermes-token": "secret" },
          body,
        }),
        res,
      );
      return { statusCode: res.statusCode, body: JSON.parse(res.body) };
    };

    vi.spyOn(store, "set").mockImplementationOnce(() => {
      throw new Error("injected browser start persistence failure");
    });
    await expect(call()).resolves.toMatchObject({
      statusCode: 503,
      body: { error: { type: "idempotency_persistence_failed" } },
    });
    await expect(call()).resolves.toMatchObject({
      statusCode: 200,
      body: { status: "succeeded" },
    });
    expect(executeTask).toHaveBeenCalledTimes(2);
  });

  it("returns 503 and releases the claim for a transient cleanup-store failure", async () => {
    const store = new MemoryHermesBridgeIdempotencyStore();
    const executeTask = vi
      .fn()
      .mockImplementationOnce(async ({ request }) =>
        createHermesBridgeResult({
          ok: false,
          request,
          mode: "live",
          status: "running",
          summary: "cleanup store unavailable",
          error: {
            type: "cleanup_store_unavailable",
            message: "database is busy",
          },
        }),
      )
      .mockImplementationOnce(async ({ request }) =>
        createHermesBridgeResult({
          ok: true,
          request,
          mode: "live",
          status: "succeeded",
          summary: "retry succeeded",
        }),
      );
    const handler = createHermesBridgeHttpHandler({
      resolveConfig: () =>
        resolveHermesBridgeConfig({
          enabled: true,
          sharedSecretEnv: "HERMES_TOKEN",
          allowedTasks: ["status.echo"],
        }),
      env: { HERMES_TOKEN: "secret" },
      idempotencyStore: store,
      executeTask,
    });
    const body = {
      idempotencyKey: "retryable-cleanup-store-key",
      taskId: "status.echo",
      input: { message: "same" },
    };

    const first = makeResponse();
    await handler(
      makeRequest({ headers: { "x-openclaw-hermes-token": "secret" }, body }),
      first.res,
    );
    expect(first.res.statusCode).toBe(503);
    expect(JSON.parse(first.res.body)).toMatchObject({
      status: "running",
      error: { type: "cleanup_store_unavailable" },
    });
    expect(store.get(body.idempotencyKey)).toBeUndefined();

    const retry = makeResponse();
    await handler(
      makeRequest({ headers: { "x-openclaw-hermes-token": "secret" }, body }),
      retry.res,
    );
    expect(retry.res.statusCode).toBe(200);
    expect(JSON.parse(retry.res.body)).toMatchObject({
      ok: true,
      status: "succeeded",
    });
    expect(executeTask).toHaveBeenCalledTimes(2);
  });

  it("returns a structured error when the idempotency store is busy", async () => {
    const store = new MemoryHermesBridgeIdempotencyStore();
    vi.spyOn(store, "claim").mockImplementation(() => {
      throw new Error("SQLITE_BUSY");
    });
    const handler = createHermesBridgeHttpHandler({
      resolveConfig: () =>
        resolveHermesBridgeConfig({
          enabled: true,
          sharedSecretEnv: "HERMES_TOKEN",
          allowedTasks: ["status.echo"],
        }),
      env: { HERMES_TOKEN: "secret" },
      idempotencyStore: store,
    });
    const { res } = makeResponse();
    await handler(
      makeRequest({
        headers: { "x-openclaw-hermes-token": "secret" },
        body: {
          idempotencyKey: "busy-key",
          taskId: "status.echo",
          input: { message: "same" },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({
      error: { type: "idempotency_store_unavailable" },
    });
  });

  it("preserves the initial HTTP status when replaying a cached failure", async () => {
    const executeTask = vi.fn(async ({ request }) =>
      createHermesBridgeResult({
        ok: false,
        request,
        mode: "mock",
        status: "failed",
        summary: "failed once",
        error: { type: "task_execution_failed", message: "failed once" },
      }),
    );
    const handler = createHermesBridgeHttpHandler({
      resolveConfig: () =>
        resolveHermesBridgeConfig({
          enabled: true,
          sharedSecretEnv: "HERMES_TOKEN",
          allowedTasks: ["status.echo"],
        }),
      env: { HERMES_TOKEN: "secret" },
      idempotencyStore: new MemoryHermesBridgeIdempotencyStore(),
      executeTask,
    });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { res } = makeResponse();
      await handler(
        makeRequest({
          headers: { "x-openclaw-hermes-token": "secret" },
          body: {
            idempotencyKey: "failed-key",
            taskId: "status.echo",
            input: { message: "same" },
          },
        }),
        res,
      );
      statuses.push(res.statusCode);
    }

    expect(statuses).toEqual([404, 404]);
    expect(executeTask).toHaveBeenCalledOnce();
  });

  it("does not silently run mock-only tasks as real non-dry-run work", async () => {
    await expect(
      invoke({
        token: "secret",
        config: {
          enabled: true,
          mode: "live",
          hermesMode: "real",
          sharedSecretEnv: "HERMES_TOKEN",
          allowedTasks: ["status.echo"],
          allowedTools: [],
        },
        body: {
          taskId: "status.echo",
          dryRun: false,
          input: { message: "real please" },
        },
      }),
    ).resolves.toMatchObject({
      statusCode: 404,
      body: {
        ok: false,
        status: "blocked",
        error: { type: "real_task_unavailable" },
      },
    });
  });

  it("rejects dryRun=false before any route task can run live", async () => {
    await expect(
      invoke({
        token: "secret",
        config: {
          enabled: true,
          mode: "mock",
          hermesMode: "mock",
          sharedSecretEnv: "HERMES_TOKEN",
          allowedTasks: ["status.echo"],
          allowedTools: [],
        },
        body: {
          taskId: "status.echo",
          dryRun: false,
          input: { message: "live disabled" },
        },
      }),
    ).resolves.toMatchObject({
      statusCode: 404,
      body: {
        ok: false,
        status: "blocked",
        error: { type: "dry_run_required" },
      },
    });
  });

  it("accepts the MVP Hermes dry-run task organizer request", async () => {
    await expect(
      invoke({
        token: "secret",
        config: {
          enabled: true,
          sharedSecretEnv: "HERMES_TOKEN",
          allowedTasks: ["tasks.organize_today"],
          allowedTools: [],
        },
        body: {
          requestId: "mvp-acceptance",
          taskId: "tasks.organize_today",
          intent: "請 OpenClaw 幫我整理今天的任務，但只做 dry-run。",
          allowedTools: [],
          dryRun: true,
          input: {
            request: "請 OpenClaw 幫我整理今天的任務，但只做 dry-run。",
          },
        },
      }),
    ).resolves.toMatchObject({
      statusCode: 200,
      body: {
        status: "succeeded",
        summary: "Dry-run completed. No external side effects were performed.",
        output: {
          dryRun: true,
          sideEffectsPerformed: false,
        },
      },
    });
  });

  it("accepts a dry-run OpenClaw agent team delegation request", async () => {
    await expect(
      invoke({
        token: "secret",
        config: {
          enabled: true,
          sharedSecretEnv: "HERMES_TOKEN",
          allowedTasks: ["agents.ask_team"],
          allowedTools: [],
        },
        body: {
          requestId: "team-dry-run",
          taskId: "agents.ask_team",
          intent: "請 OpenClaw agent 團隊協助分析目前 Hermes bridge 狀態，但只做 dry-run。",
          allowedTools: [],
          dryRun: true,
          input: {
            team: "openclaw",
            question: "為何 Hermes 還無法呼叫 OpenClaw agent 團隊？",
          },
        },
      }),
    ).resolves.toMatchObject({
      statusCode: 200,
      body: {
        status: "succeeded",
        summary: "Dry-run completed. No OpenClaw agents were started.",
        output: {
          team: "openclaw",
          dryRun: true,
          agentsStarted: false,
          sideEffectsPerformed: false,
        },
      },
    });
  });
});
