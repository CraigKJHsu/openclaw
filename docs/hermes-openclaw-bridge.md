---
title: Hermes OpenClaw Bridge
summary: Safe local bridge where Hermes plans and OpenClaw executes approved task templates.
read_when:
  - Integrating Hermes Agent with OpenClaw locally
  - Running the Hermes bridge mock demo or read-only live pilot
  - Reviewing bridge trust boundaries, setup, and limitations
---

# Hermes OpenClaw Bridge

This integration keeps Hermes Agent and OpenClaw in separate runtimes. Hermes is the persistent personal assistant layer: planner, memory owner, scheduler, preference store, and delegator. OpenClaw is the gateway and execution layer: channel routing, authentication, tool policy, plugins, task execution, and status reporting.

The first implementation is the bundled OpenClaw plugin `hermes-bridge` under `extensions/hermes-bridge`. It uses OpenClaw's native plugin SDK because that is the least invasive safe integration point. The plugin SDK already provides a Gateway-authenticated HTTP route and optional agent tool registration, so the bridge does not need core gateway protocol changes, WebSocket changes, raw `/tools/invoke`, or a CLI wrapper.

The real Hermes Agent repository is cloned locally for this integration. Mock Hermes clients remain only for automated tests and offline demos; they are not the completion state for the real integration.

## Real Hermes Checkout

Required local checkout:

- Path: `../hermes-agent`
- Remote: `https://github.com/NousResearch/hermes-agent.git`
- Commit: `745c4db235bdb09beb19564f66727dc1f43e4fe2`

Preflight and clone commands:

```bash
git --version
GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/NousResearch/hermes-agent.git HEAD
git clone https://github.com/NousResearch/hermes-agent.git ../hermes-agent
git -C ../hermes-agent rev-parse HEAD
git -C ../hermes-agent remote -v
```

If `../hermes-agent` already exists, do not overwrite it. It must be a git worktree whose `origin` remote is the official NousResearch repo above. If the directory exists but is not a git repo, or the remote differs, stop and report `BLOCKED`.

## Data Flow

1. Hermes builds a structured task request. Mock templates may use the original
   request fields. Live execution additionally requires Delegated Execution
   Protocol `2.0` identity, routing, policy, workspace, session, backend-agent,
   and idempotency fields.
2. Hermes sends the request to OpenClaw's plugin route:

   ```http
   POST /api/plugins/hermes-bridge/tasks
   Authorization: Bearer <gateway-token>
   x-openclaw-hermes-token: <bridge-token>
   Content-Type: application/json
   ```

3. OpenClaw verifies normal Gateway auth before the route runs.
4. The plugin verifies the Hermes bridge token from `OPENCLAW_HERMES_BRIDGE_TOKEN`.
5. The plugin validates the request schema, task allowlist, required tool allowlist, confirmation flag, and dry-run/mock execution mode.
6. The plugin executes only a declared task template and returns a structured
   result. Existing task templates remain mock-safe dry-run templates. Live
   execution is limited to the fixed zero-effect browser pilot and the
   zero-tool asynchronous start/poll pair.

## Trust Boundaries

Gateway auth and the Hermes bridge token are separate controls. Do not reuse the same token for both.

Hermes may request only task template IDs, not arbitrary OpenClaw tool names. OpenClaw decides which template IDs are enabled through `allowedTasks`, and which underlying tool capabilities a template may use through `allowedTools`.

The bridge does not expose arbitrary Gateway methods, tool names, URLs, or
agent identities. Non-dry-run requests for mock-only templates fail closed with
`real_task_unavailable` instead of silently falling back to mock execution.

The one live template, `openclaw.browser.read_snapshot`, has a fixed
zero-effect contract:

- Protocol version must be `2.0`.
- `executorBackend` must be `openclaw`.
- `executorProfile` must be `browser-readonly`.
- `backendAgentId` must be `missioncrew-browser-readonly`.
- `workspacePolicy` must be `dedicated`; `sessionPolicy` must be `ephemeral`.
- `externalEffectBudget` must be `0`; `credentialRefs` must be empty.
- `idempotencyKey` must exactly equal `identity.attemptId`; the complete
  delegation, attempt, project, topic, contract fingerprint, and idempotency
  identity is included in the collision-resistant session key.
