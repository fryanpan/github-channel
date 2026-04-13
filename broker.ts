#!/usr/bin/env bun
/**
 * GitHub channel broker daemon
 *
 * One instance per user, persists across Claude Code session restarts.
 * Started automatically by the MCP server if not already running.
 *
 * Responsibilities:
 * - Poll /notifications every 5s and deliver to subscribed sessions
 * - On PR merge: start a deploy watch for that repo
 * - Poll /actions/runs every 30s per active deploy watch (multiple in-flight supported)
 * - Route events to the right sessions by repo
 */

const PORT = parseInt(process.env.GITHUB_CHANNEL_PORT ?? "7902", 10);
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";

const NOTIFICATION_POLL_MS = 5_000;
const DEPLOY_POLL_MS = 30_000;
const DEPLOY_WATCH_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_TIMEOUT_MS = 30_000; // drop session if no heartbeat

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[github-broker ${ts}] ${msg}`);
}

// ─── State ───────────────────────────────────────────────────────────────────

interface Session {
  id: string;
  repos: Set<string>;
  queue: string[];
  lastSeen: number;
}

interface DeployWatch {
  prNumber: number;
  prTitle: string;
  mergedAt: number; // epoch ms
  expiresAt: number; // epoch ms
}

const sessions = new Map<string, Session>();
const deployWatches = new Map<string, DeployWatch[]>(); // repo → watches
const reportedRunIds = new Set<string>(); // action run IDs already delivered
const seenNotifIds = new Set<string>(); // notification IDs already processed

let lastNotifSince = new Date(Date.now() - 60_000).toISOString();

// ─── Session helpers ─────────────────────────────────────────────────────────

function makeId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function pruneDeadSessions() {
  const cutoff = Date.now() - SESSION_TIMEOUT_MS;
  for (const [id, s] of sessions) {
    if (s.lastSeen < cutoff) {
      sessions.delete(id);
      log(`Session ${id} expired`);
    }
  }
}

function reposWithWatchers(): Set<string> {
  const repos = new Set<string>();
  for (const s of sessions.values()) {
    for (const r of s.repos) repos.add(r);
  }
  return repos;
}

function deliver(repo: string, message: string) {
  let delivered = 0;
  for (const s of sessions.values()) {
    if (s.repos.has(repo)) {
      s.queue.push(message);
      delivered++;
    }
  }
  if (delivered > 0) log(`Delivered to ${delivered} session(s): ${message.slice(0, 80)}`);
}

// ─── GitHub API ──────────────────────────────────────────────────────────────

async function ghFetch(pathOrUrl: string): Promise<Response> {
  const url = pathOrUrl.startsWith("https://")
    ? pathOrUrl
    : `https://api.github.com${pathOrUrl}`;
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
}

// ─── Notification polling ─────────────────────────────────────────────────────

interface GHNotif {
  id: string;
  reason: string;
  repository: { full_name: string };
  subject: { type: string; title: string; url: string };
}

async function pollNotifications() {
  if (!GITHUB_TOKEN) return;
  const watched = reposWithWatchers();
  if (watched.size === 0) return;

  let res: Response;
  try {
    res = await ghFetch(`/notifications?all=false&participating=false&since=${lastNotifSince}&per_page=50`);
  } catch (e) {
    log(`Notification fetch error: ${e}`);
    return;
  }

  if (res.status === 304 || !res.ok) return;
  lastNotifSince = new Date().toISOString();

  const notifs = await res.json() as GHNotif[];
  if (!Array.isArray(notifs)) return;

  for (const n of notifs) {
    if (seenNotifIds.has(n.id)) continue;
    seenNotifIds.add(n.id);

    const repo = n.repository?.full_name;
    if (!repo || !watched.has(repo)) continue;

    const { type, url } = n.subject;

    if (n.reason === "ci_activity" || type === "CheckSuite") {
      // Fetch the check suite to get the conclusion
      handleCheckSuiteNotif(repo, url).catch(() => {});
    } else if (type === "PullRequest" && n.reason === "state_change") {
      // Could be a merge or close — fetch the PR to find out
      handlePRStateChange(repo, n.subject.title, url).catch(() => {});
    } else {
      const msg = formatNotif(n);
      if (msg) deliver(repo, msg);
    }
  }
}

