# github-channel

A Claude Code plugin that delivers GitHub events — CI results, PR reviews, Copilot comments, deploys, merges — as live channel notifications into your running CLI session.

## What you get

While you're coding, events arrive as channel notifications without any manual polling:

```
✅ CI success on `owner/repo` (`main` @ a1b2c3d)

🔄 alice requested changes on PR #42: Add retry logic
> The timeout value should be configurable

🚀 Deploy to production succeeded on `owner/repo` (a1b2c3d @ `main`)
```

Events:

| Source | Notification |
|--------|-------------|
| GitHub Actions / CI | ✅/❌ check_suite or workflow_run completed |
| PR merged | 🔀 |
| PR review: approved / changes requested | ✅/🔄 |
| Copilot or bot PR comment | 🤖 |
| Deploy status | 🚀/💥 |

## Install

```bash
claude plugin install github:fryanpan/github-channel
```

## Setup

### 1. Expose the webhook receiver

GitHub needs a public URL to reach your local machine. [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) is free with no account required:

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:7902
# → https://randomly-named.trycloudflare.com
```

Keep this running in a terminal tab.

### 2. Watch a repo

In your Claude session:

```
set_webhook_url https://randomly-named.trycloudflare.com
watch_repo auto    # detects from cwd, or specify "owner/repo"
```

That's it. GitHub webhooks are registered automatically and events start flowing.

### Auto-register webhooks (optional)

Add a GitHub token to auto-register and clean up webhooks when you call `watch_repo`/`unwatch_repo`. Needs `repo` + `admin:repo_hook` scopes.

Add to your `~/.claude.json` under the `github-channel` MCP server entry:

```json
"env": {
  "GITHUB_TOKEN": "github_pat_..."
}
```

Without a token, you can still use the plugin — just configure webhooks manually in GitHub → repo Settings → Webhooks. Run `show_webhook_secret` to get the HMAC secret.

## Tools

| Tool | Description |
|------|-------------|
| `watch_repo` | Watch a repo (`"auto"` detects from cwd) |
| `unwatch_repo` | Stop watching + delete webhook |
| `list_watched` | Show watched repos and webhook status |
| `set_webhook_url` | Set the public URL (cloudflared/ngrok) |
| `show_webhook_secret` | Get HMAC secret for manual webhook setup |

## Env vars

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_TOKEN` | — | PAT with `repo` + `admin:repo_hook` scopes |
| `GITHUB_CHANNEL_PORT` | `7902` | Local webhook receiver port |
| `GITHUB_WEBHOOK_SECRET` | auto-generated | Override the HMAC secret |

State is persisted in `~/.github-channel-mcp.json`.

## Development

```bash
git clone https://github.com/fryanpan/github-channel
cd github-channel
bun install
bun server.ts
```

Test the webhook receiver:
```bash
curl http://localhost:7902/health  # → ok
```