- The only allowed capability is `browser.read`.
- Click, type, upload, send, shell, and filesystem-write capabilities must be
  denied by the caller.
- The pilot URL must normalize to exactly `https://example.com/`. Arbitrary
  public URLs, redirects to another URL, localhost, private-network hosts,
  embedded credentials, and unsupported schemes all fail closed.

The backend-agent config field is enum-locked to
`missioncrew-browser-readonly`; alternative agent IDs are not a supported pilot
configuration. Before opening a tab, the Gateway-authenticated route reads the effective
OpenClaw configuration and attests that the fixed backend agent has only the
no-effect `session_status` baseline allowlist plus the required denylist. The
actual reviewer start carries both the authoritative per-run `toolsAllow: []`
override and `disableTools: true`; the embedded and CLI runtimes therefore
construct no tool surface for that run. It also requires the dedicated
managed `hermes-readonly` browser profile and pins that profile on every list,
open, snapshot, and delete request. It then performs only fixed `tabs/open`,
`snapshot`, and exact-target tab-close browser requests.
The already-captured snapshot is passed to that dedicated OpenClaw agent for
zero-effect evidence review. Snapshot text is treated as untrusted data; the
agent cannot browse, execute commands, send messages, or write files. Its final
JSON must preserve the captured URL, title, snapshot excerpt, and
`sideEffectsPerformed=false`; the snapshot response must explicitly attest its
current URL and the exact opened target ID, and empty, missing-URL, redirected,
cross-tab, or mismatched output fails closed. A generation-scoped correlation
label lets cleanup reconcile a tab even if the open response times out after
creating it. The generation-scoped ephemeral session key is deleted after every
subagent start attempt, including ambiguous
start failures.

Successful results include backend run, agent, and session identity plus
structured evidence showing the requested URL, snapshot size,
`externalEffectBudget: 0`, and `sideEffectsPerformed: false`.
They also echo the delegation ID, attempt ID, and Loop Contract fingerprint.
Hermes must match all three, set `identity_correlated=true`, and require that
flag before binding the backend run.

The Package 3 asynchronous pair has a separate fixed contract:

- `openclaw.agent.zero_effect_async_start` admits the exact zero-tool run and
  returns `accepted` with backend run, agent, and session identity.
- `openclaw.agent.zero_effect_async_poll` accepts only the original start
  idempotency key and exact backend run ID, with the same delegation, attempt,
  project, topic, and contract fingerprint.
- Both templates require Protocol v2, `executorProfile=zero-effect-async`,
  the fixed backend agent, a dedicated ephemeral session, no credentials,
  `allowedTools=[]`, `disableTools=true`, and external-effect budget zero.
- A nonterminal poll returns `running`. A terminal success requires a
  tool-free transcript containing the fixed acceptance JSON, then deletes the
  ephemeral session before returning structured evidence.
- The durable cleanup sweeper can resubmit the saved admission request under
  its original backend admission key, prove the exact run is terminal, and
  delete an abandoned session without starting a second logical run.

Before execution, the bridge atomically reserves the idempotency key with an
owner and bounded lease in SQLite. Same-process duplicates share the in-flight
execution-and-persistence result. SQLite waits briefly for a busy writer and
returns a structured service-unavailable result if the store cannot be claimed.
Other Gateway processes receive `idempotency_in_progress`. If result persistence
fails, every already-coalesced caller receives the same
`idempotency_persistence_failed` response. If a Gateway stops before persisting
the result, the same request hash can recover the expired lease; a different
request hash remains a permanent conflict even after a claim or cleanup row is
released. A recovered claim is propagated into the
executor. Before retrying, the live template reconciles every tab with its
deterministic correlation label and deletes the deterministic ephemeral
session. This recovery is safe for the only live template because its
external-effect budget is zero.