async function handleCheckSuiteNotif(repo: string, suiteUrl: string) {
  try {
    const res = await ghFetch(suiteUrl);
    if (!res.ok) return;
    const suite = await res.json() as {
      conclusion: string | null;
      status: string;
      head_branch: string;
      head_sha: string;
    };
    if (suite.status !== "completed" || !suite.conclusion) return;
    const icon = suite.conclusion === "success" ? "✅" : "❌";
    deliver(repo, `${icon} CI **${suite.conclusion}** on \`${repo}\` (\`${suite.head_branch}\` @ ${suite.head_sha.slice(0, 7)})`);
  } catch (e) {
    log(`Check suite fetch error: ${e}`);
  }
}

async function handlePRStateChange(repo: string, title: string, prUrl: string) {
  try {
    const res = await ghFetch(prUrl);
    if (!res.ok) return;
    const pr = await res.json() as {
      number: number;
      title: string;
      state: string;
      merged: boolean;
      merged_at: string | null;
      html_url: string;
    };

    if (pr.state === "closed" && pr.merged && pr.merged_at) {
      deliver(repo, `🔀 PR #${pr.number} merged on \`${repo}\`: **${pr.title}**\n${pr.html_url}`);
      addDeployWatch(repo, pr.number, pr.title, new Date(pr.merged_at).getTime());
    } else if (pr.state === "closed") {
      deliver(repo, `🚫 PR #${pr.number} closed on \`${repo}\`: **${pr.title}**`);
    }
  } catch (e) {
    log(`PR fetch error: ${e}`);
  }
}

function formatNotif(n: GHNotif): string | null {
  const repo = n.repository.full_name;
  const title = n.subject.title;
  switch (n.reason) {
    case "review_requested":
      return `👀 Review requested on \`${repo}\`: **${title}**`;
    case "comment":
    case "mention":
      return `💬 Mention on \`${repo}\`: **${title}**`;
    default:
      return null;
  }
}

// ─── Deploy watch ─────────────────────────────────────────────────────────────

function addDeployWatch(repo: string, prNumber: number, prTitle: string, mergedAt: number) {
  const existing = deployWatches.get(repo) ?? [];
  existing.push({ prNumber, prTitle, mergedAt, expiresAt: Date.now() + DEPLOY_WATCH_TIMEOUT_MS });
  deployWatches.set(repo, existing);
  log(`Deploy watch started for ${repo} PR #${prNumber} (${existing.length} active)`);
}

async function pollDeployWatches() {
  if (!GITHUB_TOKEN) return;

  for (const [repo, watches] of deployWatches) {
    // Remove expired watches
    const active = watches.filter((w) => Date.now() < w.expiresAt);
    if (active.length === 0) {
      deployWatches.delete(repo);
      continue;
    }
    deployWatches.set(repo, active);

    // Earliest merge time across all active watches — look for runs after this
    const since = Math.min(...active.map((w) => w.mergedAt));

    let res: Response;
    try {
      res = await ghFetch(`/repos/${repo}/actions/runs?branch=main&per_page=20&event=push`);
    } catch {
      continue;
    }
    if (!res.ok) continue;

    const data = await res.json() as {
      workflow_runs: Array<{
        id: number;
        name: string;
        status: string;
        conclusion: string | null;
        created_at: string;
        head_branch: string;
        head_sha: string;
        html_url: string;
      }>;
    };

    for (const run of data.workflow_runs ?? []) {
      const runId = String(run.id);
      if (reportedRunIds.has(runId)) continue;
      if (run.status !== "completed") continue;

      const runCreatedAt = new Date(run.created_at).getTime();
      if (runCreatedAt < since) continue; // predates all active watches

      reportedRunIds.add(runId);

      const icon = run.conclusion === "success" ? "🚀" : "💥";
      deliver(repo, `${icon} Deploy **${run.name}** ${run.conclusion ?? "unknown"} on \`${repo}\` (${run.head_sha.slice(0, 7)} @ \`${run.head_branch}\`)\n${run.html_url}`);

      // Mark watches that this run satisfied as done
      // A run satisfies a watch if the run started after that watch's mergedAt
      const remaining = active.filter((w) => {
        // Keep watches whose mergedAt is after this run (run was from an earlier merge)
        return w.mergedAt > runCreatedAt;
      });
      deployWatches.set(repo, remaining.filter((w) => Date.now() < w.expiresAt));
    }
  }
}

