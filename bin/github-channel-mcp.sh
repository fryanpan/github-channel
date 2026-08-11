#!/bin/sh
# Launcher for the github-claude-channel MCP server.
#
# Why this exists — two separate failures, both fixed here.
#
# 1. PATH. plugin.json used to say `"command": "bun"`, which only works when bun
#    happens to be on the launching process's PATH. bun installs to ~/.bun/bin,
#    which is on PATH only because ~/.zshrc puts it there. Verify with:
#
#        env -i PATH=/usr/bin:/bin sh -c 'command -v bun'   # finds nothing
#
#    So any session not launched from an interactive shell (launchd, a GUI app,
#    cron, a non-login shell) died at spawn with a bare
#
#        Connection failed (ENOENT): Executable not found in $PATH: "bun"
#
#    and from inside the session the plugin was simply absent. /bin/sh is the one
#    interpreter guaranteed to be present, so it does the resolution itself
#    instead of trusting the inherited environment. Resolving at runtime (rather
#    than hardcoding an absolute path) also survives a bun reinstall or upgrade.
#
# 2. Dedup. Claude Code keys plugin-MCP dedup on the command shape — literally
#    `stdio:` + JSON.stringify([command, ...args]). All three channel plugins
#    declared the identical ["bun", "./server.ts"], so the second and third were
#    silently suppressed as duplicates of the first:
#
#        Suppressing plugin MCP server "plugin:notion-channel-mcp:notion-channel":
#          duplicates earlier plugin server "plugin:github-claude-channel:..."
#
#    Referencing this script through ${CLAUDE_PLUGIN_ROOT} makes the argv
#    distinct per plugin. The script filename is distinct too, so the key stays
#    distinct even if placeholder expansion ever moved after the dedup pass.
#
# It also exports the resolved bun on PATH, because server.ts spawns the broker
# as a child process — without this, that child would hit failure #1 all over
# again one level down.
#
# Usage: /bin/sh github-channel-mcp.sh <path-to-server.ts> [args...]

set -u

entrypoint="${1:-}"
if [ -z "$entrypoint" ]; then
  echo "github-channel-mcp: no entrypoint given (expected server.ts as \$1)" >&2
  exit 64
fi
shift

find_bun() {
  # 1. Already on PATH — the normal case, and it respects a deliberate override.
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi
  # 2. The bun installer's own location. BUN_INSTALL is what install.sh sets;
  #    fall back to its default. HOME can be unset in exactly the environments
  #    this script exists for (cron, a sanitized launchd job), and under `set -u`
  #    a bare $HOME would abort the whole script — so default it and move on to
  #    the fixed locations below.
  bun_install="${BUN_INSTALL:-}"
  if [ -z "$bun_install" ] && [ -n "${HOME:-}" ]; then
    bun_install="$HOME/.bun"
  fi
  if [ -n "$bun_install" ] && [ -x "$bun_install/bin/bun" ]; then
    echo "$bun_install/bin/bun"
    return 0
  fi
  # 3. Common package-manager locations, in install-likelihood order.
  for candidate in \
    /opt/homebrew/bin/bun \
    /usr/local/bin/bun \
    /usr/bin/bun
  do
    [ -x "$candidate" ] && { echo "$candidate"; return 0; }
  done
  return 1
}

bun_bin=$(find_bun) || {
  echo "github-channel-mcp: could not find a bun binary." >&2
  echo "  Looked on PATH, in \${BUN_INSTALL:-\$HOME/.bun}/bin, and in" >&2
  echo "  /opt/homebrew/bin, /usr/local/bin, /usr/bin." >&2
  echo "  This plugin requires bun (the server uses bun:sqlite and Bun APIs," >&2
  echo "  so node is not a substitute). Install it from https://bun.sh, or put" >&2
  echo "  bun on the PATH the session is launched with." >&2
  exit 127
}

# Put the resolved bun first on PATH so child processes that shell out to `bun`
# resolve the same binary we did, whatever the inherited PATH looked like.
bun_dir=$(dirname "$bun_bin")
PATH="$bun_dir:${PATH:-/usr/bin:/bin}"
export PATH

# Secrets and overrides live outside the plugin directory: the plugin cache is
# keyed by version, so anything written in here is orphaned by the next release.
# Sourced only if the user created it; absent is the normal case.
config_home="${XDG_CONFIG_HOME:-}"
if [ -z "$config_home" ] && [ -n "${HOME:-}" ]; then
  config_home="$HOME/.config"
fi
if [ -n "$config_home" ] && [ -r "$config_home/github-claude-channel/env" ]; then
  # shellcheck disable=SC1090  # user-authored config, path known only at runtime
  . "$config_home/github-claude-channel/env"
fi

# A seam for the test: prove resolution works without starting a stdio server.
if [ "${GITHUB_CHANNEL_MCP_PRINT_BUN:-}" = "1" ]; then
  echo "$bun_bin"
  exit 0
fi

# Run from the plugin directory so package.json / node_modules resolution (and
# bun's automatic .env loading) behave the same regardless of the session's cwd.
cd "$(dirname "$entrypoint")" || {
  echo "github-channel-mcp: cannot cd to $(dirname "$entrypoint")" >&2
  exit 66
}

exec "$bun_bin" "$entrypoint" "$@"