The live executor has one end-to-end deadline covering agent-policy
attestation, tab creation, snapshot, reviewer execution, transcript read, and
resource cleanup. Ambiguous tab and subagent-start failures trigger bounded
reconciliation polls within that deadline. The reviewer transcript must contain
zero tool calls or tool results, and the final JSON object must contain exactly
`url`, `title`, `snapshotExcerpt`, and `sideEffectsPerformed`.
Live runtime configuration is bounded to 1–3,600 seconds. Cleanup receives its
own bounded 10–30 second reconciliation window so even a one-second execution
limit cannot make durable cleanup impossible.

The idempotency directory is created owner-only and the database, WAL, and SHM
files are forced to owner read/write permissions before SQLite opens because
cached task outputs can contain private Hermes data. An existing directory must
already be owned by the Gateway user with mode `0700`, or initialization fails.

As of the 2026-07-04 Hermes/ClawOps routing update, real external browser work such as Facebook listing continuation is not a Hermes bridge responsibility. That work is routed through the Hermes-owned ClawOps Kanban path:

```text
/clawops <objective>
  -> HubOps routing-rules.yaml
  -> agent-registry.yaml
  -> logical worker: clawops.browser
  -> runtime_profile / Kanban assignee: clawops-browser
```

The conversational `/openclaw-dry-run` path remains mock-only. The read-only
pilot is invoked by the ClawOps control-plane adapter, not by free-form chat. It
must not be treated as evidence that OpenClaw can click, submit, publish, upload,
send, or perform Facebook-side effects.

## Request Schema

```json
{
  "taskId": "message.preview",
  "requestedBy": "hermes",
  "intent": "Preview a Telegram reply without sending it.",
  "priority": "normal",
  "requiresConfirmation": false,
  "allowedTools": [],
  "input": {
    "channel": "telegram",
    "recipient": "@local-user",
    "body": "hello"
  },
  "dryRun": true,
  "idempotencyKey": "optional-dedup-key"
}
```

## Result Schema

```json
{
  "ok": true,
  "idempotencyKey": "optional-dedup-key",
  "taskId": "message.preview",
  "mode": "mock",
  "status": "succeeded",
  "summary": "Hermes bridge task succeeded: message.preview",
  "artifacts": [],
  "auditLog": [
    {
      "step": "accepted",
      "message": "Accepted Hermes task message.preview.",
      "at": "1970-01-01T00:00:00.000Z"
    }
  ],
  "output": {
    "preview": {
      "channel": "telegram",
      "recipient": "@local-user",
      "body": "hello",
      "wouldSend": false
    }
  }
}
```

## Protocol v2 Live Request

The live pilot is intentionally not a free-form tool request. A representative
request contains:

```json
{
  "protocolVersion": "2.0",
  "taskId": "openclaw.browser.read_snapshot",
  "requestedBy": "hermes",
  "intent": "Read Example Domain and return browser snapshot evidence.",
  "requiresConfirmation": false,
  "allowedTools": ["browser.read"],
  "dryRun": false,
  "idempotencyKey": "t_example:run:1",
  "identity": {
    "delegationId": "grace:t_example",
    "attemptId": "t_example:run:1",
    "contractFingerprint": "sha256-value",
    "project": "hub_ops",
    "topicId": "readonly-browser"
  },
  "routing": {
    "executorBackend": "openclaw",
    "executorProfile": "browser-readonly",
    "backendAgentId": "missioncrew-browser-readonly"
  },
  "policy": {
    "externalEffectBudget": 0,
    "workspacePolicy": "dedicated",
    "sessionPolicy": "ephemeral",
    "credentialRefs": []
  },
  "input": {
    "url": "https://example.com/"
  }
}
```

## V1 Task Templates

- `status.echo`: returns `input.message`.
- `status.health`: returns bridge health metadata.
- `message.preview`: builds a message preview and never sends it.
- `tasks.organize_today`: accepts the MVP Hermes request to organize today's tasks, requires `dryRun: true`, requires no tools, and returns `summary: "Dry-run completed. No external side effects were performed."`
- `agents.ask_team`: accepts a dry-run OpenClaw agent team delegation request, requires `dryRun: true`, requires no tools, does not start live agents, and returns `summary: "Dry-run completed. No OpenClaw agents were started."`
- `message.send`: mock-only future send template. It requires `requiresConfirmation: true` and `telegram.send` in both bridge config `allowedTools` and request `allowedTools`; it still never sends a message in v1.
- `openclaw.browser.read_snapshot`: the sole live template. It opens only
  `https://example.com/`, captures an accessibility snapshot, and delegates
  evidence review to the no-effect-tools `missioncrew-browser-readonly` agent.
  Its policy allows no tools, and the accepted run makes no tool call. It
  performs no click, type, upload, send, or write operation and cleans up its
  tab and ephemeral session.

