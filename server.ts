#!/usr/bin/env bun
/**
 * github-claude-channel MCP server
 *
 * One instance per Claude Code session. Connects to the shared broker daemon
 * (starting it if needed) and pushes GitHub events as channel notifications.
 *
 * Env vars:
 *   GITHUB_TOKEN        — PAT with repo scope (for the broker to poll GitHub)
 *   GITHUB_CHANNEL_PORT — broker port (default 7902)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.GITHUB_CHANNEL_PORT ?? "7902", 10);
const BROKER_URL = `http://127.0.0.1:${PORT}`;
const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;
const POLL_INTERVAL_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 10_000;

function log(msg: string) {
  console.error(`[github-claude-channel] ${msg}`);
}

// ─── Broker communication ─────────────────────────────────────────────────────

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Broker ${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) {
    log("Broker already running");
    return;
  }
  log("Starting broker...");
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    stdio: ["ignore", "ignore", "inherit"],
    env: process.env as Record<string, string>,
  });
  proc.unref();

  for (let i = 0; i < 30; i++) {
    await Bun.sleep(200);
    if (await isBrokerAlive()) {
      log("Broker started");
      return;
    }
  }
  throw new Error("Broker failed to start after 6s");
}

// ─── Repo detection ──────────────────────────────────────────────────────────

async function detectRepo(cwd: string): Promise<string | null> {
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
  const m = remote.match(/github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/);
  return m ? m[1] : null;
}

// ─── Session state ────────────────────────────────────────────────────────────

let sessionId: string | null = null;
const watchedRepos = new Set<string>();

// ─── MCP server ──────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: "github-claude-channel", version: "1.0.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `GitHub events arrive as channel notifications from this server.

Events: ✅/❌ CI · 🔀 PR merged · 👀 Review requested · 💬 Mentions · 🚀/💥 Deploys

When a PR merges, the server automatically watches for a deploy workflow to complete on \`main\` (up to 30 min, polling every 30s). Multiple PRs merging in parallel are each tracked independently.

Tools:
- watch_repo: Watch a repo ("auto" detects from cwd)
- unwatch_repo: Stop watching a repo
- list_watched: Show watched repos
- show_status: Show broker health and active deploy watches`,
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
          repo: { type: "string", description: '"owner/repo" or "auto"' },
          cwd: { type: "string", description: "Directory to detect from (default: process cwd)" },
        },
        required: ["repo"],
      },
    },
    {
      name: "unwatch_repo",
      description: "Stop watching a GitHub repo.",
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
      description: "List repos this session is watching.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "show_status",
      description: "Show broker health, active sessions, and in-flight deploy watches.",
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
        const detected = await detectRepo(cwd);
        if (!detected) {
          return {
            content: [{
              type: "text",
              text: `Could not detect a GitHub repo from: ${cwd}\nSpecify the repo explicitly, e.g. watch_repo("owner/repo").`,
            }],
          };
        }
        repo = detected;
      }

      if (watchedRepos.has(repo)) {
        return { content: [{ type: "text", text: `Already watching \`${repo}\`.` }] };
      }

      watchedRepos.add(repo);
      if (sessionId) {
        await brokerFetch("/watch", { id: sessionId, repo }).catch(() => {});
      }
      return { content: [{ type: "text", text: `Now watching \`${repo}\`. Events will arrive as channel notifications.` }] };
    }

    case "unwatch_repo": {
      const repo = (args.repo as string).trim();
      if (!watchedRepos.has(repo)) {
        return { content: [{ type: "text", text: `Not watching \`${repo}\`.` }] };
      }
      watchedRepos.delete(repo);
      if (sessionId) {
        await brokerFetch("/unwatch", { id: sessionId, repo }).catch(() => {});
      }
      return { content: [{ type: "text", text: `Stopped watching \`${repo}\`.` }] };
    }

    case "list_watched": {
      if (watchedRepos.size === 0) {
        return { content: [{ type: "text", text: 'No repos watched. Use `watch_repo` to start.' }] };
      }
      const list = [...watchedRepos].map((r) => `- \`${r}\``).join("\n");
      return { content: [{ type: "text", text: `Watching:\n${list}` }] };
    }

    case "show_status": {
      try {
        const res = await fetch(`${BROKER_URL}/state`);
        if (!res.ok) throw new Error(`${res.status}`);
        const state = await res.json() as {
          sessions: Array<{ id: string; repos: string[]; queueDepth: number; lastSeenAgo: string }>;
          deployWatches: Record<string, Array<{ prNumber: number; prTitle: string; mergedAgo: string; expiresIn: string }>>;
        };

        const sessionLines = state.sessions.map((s) =>
          `  - ${s.id} (repos: ${s.repos.join(", ") || "none"}, queue: ${s.queueDepth}, last seen: ${s.lastSeenAgo})`
        );

        const watchLines = Object.entries(state.deployWatches).flatMap(([repo, watches]) =>
          watches.map((w) => `  - \`${repo}\` PR #${w.prNumber}: "${w.prTitle}" (merged ${w.mergedAgo} ago, expires in ${w.expiresIn})`)
        );

        const text = [
          `Broker: running on port ${PORT}`,
          `Sessions (${state.sessions.length}):`,
          ...sessionLines,
          watchLines.length > 0 ? `Deploy watches (${watchLines.length}):` : "Deploy watches: none",
          ...watchLines,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch {
        return { content: [{ type: "text", text: "Broker not reachable." }] };
      }
    }

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
});

// ─── Polling loop ─────────────────────────────────────────────────────────────

async function pollAndPush() {
  if (!sessionId) return;
  try {
    const { events } = await brokerFetch<{ events: string[] }>("/poll", { id: sessionId });
    for (const content of events) {
      await mcp.notification({
        method: "notifications/claude/channel",
        params: { content, meta: {} },
      });
    }
  } catch {
    // Broker might be restarting — don't crash
  }
}

async function heartbeat() {
  if (!sessionId) return;
  await brokerFetch("/heartbeat", { id: sessionId }).catch(() => {});
}

// ─── Startup ──────────────────────────────────────────────────────────────────

async function main() {
  await ensureBroker();

  // Auto-detect repo from cwd
  const cwd = process.cwd();
  const detectedRepo = await detectRepo(cwd);
  const initialRepos = detectedRepo ? [detectedRepo] : [];
  if (detectedRepo) {
    watchedRepos.add(detectedRepo);
    log(`Auto-watching ${detectedRepo}`);
  }

  // Register with broker
  const reg = await brokerFetch<{ id: string }>("/register", { repos: initialRepos });
  sessionId = reg.id;
  log(`Registered as session ${sessionId}`);

  // Poll for events
  setInterval(pollAndPush, POLL_INTERVAL_MS);
  setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  log("MCP server ready");
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
