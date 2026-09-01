#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
git -C "$root" rev-parse --is-inside-work-tree >/dev/null

legacy_hooks_path=$(git -C "$root" config --local --get core.hooksPath || true)
git -C "$root" config --local extensions.worktreeConfig true
if [ "$legacy_hooks_path" = .githooks ]; then
    git -C "$root" config --local --unset-all core.hooksPath
fi
git -C "$root" config --worktree core.hooksPath .githooks

configured=$(git -C "$root" config --worktree --get core.hooksPath)
if [ "$configured" != .githooks ]; then
    echo "install-git-hooks: failed to configure worktree-local hooks" >&2
    exit 1
fi

echo "Petdex Git hooks installed for this checkout (.githooks)."