## Local Configuration

Set environment variables in process env, `.env`, or `~/.openclaw/.env`:

```bash
OPENCLAW_GATEWAY_TOKEN=
OPENCLAW_HERMES_BRIDGE_TOKEN=
HERMES_AGENT_PATH=../hermes-agent
HERMES_MODE=mock
OPENCLAW_GATEWAY_URL=http://127.0.0.1:1455
# HERMES_HOME=~/.hermes
```

Run the real Hermes presence check:

```bash
HERMES_AGENT_PATH=../hermes-agent COREPACK_HOME=/private/tmp/corepack corepack pnpm hermes:agent:check
```

The check reads `HERMES_AGENT_PATH`, verifies the path exists, verifies it is a git repo, verifies the official remote, and prints the commit hash. It performs no sends, no provider calls, no calendar or trading operations, no filesystem mutation, and no secret reads beyond normal environment access.

Enable the plugin explicitly in OpenClaw config:

```json
{
  "plugins": {
    "hermes-bridge": {
      "enabled": true,
      "mode": "mock",
      "hermesMode": "real",
      "hermesAgentPath": "../hermes-agent",
      "sharedSecretEnv": "OPENCLAW_HERMES_BRIDGE_TOKEN",
      "allowedTasks": [
        "status.echo",
        "status.health",
        "message.preview",
        "tasks.organize_today",
        "agents.ask_team",
        "openclaw.browser.read_snapshot",
        "openclaw.agent.zero_effect_async_start",
        "openclaw.agent.zero_effect_async_poll"
      ],
      "allowedTools": ["browser.read"],
      "maxRequestBytes": 65536,
      "idempotencyDbPath": "~/.openclaw/hermes-bridge-idempotency.sqlite",
      "readonlyBrowserAgentId": "missioncrew-browser-readonly",
      "maxLiveRuntimeSeconds": 120
    }
  }
}
```

The same OpenClaw config must also contain the dedicated managed browser
profile and the restricted reviewer agent. Merge these entries into the existing
`browser.profiles` and `agents.list` rather than replacing unrelated profiles:

```json
{
  "browser": {
    "profiles": {
      "hermes-readonly": {
        "driver": "openclaw",
        "color": "#2F6FEB"
      }
    }
  },
  "agents": {
    "list": [
      {
        "id": "missioncrew-browser-readonly",
        "tools": {
          "allow": ["session_status"],
          "deny": [
            "apply_patch",
            "edit",
            "exec",
            "gateway",
            "message",
            "nodes",
            "process",
            "read",
            "write"
          ]
        }
      }
    ]
  }
}
```

The live bridge additionally sends the authoritative per-run
`toolsAllow: []` and `disableTools: true` controls when it starts the evidence
reviewer. OpenClaw forwards both through the plugin runtime and Gateway agent
protocol into embedded and CLI execution. The agent-level `session_status`
allowlist is only a restricted defense-in-depth baseline for unrelated starts.

## Mock Demo

Run the dry-run mock demo from the repo root:

```bash
COREPACK_HOME=/private/tmp/corepack corepack pnpm hermes:bridge:demo
```

The demo uses `createMockHermesClient` and `createMockOpenClawBridge` to show Hermes delegating a `tasks.organize_today` dry-run task and receiving a structured OpenClaw result. It is for tests and offline demos only; it is not a substitute for the real `../hermes-agent` clone and presence check.

## Real Runtime Adapter Status

The Hermes-side adapter is implemented in
`proactive/openclaw_executor.py`. It validates a Loop Contract, creates an
OpenClaw execution task plus a dependent Grace review task, claims the exact
Kanban attempt, emits Protocol v2, binds the backend run to that attempt, and
completes both tasks only after deterministic zero-effect review.

