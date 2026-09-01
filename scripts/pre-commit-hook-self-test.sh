#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fixture=$(mktemp -d "${TMPDIR:-/tmp}/petdex-pre-commit.XXXXXX")

cleanup() {
    status=$?
    trap - EXIT INT TERM
    rm -rf "$fixture"
    if [ -n "${installer_fixture:-}" ]; then
        rm -rf "$installer_fixture"
    fi
    exit "$status"
}
trap cleanup EXIT INT TERM

mkdir -p "$fixture/bin"
printf '%s\n' \
    '#!/bin/sh' \
    'printf "%s\\n" "$*" >> "$PETDEX_HOOK_TEST_BUN_LOG"' \
    'if [ "$1" = run ] && [ "$2" = check ] && grep -q BROKEN_BIOME sample.ts; then exit 1; fi' \
    >"$fixture/bin/bun"
printf '%s\n' \
    '#!/bin/sh' \
    'printf "%s\\n%s\\n" "$#" "$*" >> "$PETDEX_HOOK_TEST_ZIG_LOG"' \
    'if [ "$1" = fmt ] && [ "$2" = --check ] && grep -q BROKEN "$3"; then exit 1; fi' \
    >"$fixture/bin/zig"
chmod +x "$fixture/bin/bun" "$fixture/bin/zig"

git -C "$fixture" init -q
git -C "$fixture" config user.name 'Petdex Hook Test'
git -C "$fixture" config user.email 'hook-test@petdex.invalid'
mkdir -p "$fixture/.githooks"
printf '%s\n' '#!/bin/sh' 'exit 0' >"$fixture/.githooks/pre-commit"
printf '%s\n' 'const value = 1;' >"$fixture/sample.ts"
printf '%s\n' 'const value: u8 = 1;' >"$fixture/sample.zig"
printf '%s\n' 'const spaced_value: u8 = 2;' >"$fixture/sample space.zig"
printf '%s\n' '#!/bin/sh' 'exit 0' >"$fixture/sample.sh"
printf '%s\n' '#!/bin/sh' 'exit 0' >"$fixture/sample space.sh"
printf '%s\n' '#!/usr/bin/env bash' 'values=(one two)' '[[ ${#values[@]} -eq 2 ]]' >"$fixture/sample-bash.sh"
printf '%s\n' 'value = 1' >"$fixture/sample.py"
printf '%s\n' 'value = 2' >"$fixture/café.py"
newline_shell=$(printf 'sample\nnewline.sh')
printf '%s\n' '#!/bin/sh' 'exit 0' >"$fixture/$newline_shell"
git -C "$fixture" add -- .githooks/pre-commit sample.ts sample.zig 'sample space.zig' sample.sh 'sample space.sh' sample-bash.sh sample.py 'café.py' "$newline_shell"

PETDEX_HOOK_TEST_BUN_LOG=$fixture/bun.log \
PETDEX_HOOK_TEST_ZIG_LOG=$fixture/zig.log \
PATH=$fixture/bin:$PATH \
    sh -c 'cd "$1" && "$2"' sh "$fixture" "$root/.githooks/pre-commit"

grep -qx 'run check -- --vcs-enabled=false' "$fixture/bun.log"
test "$(grep -c '^3$' "$fixture/zig.log")" -eq 2
test "$(grep -c 'fmt --check .*sample.*\.zig$' "$fixture/zig.log")" -eq 2
git -C "$fixture" commit -qm 'fixture baseline'

printf '%s\n' '#!/bin/sh' 'if then' >"$fixture/.githooks/pre-commit"
git -C "$fixture" add .githooks/pre-commit
printf '%s\n' '#!/bin/sh' 'exit 0' >"$fixture/.githooks/pre-commit"
if PETDEX_HOOK_TEST_BUN_LOG=$fixture/bun.log \
    PETDEX_HOOK_TEST_ZIG_LOG=$fixture/zig.log \
    PATH=$fixture/bin:$PATH \
    sh -c 'cd "$1" && "$2"' sh "$fixture" "$root/.githooks/pre-commit" >/dev/null 2>&1; then
    echo "pre-commit self-test: malformed staged hook fixture unexpectedly passed" >&2
    exit 1
fi

