---
summary: "Updating OpenClaw safely (global install or source), plus rollback strategy"
read_when:
  - Updating OpenClaw
  - Something breaks after an update
title: "Updating"
---

# Updating

Keep OpenClaw up to date.

## Recommended: `openclaw update`

The fastest way to update. It detects your install type (npm or git), fetches the latest version, runs `openclaw doctor`, and restarts the gateway.

```bash
openclaw update
```

To switch channels or target a specific version:

```bash
openclaw update --channel beta
openclaw update --tag main
openclaw update --dry-run   # preview without applying
```

See [Development channels](/install/development-channels) for channel semantics.

## Alternative: re-run the installer

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

Add `--no-onboard` to skip onboarding. For source installs, pass `--install-method git --no-onboard`.

## Alternative: manual npm or pnpm

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

## Auto-updater

The auto-updater is off by default. Enable it in `~/.openclaw/openclaw.json`:

```json5
{
  update: {
    channel: "stable",
    auto: {
      enabled: true,
      stableDelayHours: 6,
      stableJitterHours: 12,
      betaCheckIntervalHours: 1,
    },
  },
}
```

| Channel  | Behavior                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| `stable` | Waits `stableDelayHours`, then applies with deterministic jitter across `stableJitterHours` (spread rollout). |
| `beta`   | Checks every `betaCheckIntervalHours` (default: hourly) and applies immediately.                              |
| `dev`    | No automatic apply. Use `openclaw update` manually.                                                           |

The gateway also logs an update hint on startup (disable with `update.checkOnStart: false`).

## After updating

<Steps>

### Run doctor

```bash
openclaw doctor
```

Migrates config, audits DM policies, and checks gateway health. Details: [Doctor](/gateway/doctor)

### Restart the gateway

```bash
openclaw gateway restart
```

### Verify

```bash
openclaw health
```

</Steps>

## Local source edits vs released updates

If you run OpenClaw with managed Gateway services (launchd/systemd), runtime changes only apply after restarting the affected Gateway process.

### What is different?

- `openclaw update` (recommended) updates to released content (npm/git channel), runs doctor, and restarts Gateway automatically.
- Local source edits in your repo are not the same as a released npm update. After code changes, restart the Gateway services that should pick up your local runtime.

### Managed multi-Gateway restart example

When you run three services on one host (`default`, `customer-a`, `customer-c`):

```bash
openclaw gateway restart
openclaw --profile customer-a gateway restart
openclaw --profile customer-c gateway restart
```

Verify all three after restart:

```bash
openclaw status
openclaw --profile customer-a status
openclaw --profile customer-c status
```

Optional listener check:

```bash
lsof -nP -iTCP -sTCP:LISTEN | rg '18789|18840|18880'
```

### Manual update paths

If you need manual control instead of `openclaw update`:

- npm/pnpm global install path:

```bash
npm i -g openclaw@latest
# or
pnpm add -g openclaw@latest
```

- source checkout path:

```bash
git pull
pnpm install
pnpm build
```

Then restart the same managed Gateway services you run in production.

## Rollback

### Pin a version (npm)

```bash
npm i -g openclaw@<version>
openclaw doctor
openclaw gateway restart
```

Tip: `npm view openclaw version` shows the current published version.

### Pin a commit (source)

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
pnpm install && pnpm build
openclaw gateway restart
```

To return to latest: `git checkout main && git pull`.

## If you are stuck

- Run `openclaw doctor` again and read the output carefully.
- Check: [Troubleshooting](/gateway/troubleshooting)
- Ask in Discord: [https://discord.gg/clawd](https://discord.gg/clawd)

## Related

- [Install Overview](/install) — all installation methods
- [Doctor](/gateway/doctor) — health checks after updates
- [Migrating](/install/migrating) — major version migration guides