Kanban stores the control-plane identity on both tasks and runs:

- executor backend and profile
- project namespace
- backend run and agent identity
- protocol version
- result digest
- dedicated workspace reference

OpenClaw stores the backend session and persistent idempotency result. Hermes
Kanban remains the authoritative task state; OpenClaw does not become a second
board.

OpenClaw also has Hermes migration docs and a plugin-owned migration provider surface for importing Hermes state into OpenClaw. That is separate from this bridge: migration moves state after preview, while the bridge keeps Hermes and OpenClaw in separate runtimes and lets Hermes delegate approved tasks at runtime.

## Troubleshooting

- `missing_secret`: set `OPENCLAW_HERMES_BRIDGE_TOKEN` in the Gateway environment.
- `invalid_token`: the `x-openclaw-hermes-token` header does not match the configured env var.
- `task_not_allowed`: add the task template ID to `allowedTasks`.
- `tool_not_allowed`: add the template's required tool capability to both config `allowedTools` and request `allowedTools`.
- `confirmation_required`: set `requiresConfirmation: true` only after the operator has explicitly approved the task.
- `real_task_unavailable`: `hermesMode` is `real`, but the selected task has only a mock/dry-run executor. Add a real task adapter with tests before allowing non-dry-run execution.
- `protocol_v2_required`: a live request omitted required Protocol v2 fields.
- `live_policy_mismatch`: a live request did not preserve the fixed
  zero-effect policy.
- `idempotency_conflict`: the same idempotency key was reused for different
  request content. The new request is not executed.
- `idempotency_in_progress`: another Gateway process owns the unexpired claim.
  Retry the identical request to replay its completed result.
- `idempotency_persistence_failed`: execution finished but the durable result
  could not be committed. Do not change the request or key; retry after the
  claim lease expires.
- `BLOCKED`: report this when the mandatory `git --version`, `git ls-remote`, clone, `rev-parse`, remote verification, or presence check fails.

## Smoke Tests

```bash
git -C ../hermes-agent rev-parse HEAD
git -C ../hermes-agent remote -v
HERMES_AGENT_PATH=../hermes-agent COREPACK_HOME=/private/tmp/corepack corepack pnpm hermes:agent:check
COREPACK_HOME=/private/tmp/corepack corepack pnpm hermes:bridge:demo
COREPACK_HOME=/private/tmp/corepack corepack pnpm test extensions/hermes-bridge
COREPACK_HOME=/private/tmp/corepack corepack pnpm exec tsc -p extensions/hermes-bridge/tsconfig.json --noEmit
COREPACK_HOME=/private/tmp/corepack corepack pnpm test test/scripts/check-hermes-agent-presence.test.ts
```

## Progress Log

