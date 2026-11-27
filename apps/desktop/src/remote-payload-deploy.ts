/**
 * Remote Linux shell command that extracts a streamed payload archive into a
 * temporary staging directory inside `$HOME/.vibemate`, restores the execute
 * bit on `runtime/node` (Windows `tar` strips POSIX `+x` from NTFS files), and
 * atomically moves `runtime/node` and `app/**` into place via `mv -f`.
 *
 * Staging avoids exposing a partially written or non-executable `runtime/node`
 * (which causes `Permission denied` on concurrent Claude/Codex/Copilot hooks)
 * during reconnects or redeploys.
 */
export const REMOTE_PAYLOAD_DEPLOY_COMMAND = [
  "umask 077;",
  'base="$HOME/.vibemate";',
  'mkdir -p "$base/runtime" "$base/app" &&',
  'stage=$(mktemp -d "$base/.stage.XXXXXX") &&',
  'trap \'rm -rf "$stage"\' EXIT &&',
  'tar -xf - -C "$stage" &&',
  'chmod 700 "$stage/runtime/node" &&',
  'mv -f "$stage/runtime/node" "$base/runtime/node" &&',
  'if [ -d "$stage/app" ]; then',
  '  (cd "$stage/app" &&',
  '    find . -type d -exec sh -c \'set -e; base="$1"; shift; for p do mkdir -p "$base/$p"; done\' _ "$base/app" {} + &&',
  '    find . -type f -exec sh -c \'set -e; base="$1"; shift; for p do mv -f "$p" "$base/$p"; done\' _ "$base/app" {} +);',
  "fi",
].join(" ");