git -C "$fixture" add .githooks/pre-commit
printf '%s\n' 'BROKEN_BIOME' >"$fixture/sample.ts"
git -C "$fixture" add sample.ts
printf '%s\n' 'const value = 1;' >"$fixture/sample.ts"
if PETDEX_HOOK_TEST_BUN_LOG=$fixture/bun.log \
    PETDEX_HOOK_TEST_ZIG_LOG=$fixture/zig.log \
    PATH=$fixture/bin:$PATH \
    sh -c 'cd "$1" && "$2"' sh "$fixture" "$root/.githooks/pre-commit" >/dev/null 2>&1; then
    echo "pre-commit self-test: malformed staged Biome fixture unexpectedly passed" >&2
    exit 1
fi

git -C "$fixture" add sample.ts
printf '%s\n' '#!/bin/sh' 'if then' >"$fixture/sample.sh"
git -C "$fixture" add sample.sh
printf '%s\n' '#!/bin/sh' 'exit 0' >"$fixture/sample.sh"
if PETDEX_HOOK_TEST_BUN_LOG=$fixture/bun.log \
    PETDEX_HOOK_TEST_ZIG_LOG=$fixture/zig.log \
    PATH=$fixture/bin:$PATH \
    sh -c 'cd "$1" && "$2"' sh "$fixture" "$root/.githooks/pre-commit" >/dev/null 2>&1; then
    echo "pre-commit self-test: malformed staged shell fixture unexpectedly passed" >&2
    exit 1
fi

git -C "$fixture" add sample.sh
printf '%s\n' 'if True print("broken")' >"$fixture/sample.py"
git -C "$fixture" add sample.py
printf '%s\n' 'value = 1' >"$fixture/sample.py"
if PETDEX_HOOK_TEST_BUN_LOG=$fixture/bun.log \
    PETDEX_HOOK_TEST_ZIG_LOG=$fixture/zig.log \
    PATH=$fixture/bin:$PATH \
    sh -c 'cd "$1" && "$2"' sh "$fixture" "$root/.githooks/pre-commit" >/dev/null 2>&1; then
    echo "pre-commit self-test: malformed staged Python fixture unexpectedly passed" >&2
    exit 1
fi

git -C "$fixture" add sample.py
printf '%s\n' 'BROKEN' >"$fixture/sample.zig"
git -C "$fixture" add sample.zig
printf '%s\n' 'const value: u8 = 1;' >"$fixture/sample.zig"
if PETDEX_HOOK_TEST_BUN_LOG=$fixture/bun.log \
    PETDEX_HOOK_TEST_ZIG_LOG=$fixture/zig.log \
    PATH=$fixture/bin:$PATH \
    sh -c 'cd "$1" && "$2"' sh "$fixture" "$root/.githooks/pre-commit" >/dev/null 2>&1; then
    echo "pre-commit self-test: malformed staged Zig fixture unexpectedly passed" >&2
    exit 1
fi

git -C "$fixture" add sample.zig
git -C "$fixture" rm -q .githooks/pre-commit
PETDEX_HOOK_TEST_BUN_LOG=$fixture/bun.log \
PETDEX_HOOK_TEST_ZIG_LOG=$fixture/zig.log \
PATH=$fixture/bin:$PATH \
    sh -c 'cd "$1" && "$2"' sh "$fixture" "$root/.githooks/pre-commit"

installer_fixture=$(mktemp -d "${TMPDIR:-/tmp}/petdex-hooks-install.XXXXXX")
mkdir -p "$installer_fixture/main/scripts"
git -C "$installer_fixture/main" init -q
git -C "$installer_fixture/main" config user.name 'Petdex Hook Test'
git -C "$installer_fixture/main" config user.email 'hook-test@petdex.invalid'
git -C "$installer_fixture/main" commit --allow-empty -qm 'fixture baseline'
git -C "$installer_fixture/main" worktree add -qb sibling "$installer_fixture/sibling"
git -C "$installer_fixture/main" config --local core.hooksPath .githooks
cp "$root/scripts/install-git-hooks.sh" "$installer_fixture/main/scripts/install-git-hooks.sh"
sh "$installer_fixture/main/scripts/install-git-hooks.sh" >/dev/null
test "$(git -C "$installer_fixture/main" config --worktree --get core.hooksPath)" = .githooks
if git -C "$installer_fixture/sibling" config --get core.hooksPath >/dev/null; then
    echo "pre-commit self-test: hook installer leaked into a sibling worktree" >&2
    exit 1
fi

echo "pre-commit hook self-test: PASS"