- 2026-06-22: Added bundled `hermes-bridge` plugin with Gateway-auth route, plugin-local shared secret, typed request/result schema, mock-safe task registry, optional tool, mock Hermes client, dry-run demo script, tests, and setup docs.
- 2026-06-22: Verified `COREPACK_HOME=/private/tmp/corepack corepack pnpm hermes:bridge:demo` passes and prints a `message.preview` dry-run result with `status: "succeeded"` and `wouldSend: false`.
- 2026-06-22: Verified `COREPACK_HOME=/private/tmp/corepack corepack pnpm exec oxfmt --check --threads=1 extensions/hermes-bridge docs/hermes-openclaw-bridge.md docs/tools/hermes-bridge.md package.json .env.example` passes.
- 2026-06-22: Verified direct `node --import tsx` behavior smoke passes for mock delegation, dangerous-task confirmation, and missing shared-secret fail-closed handling.
- 2026-06-22: `COREPACK_HOME=/private/tmp/corepack corepack pnpm test extensions/hermes-bridge` is blocked before project tests run because `scripts/test-projects.test-support.mjs` imports missing local file `test/vitest/vitest.channel-paths.mjs`.
- 2026-06-22: `COREPACK_HOME=/private/tmp/corepack corepack pnpm tsgo:extensions` was attempted with the required heavy-check lock access, produced no diagnostic output for 60 seconds, and was stopped to avoid leaving a broad local gate running.
- 2026-06-22: Targeted repo oxlint wrapper `COREPACK_HOME=/private/tmp/corepack corepack pnpm exec node scripts/run-oxlint.mjs --tsconfig tsconfig.oxlint.extensions.json extensions/hermes-bridge` produced no output for 30 seconds and was stopped; the wrapper then reported `prepare-extension-package-boundary-artifacts failed with exit code 130`.
- 2026-06-22: Restored tracked validation/build support directories that were missing from the worktree (`test/`, `ui/`, and `tsconfig.oxlint.{core,extensions}.json`) so repo-native wrappers could run.
- 2026-06-22: Verified `COREPACK_HOME=/private/tmp/corepack corepack pnpm test extensions/hermes-bridge` passes with 7 test files and 17 tests.
- 2026-06-22: Fixed memory host SDK type drift exposed by extension boundary prep (`mem0`/`hybrid` memory backends and `cli` memory manager purpose), then verified `COREPACK_HOME=/private/tmp/corepack corepack pnpm test packages/memory-host-sdk/src/host/backend-config.test.ts` passes with 23 tests.
- 2026-06-22: Verified `COREPACK_HOME=/private/tmp/corepack corepack pnpm test:extensions:package-boundary:compile -- extensions/hermes-bridge` passes across 108 bundled plugins.
- 2026-06-22: Verified targeted repo oxlint wrapper passes with 0 warnings and 0 errors for `extensions/hermes-bridge`, memory host SDK type files, and `extensions/memory-core/src/memory/search-manager.ts`.
- 2026-06-22: Verified `COREPACK_HOME=/private/tmp/corepack corepack pnpm tsgo:extensions` passes.
- 2026-06-22: `COREPACK_HOME=/private/tmp/corepack corepack pnpm build` progressed through A2UI, tsdown, CLI bootstrap import guard, and into `runtime-postbuild`; the only remaining process was `node scripts/runtime-postbuild.mjs`, which produced no output for more than ten minutes and was stopped to avoid leaving a background build process.
- 2026-06-22: Diagnosed the `runtime-postbuild` stall to bundled runtime dependency staging. `@mariozechner/pi-ai` contained broken package-manager `.bin` symlinks, causing root-workspace staging to fail and fall back to `npm install`; fixed staging to skip broken `.bin` shims and verified `COREPACK_HOME=/private/tmp/corepack corepack pnpm test test/scripts/stage-bundled-plugin-runtime-deps.test.ts` passes with 40 tests.
- 2026-06-22: Continued runtime dependency staging and found the next fallback is `diffs`, where the local dependency tree is inconsistent (`@pierre/theme` installed as `0.0.28` while `extensions/diffs/package.json` requires `0.0.29`). `COREPACK_HOME=/private/tmp/corepack corepack pnpm install` was attempted per missing-deps policy, but install cannot proceed because tracked dependency control files are missing from the worktree: `pnpm-lock.yaml`, `patches/.gitkeep`, `patches/@agentclientprotocol__claude-agent-acp@0.31.0.patch`, and `patches/@whiskeysockets__baileys@7.0.0-rc.9.patch`.
- 2026-06-22: After explicit approval, restored only the four missing dependency control files above, ran `COREPACK_HOME=/private/tmp/corepack corepack pnpm install --no-frozen-lockfile` to add the new `extensions/hermes-bridge` importer to `pnpm-lock.yaml`, and verified `CI=true COREPACK_HOME=/private/tmp/corepack corepack pnpm install --frozen-lockfile` exits 0.
- 2026-06-22: Hardened bundled runtime dependency fallback installs so npm runs with `--workspaces=false`, `npm_config_workspaces=false`, and `SIGKILL` timeout behavior; this prevents plugin-owned temp installs under `dist/extensions/*` from inheriting the repo workspace. Verified `COREPACK_HOME=/private/tmp/corepack corepack pnpm test test/scripts/stage-bundled-plugin-runtime-deps.test.ts` passes with 41 tests.
- 2026-06-22: Verified current Hermes bridge validation: `COREPACK_HOME=/private/tmp/corepack corepack pnpm test extensions/hermes-bridge` passes with 7 files and 17 tests; `COREPACK_HOME=/private/tmp/corepack corepack pnpm hermes:bridge:demo` exits 0 and returns a `message.preview` mock result with `wouldSend: false`; targeted `oxfmt` check passes for bridge, docs, config, package, and staging files; `COREPACK_HOME=/private/tmp/corepack corepack pnpm tsgo:extensions` exits 0; targeted oxlint exits 0 with 0 warnings and 0 errors.
- 2026-06-22: Verified broad checks available locally: `COREPACK_HOME=/private/tmp/corepack corepack pnpm build` exits 0, including `runtime-postbuild`; `COREPACK_HOME=/private/tmp/corepack corepack pnpm lint:extensions` exits 0 across 5414 files. Blacksmith Testbox is unavailable in PATH, so the fallback `PATH=$PWD/.tmp-bin:$PATH COREPACK_HOME=/private/tmp/corepack corepack pnpm check:changed` was run; it selected all lanes due unrelated existing worktree changes and failed only because pre-existing deletion of `CHANGELOG.md` makes `check:changelog-attributions` fail with `ENOENT`.
- 2026-06-22: Verified `COREPACK_HOME=/private/tmp/corepack corepack pnpm test:extensions:package-boundary:compile -- extensions/hermes-bridge` exits 0; `hermes-bridge` is included in the 108 compiled bundled plugin boundary checks.
- 2026-07-27: Added Delegated Execution Protocol v2, persistent SQLite
  idempotency, explicit live-task fail-closed policy, fixed browser Gateway
  dispatch, a no-effect-tools evidence-review agent, Kanban backend-run
  binding, and dependent Grace policy review.
