#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
git -C "$root" rev-parse --is-inside-work-tree >/dev/null
git -C "$root" config --local core.hooksPath .githooks

configured=$(git -C "$root" config --local --get core.hooksPath)
if [ "$configured" != .githooks ]; then
    echo "install-git-hooks: failed to configure repository-local hooks" >&2
    exit 1
fi

echo "Petdex Git hooks installed for this checkout (.githooks)."
