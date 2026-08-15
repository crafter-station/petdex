#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
binary=$root/zig-out/bin/petdex-desktop-native
fixture=$root/.zig-cache/linux-smoke-fixture
artifacts=$root/.zig-cache/linux-perf-smoke
mode=
duration=

usage() {
    echo "usage: $0 --quick | --soak SECONDS [--binary FILE] [--fixture DIR] [--artifacts DIR]" >&2
}

while [ $# -gt 0 ]; do
    case "$1" in
        --quick) mode=quick; duration=8; shift ;;
        --soak) [ $# -ge 2 ] || { usage; exit 2; }; mode=soak; duration=$2; shift 2 ;;
        --binary) [ $# -ge 2 ] || { usage; exit 2; }; binary=$2; shift 2 ;;
        --fixture) [ $# -ge 2 ] || { usage; exit 2; }; fixture=$2; shift 2 ;;
        --artifacts) [ $# -ge 2 ] || { usage; exit 2; }; artifacts=$2; shift 2 ;;
        *) usage; exit 2 ;;
    esac
done

[ -n "$mode" ] || { usage; exit 2; }
case "$duration" in
    ''|*[!0-9]*|0) usage; exit 2 ;;
esac

mkdir -p "$artifacts"
if [ "$mode" = "quick" ]; then
    workloads="idle static busy rapid"
else
    # The long soak targets settled states. Busy and rapid work remain in the
    # bounded quick profile so a local ten-minute gate does not manufacture a
    # perpetual synthetic workload.
    workloads="idle static"
fi

for workload in $workloads; do
    sh "$root/tests/linux_desktop_smoke.sh" \
        --scenario perf \
        --workload "$workload" \
        --duration "$duration" \
        --artifacts "$artifacts/$workload" \
        --fixture "$fixture" \
        --binary "$binary"
done

jq -n \
    --arg mode "$mode" \
    --argjson duration "$duration" \
    --arg workloads "$workloads" \
    '{status:"pass",mode:$mode,durationSeconds:$duration,workloads:($workloads | split(" "))}' \
    > "$artifacts/summary.json"

echo "linux performance smoke ($mode): PASS"