- 2026-07-27: Initial live acceptance passed for execution task `t_634ffd25`,
  review task `t_befe5745`, Kanban run `342`, backend agent
  `missioncrew-browser-readonly`, and Example Domain snapshot evidence with
  `externalEffectBudget=0` and `sideEffectsPerformed=false`.
- 2026-07-27: Replayed the same request before and after Gateway restart; both
  returned the original backend run without creating another session. Reusing
  the key with altered content failed closed.
- 2026-07-27: Hardened the pilot after structured review: fixed the target to
  exactly `https://example.com/`, made all Protocol v2 routing and policy fields
  strict, added collision-resistant session identity, atomically reserved
  idempotency keys before execution, and cleaned up tabs and ephemeral sessions.
- 2026-07-27: Hardened live acceptance passed for execution task `t_091a4cce`,
  review task `t_0dc599f3`, Kanban run `344`, and result digest
  `71b8ff7700ca9084f848ae4e6639b910f4312fa9c1fa0b8ebc7c042271ea7b58`.
  Browser tabs were empty before and after execution, the new session was absent
  from the active registry, the pending claim was cleared, and replay across a
  Gateway restart returned the original backend run.
- 2026-07-27: Added claim ownership and expiry recovery, exact
  attempt/idempotency binding, stable failure replay status, and rejection of
  unsupported protocol versions. Hermes review now blocks explicit human-review
  requests and missing/malformed snapshots, binds failed backend attempts for
  audit, compares all immutable binding fields, and resumes incomplete Grace
  reviews before reporting deduplicated success.
- 2026-07-27: Final live acceptance passed for execution task `t_26b36075`,
  review task `t_729c8ec4`, Kanban run `346`, and result digest
  `35b150b9700a93dba62348186a4052684761e2854f481ca4d2f2ec2ed8a360c2`.
  Run metadata records `snapshot_validated=true`, 260 snapshot characters, URL
  equality, zero effects, and both result digests; the claim table was empty,
  the new session was inactive, and Browser reported no tabs afterward.
- 2026-07-27: Final blocker hardening now attests the effective zero-effect
  backend-agent policy before browsing, validates reviewer JSON against the
  captured snapshot, shares persistence failures across coalesced callers,
  waits on SQLite writer contention, and returns structured idempotency-store
  failures. Hermes additionally requires the Loop Contract to allow the exact
  URL, scopes deduplication by project and contract fingerprint, blocks
  delegation exceptions and duplicate backend-run identities without leaving
  attempts running, and rejects missing or downgraded Protocol v2 responses.
