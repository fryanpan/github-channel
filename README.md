# github-claude-channel

A Claude Code plugin that delivers GitHub events — CI results, PR reviews, merges, and deploys — as live channel notifications into your running CLI session.

No webhooks. No public URL. Uses your existing `gh` credentials.

## What you get

While you're coding, events arrive automatically:

```
✅ CI success on `owner/repo` (`main` @ a1b2c3d)

👀 Review requested on `owner/repo`: **Add retry logic**

🔀 PR #42 merged on `owner/repo`: **Add retry logic**

🚀 Deploy CI success on `owner/repo` (a1b2c3d @ `main`)
  https://github.com/owner/repo/actions/runs/...
```

When a PR merges, the server automatically watches for a deploy workflow to complete — polling every 30 seconds for up to 30 minutes. Multiple PRs merging in parallel are each tracked independently.

## Events

| Event | Notification |
|-------|-------------|
| CI passes / fails | ✅/❌ check suite completed |
| PR merged | 🔀 |
| PR closed without merging | 🚫 |
| Review requested | 👀 |
| Mention / comment | 💬 |
| Deploy workflow completed | 🚀/💥 (triggered by merge) |

## Install

```bash
claude plugin install github:fryanpan/github-claude-channel
```

Add your GitHub token to `~/.claude.json` under the plugin's env:

```json
"github-claude-channel": {
  "command": "bun",
  "args": ["/path/to/github-claude-channel-mcp/server.ts"],
  "env": {
    "GITHUB_TOKEN": "github_pat_..."
  }
}
```

The token needs `repo` scope (for reading notifications and action runs). No `admin:repo_hook` needed.

## Setup

```
watch_repo auto    # detects repo from cwd, or specify "owner/repo"
```

That's it. The server auto-detects the repo from your working directory and starts listening.

## How it works

A **broker daemon** runs once per user (started automatically). It polls `/notifications` every 5 seconds and `/actions/runs` every 30 seconds when a deploy watch is active. Each Claude Code session connects to the broker and receives events for the repos it's watching.

Multiple sessions on the same machine all receive events — each session independently subscribes to repos, and the broker fans out deliveries.

## Tools

| Tool | Description |
|------|-------------|
| `watch_repo` | Watch a repo (`"auto"` detects from cwd) |
| `unwatch_repo` | Stop watching a repo |
| `list_watched` | Show repos this session is watching |
| `show_status` | Show broker health, sessions, and active deploy watches |

## Env vars

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_TOKEN` | — | PAT with `repo` scope |
| `GITHUB_CHANNEL_PORT` | `7902` | Broker port (change if 7902 is taken by another user) |

## Multi-user

Each Mac user gets their own broker process using their own token and home directory. If two users need to share port 7902, the second user sets `GITHUB_CHANNEL_PORT=7903` in their shell profile.

## Development

```bash
git clone https://github.com/fryanpan/github-claude-channel
cd github-claude-channel
bun install
GITHUB_TOKEN=... bun broker.ts   # start broker
bun server.ts                    # start MCP server (in another terminal)
curl http://localhost:7902/state # inspect broker state
```
