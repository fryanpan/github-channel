#!/usr/bin/env bun
/**
 * github-channel MCP server
 *
 * Runs a local HTTP webhook receiver and delivers GitHub events (CI, reviews,
 * deploys, PR merges) as Claude Code channel notifications into running sessions.
 *
 * Env vars:
 *   GITHUB_TOKEN          — PAT with repo + admin:repo_hook scopes (for auto-registering webhooks)
 *   GITHUB_WEBHOOK_SECRET — override the persisted HMAC secret
 *   GITHUB_CHANNEL_PORT   — webhook HTTP port (default 7902)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createHmac, timingSafeEqual } from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ─── Config ─────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.GITHUB_CHANNEL_PORT ?? "7902", 10);
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const STATE_FILE = join(homedir(), ".github-channel-mcp.json");

function log(msg: string) {
  console.error(`[github-channel] ${msg}`);
}

// ─── Persistent state ────────────────────────────────────────────────────────

interface State {
  watchedRepos: string[];        // ["owner/repo", ...]
  webhookSecret: string;
  webhookUrl: string | null;
  registeredHooks: Record<string, number>; // "owner/repo" → hook_id
}

function loadState(): State {
  if (existsSync(STATE_FILE)) {
    try {
      return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
    } catch {
      // corrupt state — start fresh
    }
  }
  return {
    watchedRepos: [],
    webhookSecret: generateSecret(),
    webhookUrl: null,
    registeredHooks: {},
  };
}

function saveState(s: State) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), "utf8");
}

function generateSecret(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const state = loadState();

// Allow env var to override the persisted secret (useful for bringing your own secret)
if (process.env.GITHUB_WEBHOOK_SECRET) {
  state.webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
}

// ─── GitHub API ──────────────────────────────────────────────────────────────

async function githubFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const url = path.startsWith("https://") ? path : `https://api.github.com${path}`;
  return fetch(url, {
    ...options,
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
}

async function registerWebhook(repo: string): Promise<number | null> {
  if (!state.webhookUrl) {
    log(`No webhook URL set — skipping hook registration for ${repo}`);
    return null;
  }
  if (!GITHUB_TOKEN) {
    log("No GITHUB_TOKEN — skipping hook registration");
    return null;
  }

  const res = await githubFetch(`/repos/${repo}/hooks`, {
    method: "POST",
    body: JSON.stringify({
      name: "web",
      active: true,
      events: [
        "check_suite",
        "workflow_run",
        "pull_request",
        "pull_request_review",
        "issue_comment",
        "deployment_status",
      ],
      config: {
        url: state.webhookUrl,
        content_type: "json",
        secret: state.webhookSecret,
        insecure_ssl: "0",
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    log(`Failed to register webhook for ${repo}: ${res.status} ${body}`);
    return null;
  }

  const data = (await res.json()) as { id: number };
  log(`Registered webhook ${data.id} for ${repo}`);
  return data.id;
}

async function deleteWebhook(repo: string, hookId: number): Promise<void> {
  if (!GITHUB_TOKEN) return;
  await githubFetch(`/repos/${repo}/hooks/${hookId}`, { method: "DELETE" });
  log(`Deleted webhook ${hookId} for ${repo}`);
}

// ─── Repo detection ──────────────────────────────────────────────────────────

async function detectRepoFromCwd(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "remote", "get-url", "origin"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    return parseGitHubRemote(text.trim());
  } catch {
    return null;
  }
}

function parseGitHubRemote(remote: string): string | null {
  // https://github.com/owner/repo.git  or  git@github.com:owner/repo.git
  const m =
    remote.match(/github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/) ??
    remote.match(/github\.com:([^/]+\/[^/.]+?)(?:\.git)?$/);
  return m ? m[1] : null;
}

// ─── HMAC verification ───────────────────────────────────────────────────────

function verifySignature(body: string, sigHeader: string | null): boolean {
  if (!sigHeader?.startsWith("sha256=")) return false;
  const sig = sigHeader.slice(7);
  const expected = createHmac("sha256", state.webhookSecret).update(body).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

// ─── Event formatting ────────────────────────────────────────────────────────

function formatEvent(event: string, payload: Record<string, unknown>): string | null {
  const repo = (payload.repository as { full_name?: string } | undefined)?.full_name ?? "unknown/repo";
  const action = payload.action as string | undefined;

  switch (event) {
    case "check_suite": {
      const cs = payload.check_suite as { status: string; conclusion: string | null; head_branch: string; head_sha: string } | undefined;
      if (!cs || cs.status !== "completed") return null;
      const icon = cs.conclusion === "success" ? "✅" : "❌";
      return `${icon} CI **${cs.conclusion ?? "unknown"}** on \`${repo}\` (\`${cs.head_branch}\` @ ${cs.head_sha.slice(0, 7)})`;
    }

    case "workflow_run": {
      const wr = payload.workflow_run as { status: string; conclusion: string | null; name: string; head_branch: string; html_url: string } | undefined;
      if (!wr || wr.status !== "completed") return null;
      const icon = wr.conclusion === "success" ? "✅" : "❌";
      return `${icon} Workflow **${wr.name}** ${wr.conclusion ?? "unknown"} on \`${repo}\` (\`${wr.head_branch}\`)\n${wr.html_url}`;
    }

    case "pull_request": {
      const pr = payload.pull_request as { number: number; title: string; html_url: string; merged: boolean; user: { login: string } } | undefined;
      if (!pr) return null;
      if (action === "closed" && pr.merged) {
        return `🔀 PR #${pr.number} merged on \`${repo}\`: **${pr.title}**\n${pr.html_url}`;
      }
      if (action === "opened" || action === "ready_for_review") {
        return `📬 PR #${pr.number} opened on \`${repo}\` by **${pr.user.login}**: ${pr.title}\n${pr.html_url}`;
      }
      return null;
    }

    case "pull_request_review": {
      const review = payload.review as { state: string; user: { login: string }; html_url: string; body: string | null } | undefined;
      const pr = payload.pull_request as { number: number; title: string } | undefined;
      if (!review || !pr) return null;
      const icon = review.state === "approved" ? "✅" : review.state === "changes_requested" ? "🔄" : "💬";
      const label = review.state === "approved" ? "approved" : review.state === "changes_requested" ? "requested changes on" : "commented on";
      const body = review.body ? `\n> ${review.body.slice(0, 200)}` : "";
      return `${icon} **${review.user.login}** ${label} PR #${pr.number} on \`${repo}\`: ${pr.title}${body}\n${review.html_url}`;
    }

    case "issue_comment": {
      // Surface bot/Copilot comments on PRs only
      const comment = payload.comment as { user: { login: string; type: string }; body: string; html_url: string } | undefined;
      const issue = payload.issue as { number: number; title: string; pull_request?: unknown } | undefined;
      if (!comment || !issue?.pull_request) return null;
      const isBot = comment.user.type === "Bot" || comment.user.login.toLowerCase().includes("copilot");
      if (!isBot) return null;
      return `🤖 **${comment.user.login}** commented on PR #${issue.number} on \`${repo}\`:\n> ${comment.body.slice(0, 300)}\n${comment.html_url}`;
    }

    case "deployment_status": {
      const ds = payload.deployment_status as { state: string; environment: string; log_url: string | null; description: string | null } | undefined;
      const dep = payload.deployment as { ref: string; sha: string } | undefined;
      if (!ds || !dep) return null;
      const terminal = ["success", "failure", "error", "inactive"].includes(ds.state);
      if (!terminal) return null;
      const icon = ds.state === "success" ? "🚀" : ds.state === "failure" || ds.state === "error" ? "💥" : "⏹";
      const desc = ds.description ? ` — ${ds.description}` : "";
      const url = ds.log_url ? `\n${ds.log_url}` : "";
      return `${icon} Deploy to **${ds.environment}** ${ds.state} on \`${repo}\` (${dep.sha.slice(0, 7)} @ \`${dep.ref}\`)${desc}${url}`;
    }

    default:
      return null;
  }
}

// ─── MCP server ──────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: "github-channel", version: "1.0.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `GitHub events are delivered as channel notifications from this server.

Events: ✅/❌ CI results · 🔀 PR merged · ✅/🔄 PR reviews · 🤖 Copilot/bot comments · 🚀/💥 deploys

Tools:
- watch_repo: Watch a repo ("auto" detects from cwd)
- unwatch_repo: Stop watching
- list_watched: Show watched repos and webhook status
- set_webhook_url: Set public URL for webhooks (get from cloudflared)
- show_webhook_secret: Show HMAC secret for manual webhook setup`,
  }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "watch_repo",
      description: 'Watch a GitHub repo for CI, review, deploy, and PR events. Use repo="auto" to detect from cwd.',
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: { type: "string", description: '"owner/repo" or "auto" to detect from cwd' },
          cwd: { type: "string", description: "Directory to detect repo from (defaults to process cwd)" },
        },
        required: ["repo"],
      },
    },
    {
      name: "unwatch_repo",
      description: "Stop watching a GitHub repo and delete its webhook.",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: { type: "string", description: '"owner/repo"' },
        },
        required: ["repo"],
      },
    },
    {
      name: "list_watched",
      description: "List all watched repos and their webhook status.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "set_webhook_url",
      description: "Set the public HTTPS URL for GitHub webhooks (e.g. from cloudflared).",
      inputSchema: {
        type: "object" as const,
        properties: {
          url: { type: "string", description: "Public HTTPS URL" },
        },
        required: ["url"],
      },
    },
    {
      name: "show_webhook_secret",
      description: "Show the HMAC secret for configuring webhooks manually in the GitHub UI.",
      inputSchema: { type: "object" as const, properties: {} },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  switch (name) {
    case "watch_repo": {
      let repo = (args.repo as string).trim();

      if (repo === "auto") {
        const cwd = (args.cwd as string | undefined) ?? process.cwd();
        const detected = await detectRepoFromCwd(cwd);
        if (!detected) {
          return { content: [{ type: "text", text: `Could not detect a GitHub repo from: ${cwd}\nSpecify the repo explicitly, e.g. watch_repo("owner/repo").` }] };
        }
        repo = detected;
      }

      if (state.watchedRepos.includes(repo)) {
        return { content: [{ type: "text", text: `Already watching \`${repo}\`.` }] };
      }

      state.watchedRepos.push(repo);
      const hookId = await registerWebhook(repo);
      if (hookId) state.registeredHooks[repo] = hookId;
      saveState(state);

      const hookNote = hookId
        ? `Webhook registered (id: ${hookId}).`
        : state.webhookUrl
        ? "Webhook registration failed — check that GITHUB_TOKEN has admin:repo_hook scope."
        : "No webhook URL set yet. Run `set_webhook_url` first, or configure the webhook manually in GitHub (use `show_webhook_secret` to get the secret).";

      return { content: [{ type: "text", text: `Now watching \`${repo}\`.\n${hookNote}` }] };
    }

    case "unwatch_repo": {
      const repo = (args.repo as string).trim();
      const idx = state.watchedRepos.indexOf(repo);
      if (idx === -1) return { content: [{ type: "text", text: `Not watching \`${repo}\`.` }] };

      state.watchedRepos.splice(idx, 1);
      const hookId = state.registeredHooks[repo];
      if (hookId) {
        await deleteWebhook(repo, hookId);
        delete state.registeredHooks[repo];
      }
      saveState(state);
      return { content: [{ type: "text", text: `Stopped watching \`${repo}\`.` }] };
    }

    case "list_watched": {
      if (state.watchedRepos.length === 0) {
        return { content: [{ type: "text", text: 'No repos watched. Use `watch_repo` to start.' }] };
      }
      const lines = state.watchedRepos.map((r) => {
        const id = state.registeredHooks[r];
        return `- \`${r}\`${id ? ` (hook #${id})` : " (no webhook)"}`;
      });
      return {
        content: [{
          type: "text",
          text: `Watched repos:\n${lines.join("\n")}\n\nWebhook URL: ${state.webhookUrl ?? "(not set — run set_webhook_url)"}\nLocal receiver: http://localhost:${PORT}`,
        }],
      };
    }

    case "set_webhook_url": {
      const url = (args.url as string).replace(/\/$/, "");
      state.webhookUrl = url;
      const pending = state.watchedRepos.filter((r) => !state.registeredHooks[r]);
      for (const repo of pending) {
        const hookId = await registerWebhook(repo);
        if (hookId) state.registeredHooks[repo] = hookId;
      }
      saveState(state);
      const note = pending.length > 0
        ? `Registered webhooks for: ${pending.join(", ")}`
        : "All repos already have webhooks.";
      return { content: [{ type: "text", text: `Webhook URL set to ${url}.\n${note}` }] };
    }

    case "show_webhook_secret": {
      return {
        content: [{
          type: "text",
          text: `Webhook HMAC secret: \`${state.webhookSecret}\`\n\nUse this in GitHub → repo Settings → Webhooks → Secret.\nWebhook URL to point to: ${state.webhookUrl ?? `(expose localhost:${PORT} via cloudflared first)`}`,
        }],
      };
    }

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
});

// ─── Webhook receiver ────────────────────────────────────────────────────────

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return new Response("ok");
    }

    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const body = await req.text();
    const event = req.headers.get("x-github-event") ?? "unknown";

    if (!verifySignature(body, req.headers.get("x-hub-signature-256"))) {
      log(`Signature mismatch for event: ${event}`);
      return new Response("Unauthorized", { status: 401 });
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body);
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }

    const repo = (payload.repository as { full_name?: string } | undefined)?.full_name ?? "";

    if (!state.watchedRepos.includes(repo)) {
      return new Response("OK");
    }

    const message = formatEvent(event, payload);
    if (!message) {
      return new Response("OK");
    }

    log(`Notification: ${message.slice(0, 100)}`);

    try {
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: message,
          meta: { event, repo, action: payload.action ?? null },
        },
      });
    } catch (e) {
      log(`Failed to push notification: ${e instanceof Error ? e.message : String(e)}`);
    }

    return new Response("OK");
  },
});

log(`Webhook receiver on port ${PORT}`);

const transport = new StdioServerTransport();
await mcp.connect(transport);
log("MCP server ready");