- 2026-07-27: Post-hardening live acceptance passed for execution task
  `t_c90a5f55`, review task `t_0c1729a7`, Kanban run `348`, and result digest
  `bba4c9fbb84eece514342a1c2c1f96e9a89e6ba1a61167ca9f6e7ba3ad0530b2`.
  The accepted trajectory recorded `toolCount: 0`; the snapshot contained 260
  characters; Browser reported no tabs after completion; the session was
  removed from the active registry; and the claim table was empty. After
  another Gateway restart, a direct replay returned the same backend run in
  0.148 seconds without increasing the session-file count.
- 2026-07-27: Final review seal restricted SQLite state files to owner-only
  access, required an explicit snapshot current URL, added deterministic
  reconciliation for ambiguous tab/session creation failures, enum-locked the
  fixed reviewer-agent ID, and enforced integer request/runtime limits.
- 2026-07-27: Protocol v2 results now echo delegation, attempt, and contract
  fingerprint identity so Hermes can reject stale or cross-request responses
  before binding. Contradictory `ok=false` success responses fail closed, and
  the published task/result schemas conditionally require v2 identity and
  successful backend evidence.
- 2026-07-27: Correlation-sealed live acceptance passed for execution task
  `t_f865843c`, review task `t_9bb97303`, Kanban run and backend run
  `t_f865843c:run:352`, and result digest
  `5308a5fcd5e0018f31a4da63fab289986677acbd62b24162866054b4982a86d4`.
  The result echoed the exact delegation, attempt, and Contract fingerprint
  with `identity_correlated=true`;
  its trajectory recorded zero available/called tools, Browser reported no
  tabs, and the session was absent from the active registry. The preceding
  identity-echo run was durably replayed after Gateway restart in 0.154 seconds
  without adding a session file.
- 2026-06-22: Cloned and verified real Hermes Agent at `../hermes-agent`, remote `https://github.com/NousResearch/hermes-agent.git`, commit `745c4db235bdb09beb19564f66727dc1f43e4fe2`.

## Known Limitations

- Live non-dry-run tasks are limited to the fixed zero-effect Example Domain
  snapshot and the zero-tool asynchronous acceptance pair. Telegram sends,
  browser clicks, form submission, upload, publishing, and other external
  effects remain unavailable through this bridge.
- The dedicated evidence-review agent is isolated by effective OpenClaw tool
  policy and ephemeral session cleanup, but this package is not an OS-level
  sandbox.
- Persistent idempotency coordinates Gateway processes through one local SQLite
  database. It is not a distributed database or cross-host lease service.
- The reviewer validator now requires the exact four-key result, an
  authoritative empty per-run tool allowlist, and a complete transcript below
  the 1,000-message audit cap. Reaching that cap fails closed.
- Ambiguous creations leave a durable SQLite cleanup obligation. A bounded
  background sweeper waits past the execution/lease window, claims the exact
  generation, repeatedly reconciles its tab and session, confirms the tab is
  absent, resubmits the persisted zero-tool reviewer request with the same
  admission idempotency key, separately persists the run ID actually returned,
  retains the obligation until that exact run is proven terminal, and deletes
  the ephemeral session again after terminal proof. Legacy cleanup rows without
  an authoritative saved
  submission are moved to an operator-inspectable quarantine table instead of
  being misclassified or silently discarded.
- Cleanup-store availability failures return retryable HTTP 503 responses and
  release the request claim; they are never cached as terminal task failures.
- General backend selection, circuit state, cost tier, semantic fallback,
  leased polling, and Shadow Mode evidence are implemented in the Hermes
  control plane. Package 3 source and automated tests are complete; a fresh
  live Gateway acceptance run remains pending controlled rollout.

## Next Tasks

- Deploy the Package 3 build and add only the zero-effect async pair to the
  live task allowlist.
- Capture a live queued → running → terminal acceptance and a bounded
  poll-failure recovery drill.
- Collect representative Shadow comparisons across `hermes | codex | openclaw`
  before changing selection policy from Shadow to enforced.
- Add future non-dry-run templates one at a time with explicit allowlists,
  approval behavior, audit logging, and end-to-end acceptance tests.