// ─── Polling loops ───────────────────────────────────────────────────────────

async function notificationLoop() {
  while (true) {
    pruneDeadSessions();
    await pollNotifications().catch((e) => log(`Poll error: ${e}`));
    await Bun.sleep(NOTIFICATION_POLL_MS);
  }
}

async function deployWatchLoop() {
  while (true) {
    await Bun.sleep(DEPLOY_POLL_MS);
    await pollDeployWatches().catch((e) => log(`Deploy poll error: ${e}`));
  }
}

// ─── HTTP server ─────────────────────────────────────────────────────────────

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, sessions: sessions.size, deployWatches: deployWatches.size });
    }

    if (url.pathname === "/state") {
      // Debug: GET or POST both fine
    } else if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;

    switch (url.pathname) {
      case "/register": {
        const id = makeId();
        const repos = new Set<string>(Array.isArray(body.repos) ? body.repos as string[] : []);
        sessions.set(id, { id, repos, queue: [], lastSeen: Date.now() });
        log(`Session ${id} registered (repos: ${[...repos].join(", ") || "none"})`);
        return Response.json({ id });
      }

      case "/heartbeat": {
        const s = sessions.get(body.id as string);
        if (s) s.lastSeen = Date.now();
        return Response.json({ ok: true });
      }

      case "/poll": {
        const s = sessions.get(body.id as string);
        if (!s) return Response.json({ events: [] });
        s.lastSeen = Date.now();
        const events = s.queue.splice(0);
        return Response.json({ events });
      }

      case "/watch": {
        const s = sessions.get(body.id as string);
        if (!s) return Response.json({ ok: false });
        s.repos.add(body.repo as string);
        s.lastSeen = Date.now();
        log(`Session ${s.id} watching ${body.repo}`);
        return Response.json({ ok: true });
      }

      case "/unwatch": {
        const s = sessions.get(body.id as string);
        if (!s) return Response.json({ ok: false });
        s.repos.delete(body.repo as string);
        s.lastSeen = Date.now();
        return Response.json({ ok: true });
      }

      case "/state": {
        // Debug endpoint
        const state = {
          sessions: [...sessions.values()].map((s) => ({
            id: s.id,
            repos: [...s.repos],
            queueDepth: s.queue.length,
            lastSeenAgo: Math.round((Date.now() - s.lastSeen) / 1000) + "s",
          })),
          deployWatches: Object.fromEntries(
            [...deployWatches.entries()].map(([repo, watches]) => [
              repo,
              watches.map((w) => ({
                prNumber: w.prNumber,
                prTitle: w.prTitle,
                mergedAgo: Math.round((Date.now() - w.mergedAt) / 1000) + "s",
                expiresIn: Math.round((w.expiresAt - Date.now()) / 1000) + "s",
              })),
            ])
          ),
        };
        return Response.json(state);
      }

      default:
        return new Response("Not Found", { status: 404 });
    }
  },
});

log(`Broker listening on port ${PORT}`);
if (!GITHUB_TOKEN) log("WARNING: No GITHUB_TOKEN — polling disabled");

notificationLoop();
deployWatchLoop();
