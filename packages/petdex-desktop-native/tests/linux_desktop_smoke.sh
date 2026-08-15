#!/bin/sh
set -eu

SCENARIO=""
ARTIFACTS=""
BINARY="zig-out/bin/petdex-desktop-native"
FIXTURE=""
DURATION=10
PERF_WORKLOAD="busy"
GDK_SCALE_FACTOR=1
SELF_TEST=0
INSIDE_SESSION=0
SMOKE_ROOT=""
APP_PID=""
LAUNCHED_APP_PID=""
XVFB_PID=""
COMPOSITOR_PID=""
FAILURE_REASON="scenario did not complete"
DISCLOSURE_CLICK_INDEX=0

usage() {
    echo "usage: $0 --self-test | --scenario idle|bubble|interaction|perf --artifacts DIR --fixture DIR [--binary FILE] [--duration SECONDS] [--workload idle|static|busy|rapid] [--gdk-scale 1|2]" >&2
}

fail() {
    FAILURE_REASON=$*
    echo "linux desktop smoke: FAIL: $*" >&2
    exit 1
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

stop_pid() {
    target_pid=$1
    if [ -n "$target_pid" ] && kill -0 "$target_pid" 2>/dev/null; then
        kill "$target_pid" 2>/dev/null || true
        wait "$target_pid" 2>/dev/null || true
    fi
}

validate_whoami_pid() {
    whoami_json=$1
    expected_pid=$2
    actual_pid=$(printf '%s' "$whoami_json" | jq -er '.pid') || return 1
    [ "$actual_pid" = "$expected_pid" ]
}

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

find_bubble_popup() {
    xwininfo -root -tree 2>/dev/null | awk '/"petdex-desktop-native":/ && $0 !~ / 1x1[+]/ { print $1; exit }'
}

click_bubble_disclosure() {
    popup_id=$(find_bubble_popup)
    [ -n "$popup_id" ] || return 1
    popup_geometry=$(xdotool getwindowgeometry --shell "$popup_id")
    popup_width=$(printf '%s\n' "$popup_geometry" | awk -F= '$1 == "WIDTH" { print $2; exit }')
    popup_height=$(printf '%s\n' "$popup_geometry" | awk -F= '$1 == "HEIGHT" { print $2; exit }')
    [ -n "$popup_width" ] || return 1
    [ -n "$popup_height" ] || return 1
    # GtkPopover centers the complete popup on the pet, and the portable
    # layout centers the 30px disclosure on that same axis. Click that axis;
    # y follows the current popup height because Hidden mode shrinks the
    # surface to the disclosure envelope.
    disclosure_bottom_inset=$((27 * GDK_SCALE_FACTOR))
    disclosure_x=$((popup_width / 2))
    disclosure_y=$((popup_height - disclosure_bottom_inset))
    DISCLOSURE_CLICK_INDEX=$((DISCLOSURE_CLICK_INDEX + 1))
    {
        printf 'window=%s\nx=%s\ny=%s\n' "$popup_id" "$disclosure_x" "$disclosure_y"
        printf '%s\n' "$popup_geometry"
    } > "$ARTIFACTS/disclosure-click-$DISCLOSURE_CLICK_INDEX.txt"
    # Keep the real button down long enough for one GTK/runtime dispatch.
    # `xdotool click` can post down/up back-to-back before a newly resized
    # popup has committed its first input frame.
    xdotool mousemove --window "$popup_id" "$disclosure_x" "$disclosure_y" mousedown 1
    sleep 0.08
    xdotool mouseup 1
}

cleanup_smoke_root() {
    cleanup_root=$1
    smoke_tmp_parent=${TMPDIR:-/tmp}
    case "$cleanup_root" in
        "$smoke_tmp_parent"/petdex-linux-smoke.*) ;;
        *) return 1 ;;
    esac
    for runtime_mount in "$cleanup_root/runtime/doc" "$cleanup_root/runtime/gvfs"; do
        if command_exists mountpoint && mountpoint -q "$runtime_mount"; then
            command_exists fusermount3 || return 1
            # xdg-document-portal can outlive dbus-run-session by a fraction of
            # a second and still own its FUSE mount. Give that known isolated
            # mount time to detach, nudging it with a normal user unmount; do
            # not broaden cleanup beyond the validated smoke root above.
            unmount_try=0
            while mountpoint -q "$runtime_mount" && [ "$unmount_try" -lt 50 ]; do
                fusermount3 -u "$runtime_mount" >/dev/null 2>&1 || true
                unmount_try=$((unmount_try + 1))
                sleep 0.1
            done
            mountpoint -q "$runtime_mount" && return 1
        fi
    done
    rm -rf "$cleanup_root"
}

write_summary() {
    summary_status=$1
    summary_reason=$2
    summary_app_pid=${LAUNCHED_APP_PID:-0}
    summary_tmp="$ARTIFACTS/summary.json.tmp"
    jq -n \
        --arg scenario "$SCENARIO" \
        --arg workload "$PERF_WORKLOAD" \
        --arg status "$summary_status" \
        --arg reason "$summary_reason" \
        --arg renderer "${PETDEX_SMOKE_GSK_RENDERER:-cairo}" \
        --arg display "${DISPLAY:-}" \
        --argjson gdkScale "$GDK_SCALE_FACTOR" \
        --argjson appPid "$summary_app_pid" \
        '{scenario:$scenario,workload:$workload,status:$status,reason:$reason,renderer:$renderer,display:$display,gdkScale:$gdkScale,appPid:$appPid}' \
        > "$summary_tmp"
    mv "$summary_tmp" "$ARTIFACTS/summary.json"
}

cleanup() {
    cleanup_status=$?
    trap - EXIT INT TERM
    stop_pid "$APP_PID"
    APP_PID=""
    stop_pid "$COMPOSITOR_PID"
    COMPOSITOR_PID=""
    stop_pid "$XVFB_PID"
    XVFB_PID=""
    if [ -n "$ARTIFACTS" ] && [ -d "$ARTIFACTS" ] && [ "$FAILURE_REASON" != "passed" ]; then
        write_summary fail "$FAILURE_REASON"
    fi
    exit "$cleanup_status"
}

on_signal() {
    FAILURE_REASON="received termination signal"
    trap - EXIT INT TERM
    stop_pid "$APP_PID"
    APP_PID=""
    stop_pid "$COMPOSITOR_PID"
    COMPOSITOR_PID=""
    stop_pid "$XVFB_PID"
    XVFB_PID=""
    if [ -n "$ARTIFACTS" ] && [ -d "$ARTIFACTS" ]; then
        write_summary fail "$FAILURE_REASON"
    fi
    exit 143
}

self_test() {
    require_command jq
    self_root=$(mktemp -d "${TMPDIR:-/tmp}/petdex-linux-smoke-self.XXXXXX")
    case "$self_root" in
        "${TMPDIR:-/tmp}"/petdex-linux-smoke-self.*) ;;
        *) fail "self-test temporary directory escaped TMPDIR" ;;
    esac
    chmod 700 "$self_root"
    [ "$(stat -c '%a' "$self_root")" = "700" ] || fail "self-test home is not private"
    mkdir "$self_root/runtime"
    chmod 700 "$self_root/runtime"
    [ "$(stat -c '%a' "$self_root/runtime")" = "700" ] || fail "self-test runtime is not private"

    sleep 30 &
    owned_pid=$!
    sleep 30 &
    unowned_pid=$!
    stop_pid "$owned_pid"
    kill -0 "$unowned_pid" 2>/dev/null || fail "cleanup touched an unrecorded process"
    stop_pid "$unowned_pid"

    if validate_whoami_pid '{"ok":true,"pid":2}' 1; then
        fail "wrong whoami PID passed identity validation"
    fi
    if command_exists petdex-compositor-that-must-not-exist; then
        fail "missing compositor check unexpectedly passed"
    fi

    sentinel="self-test-token-never-log"
    redacted=$(printf 'token=%s' "$sentinel" | sed "s/$sentinel/[redacted]/g")
    case "$redacted" in
        *"$sentinel"*) fail "token redaction self-test failed" ;;
    esac
    rm -rf "$self_root"
    echo "linux desktop smoke self-test: PASS"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --self-test) SELF_TEST=1; shift ;;
        --scenario) [ $# -ge 2 ] || { usage; exit 2; }; SCENARIO=$2; shift 2 ;;
        --artifacts) [ $# -ge 2 ] || { usage; exit 2; }; ARTIFACTS=$2; shift 2 ;;
        --binary) [ $# -ge 2 ] || { usage; exit 2; }; BINARY=$2; shift 2 ;;
        --fixture) [ $# -ge 2 ] || { usage; exit 2; }; FIXTURE=$2; shift 2 ;;
        --duration) [ $# -ge 2 ] || { usage; exit 2; }; DURATION=$2; shift 2 ;;
        --workload) [ $# -ge 2 ] || { usage; exit 2; }; PERF_WORKLOAD=$2; shift 2 ;;
        --gdk-scale) [ $# -ge 2 ] || { usage; exit 2; }; GDK_SCALE_FACTOR=$2; shift 2 ;;
        --inside-session) INSIDE_SESSION=1; shift ;;
        --smoke-root) [ $# -ge 2 ] || { usage; exit 2; }; SMOKE_ROOT=$2; shift 2 ;;
        *) usage; exit 2 ;;
    esac
done

if [ "$SELF_TEST" -eq 1 ]; then
    self_test
    exit 0
fi

case "$SCENARIO" in
    idle|bubble|interaction|perf) ;;
    *) usage; exit 2 ;;
esac
case "$PERF_WORKLOAD" in
    idle|static|busy|rapid) ;;
    *) usage; exit 2 ;;
esac
case "$GDK_SCALE_FACTOR" in
    1|2) ;;
    *) usage; exit 2 ;;
esac
[ -n "$ARTIFACTS" ] || { usage; exit 2; }
[ -n "$FIXTURE" ] || { usage; exit 2; }

require_command realpath
BINARY=$(realpath "$BINARY")
FIXTURE=$(realpath "$FIXTURE")
mkdir -p "$ARTIFACTS"
ARTIFACTS=$(realpath "$ARTIFACTS")
[ -x "$BINARY" ] || fail "binary is not executable: $BINARY"
[ -s "$FIXTURE/pet.json" ] || fail "fixture pet.json is missing"
fixture_sheet=$(jq -er '.spritesheetPath | select(. == "spritesheet.png" or . == "spritesheet.webp")' "$FIXTURE/pet.json") ||
    fail "fixture pet.json has an invalid spritesheetPath"
[ -s "$FIXTURE/$fixture_sheet" ] || fail "fixture spritesheet is missing"

if [ "$INSIDE_SESSION" -eq 0 ]; then
    require_command dbus-run-session
    script_path=$(realpath "$0")
    SMOKE_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/petdex-linux-smoke.XXXXXX")
    smoke_home="$SMOKE_ROOT/home"
    smoke_runtime="$SMOKE_ROOT/runtime"
    mkdir -p "$smoke_home" "$smoke_runtime"
    chmod 700 "$SMOKE_ROOT" "$smoke_home" "$smoke_runtime"
    set +e
    env HOME="$smoke_home" XDG_RUNTIME_DIR="$smoke_runtime" PETDEX_SMOKE_IN_DBUS=1 \
        GIO_USE_VFS=local GIO_USE_VOLUME_MONITOR=unix GTK_USE_PORTAL=0 NO_AT_BRIDGE=1 \
        dbus-run-session -- "$script_path" \
        --inside-session --smoke-root "$SMOKE_ROOT" \
        --scenario "$SCENARIO" --artifacts "$ARTIFACTS" \
        --binary "$BINARY" --fixture "$FIXTURE" --duration "$DURATION" \
        --workload "$PERF_WORKLOAD" --gdk-scale "$GDK_SCALE_FACTOR" \
        2> "$ARTIFACTS/dbus-session.log"
    outer_status=$?
    set -e
    if ! cleanup_smoke_root "$SMOKE_ROOT"; then
        echo "linux desktop smoke: FAIL: isolated runtime cleanup failed" >&2
        if [ "$outer_status" -eq 0 ] && [ -f "$ARTIFACTS/summary.json" ]; then
            jq '.status = "fail" | .reason = "isolated runtime cleanup failed"' \
                "$ARTIFACTS/summary.json" > "$ARTIFACTS/summary.json.tmp"
            mv "$ARTIFACTS/summary.json.tmp" "$ARTIFACTS/summary.json"
        fi
        outer_status=1
    fi
    exit "$outer_status"
fi

trap cleanup EXIT
trap on_signal INT TERM

for required in Xvfb xcompmgr xdpyinfo xsetroot curl jq file readelf ldd busctl ss readlink import identify convert compare tesseract xdotool xwininfo ps awk sed find seq wc; do
    require_command "$required"
done

[ "$(stat -c '%a' "$HOME")" = "700" ] || fail "isolated HOME is not mode 700"
[ "$(stat -c '%a' "$XDG_RUNTIME_DIR")" = "700" ] || fail "isolated runtime directory is not mode 700"
[ -z "$(ss -H -ltn 'sport = :7777' 2>/dev/null)" ] || fail "port 7777 already has a listener"

mkdir -p "$HOME/.petdex/pets/ci-pet"
chmod 700 "$HOME/.petdex" "$HOME/.petdex/pets" "$HOME/.petdex/pets/ci-pet"
cp "$FIXTURE/pet.json" "$HOME/.petdex/pets/ci-pet/pet.json"
cp "$FIXTURE/$fixture_sheet" "$HOME/.petdex/pets/ci-pet/$fixture_sheet"

display_number=${PETDEX_SMOKE_DISPLAY_NUMBER:-95}
DISPLAY=:$display_number
export DISPLAY
Xvfb "$DISPLAY" -screen 0 1280x800x24 +extension Composite -nolisten tcp > "$ARTIFACTS/xvfb.log" 2>&1 &
XVFB_PID=$!
display_ready=0
for _ in $(seq 1 50); do
    if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then display_ready=1; break; fi
    sleep 0.1
done
[ "$display_ready" -eq 1 ] || fail "Xvfb did not become ready"

xsetroot -solid '#697386'
# Normal compositing keeps client alpha without adding xcompmgr's own
# rectangular drop shadows, which would make transparent corners look dark.
xcompmgr -n > "$ARTIFACTS/compositor.log" 2>&1 &
COMPOSITOR_PID=$!
sleep 0.5
kill -0 "$COMPOSITOR_PID" 2>/dev/null || fail "compositor did not stay running"

file "$BINARY" > "$ARTIFACTS/file.txt"
readelf -h "$BINARY" > "$ARTIFACTS/readelf.txt"
ldd "$BINARY" > "$ARTIFACTS/ldd.txt"

renderer=${PETDEX_SMOKE_GSK_RENDERER:-cairo}
PETDEX_PET=ci-pet GSK_RENDERER="$renderer" GDK_SCALE="$GDK_SCALE_FACTOR" \
    PETDEX_PERF_STATS_PATH="$ARTIFACTS/bubble-stats.json" \
    "$BINARY" > "$ARTIFACTS/app.log" 2>&1 &
APP_PID=$!
LAUNCHED_APP_PID=$APP_PID

ready=0
for _ in $(seq 1 100); do
    if kill -0 "$APP_PID" 2>/dev/null && curl -fsS http://127.0.0.1:7777/health >/dev/null 2>&1 && [ -s "$HOME/.petdex/runtime/update-token" ]; then
        ready=1
        break
    fi
    sleep 0.1
done
[ "$ready" -eq 1 ] || fail "app, hook server, or token did not become ready"

whoami_json=$(curl -fsS http://127.0.0.1:7777/whoami)
printf '%s\n' "$whoami_json" > "$ARTIFACTS/whoami.json"
validate_whoami_pid "$whoami_json" "$APP_PID" || fail "whoami PID does not match launched app"

binary_path=$(readlink -f "$BINARY")
process_path=$(readlink -f "/proc/$APP_PID/exe")
[ "$binary_path" = "$process_path" ] || fail "launched process executable does not match requested ELF"
printf '%s\n' "$process_path" > "$ARTIFACTS/process-exe.txt"

busctl --user status dev.petdex.desktop-native --no-pager > "$ARTIFACTS/dbus-status.txt" 2>&1 || fail "D-Bus application name is not owned"
dbus_pid=$(busctl --user --list --no-pager | awk '$1 == "dev.petdex.desktop-native" { print $2; exit }')
[ "$dbus_pid" = "$APP_PID" ] || fail "D-Bus owner PID does not match launched app"

ss -H -ltnp 'sport = :7777' > "$ARTIFACTS/listener.txt"
listener_pid=$(sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' "$ARTIFACTS/listener.txt" | sed -n '1p')
[ "$listener_pid" = "$APP_PID" ] || fail "port 7777 listener PID does not match launched app"

sleep 1
import -window root "$ARTIFACTS/idle.png"
identify "$ARTIFACTS/idle.png" > "$ARTIFACTS/idle-image.txt"
idle_colors=$(convert "$ARTIFACTS/idle.png" -format '%k' info:)
awk -v colors="$idle_colors" 'BEGIN { exit !(colors + 0 > 8) }' || fail "idle screenshot does not contain a visible pet"
transparent_corner_delta=$(convert "$ARTIFACTS/idle.png" \
    -format '%[fx:abs(p{0,0}.r-p{640,400}.r)+abs(p{0,0}.g-p{640,400}.g)+abs(p{0,0}.b-p{640,400}.b)]' info:)
printf '%s\n' "$transparent_corner_delta" > "$ARTIFACTS/transparent-corner-delta.txt"
awk -v delta="$transparent_corner_delta" 'BEGIN { exit !(delta + 0 < 0.04) }' || fail "transparent pet-window corner does not reveal compositor background"
xdotool search --name 'Petdex' getwindowname %@ > "$ARTIFACTS/windows.txt" 2>/dev/null || fail "Petdex window is not visible to X11"

show_bubble=0
if [ "$SCENARIO" = "bubble" ] || [ "$SCENARIO" = "interaction" ]; then
    show_bubble=1
elif [ "$SCENARIO" = "perf" ] && [ "$PERF_WORKLOAD" != "idle" ]; then
    show_bubble=1
fi

if [ "$show_bubble" -eq 1 ]; then
    bubble_busy=true
    bubble_status=running
    if [ "$SCENARIO" = "perf" ] && [ "$PERF_WORKLOAD" = "static" ]; then
        bubble_busy=false
        bubble_status=needs_input
    fi
    update_token=$(cat "$HOME/.petdex/runtime/update-token")
    curl -fsS -o "$ARTIFACTS/bubble-post.json" -X POST \
        -H "x-petdex-update-token: $update_token" \
        -H 'Content-Type: application/json' \
        --data "{\"text\":\"Linux smoke test passed\",\"title\":\"PetDex Dev\",\"session_id\":\"linux-smoke\",\"agent_source\":\"codex\",\"status\":\"$bubble_status\",\"busy\":$bubble_busy}" \
        http://127.0.0.1:7777/bubble || fail "authenticated bubble fixture was rejected"
    update_token=""
    bubble_ready=0
    for _ in $(seq 1 50); do
        curl -fsS http://127.0.0.1:7777/bubble > "$ARTIFACTS/bubble-get.json"
        if jq -e '.text == "Linux smoke test passed"' "$ARTIFACTS/bubble-get.json" >/dev/null; then
            bubble_ready=1
            break
        fi
        sleep 0.1
    done
    [ "$bubble_ready" -eq 1 ] || fail "bubble endpoint never exposed deterministic fixture text"
    sleep 2
    import -window root "$ARTIFACTS/bubble.png"
    identify "$ARTIFACTS/bubble.png" > "$ARTIFACTS/bubble-image.txt"
    xwininfo -root -tree > "$ARTIFACTS/window-tree.txt"
    pixel_delta=$(compare -metric AE "$ARTIFACTS/idle.png" "$ARTIFACTS/bubble.png" null: 2>&1 >/dev/null || true)
    printf '%s\n' "$pixel_delta" > "$ARTIFACTS/bubble-pixel-delta.txt"
    awk -v pixels="$pixel_delta" 'BEGIN { exit !(pixels + 0 > 1000) }' || fail "bubble screenshot did not materially change"
    # GtkPopover/GdkPopup children are not guaranteed to carry an X11 title,
    # so title search is diagnostic only. OCR is the actual readability
    # oracle: a dark rectangle or an empty child surface cannot pass it.
    xdotool search --name 'Petdex Activity' > "$ARTIFACTS/bubble-windows.txt" 2>/dev/null || true
    tesseract "$ARTIFACTS/bubble.png" stdout --psm 11 \
        > "$ARTIFACTS/bubble-ocr.txt" 2> "$ARTIFACTS/tesseract.log" || fail "bubble screenshot OCR failed"
    awk 'index($0, "PetDex Dev") || index($0, "Linux smoke test passed") { found = 1 } END { exit !found }' \
        "$ARTIFACTS/bubble-ocr.txt" || fail "bubble title and text are not readable in the screenshot"
    kill -0 "$APP_PID" 2>/dev/null || fail "app exited while presenting the bubble"
fi

if [ "$SCENARIO" = "interaction" ]; then
    bubble_window=$(find_bubble_popup)
    [ -n "$bubble_window" ] || fail "bubble popup cannot be targeted for X11 interaction"
    printf '%s\n' "$bubble_window" > "$ARTIFACTS/bubble-popup-window.txt"
    xwininfo -id "$bubble_window" -shape > "$ARTIFACTS/bubble-popup-shape.txt"

    # All -> Recent keeps the one deterministic card visible; Recent ->
    # Hidden removes it. Both presses must traverse the popup's alpha-derived
    # input region and the existing canvas icon-button action.
    click_bubble_disclosure || fail "bubble disclosure did not accept the All-to-Recent click"
    sleep 0.4
    click_bubble_disclosure || fail "bubble disclosure did not accept the Recent-to-Hidden click"
    sleep 0.8
    import -window root "$ARTIFACTS/interaction-hidden.png"
    tesseract "$ARTIFACTS/interaction-hidden.png" stdout --psm 11 \
        > "$ARTIFACTS/interaction-hidden-ocr.txt" 2> "$ARTIFACTS/interaction-hidden-tesseract.log" || fail "hidden-state OCR failed"
    if awk 'index($0, "PetDex Dev") || index($0, "Linux smoke test passed") { found = 1 } END { exit !found }' \
        "$ARTIFACTS/interaction-hidden-ocr.txt"; then
        fail "bubble disclosure clicks did not hide the portable card"
    fi

    hidden_delta=$(compare -metric AE "$ARTIFACTS/bubble.png" "$ARTIFACTS/interaction-hidden.png" null: 2>&1 >/dev/null || true)
    printf '%s\n' "$hidden_delta" > "$ARTIFACTS/interaction-hidden-pixel-delta.txt"
    awk -v pixels="$hidden_delta" 'BEGIN { exit !(pixels + 0 > 1000) }' || fail "hidden interaction did not materially change the popup"

    # Hidden -> All proves the small disclosure remains targetable after the
    # popup resizes to its compact envelope.
    click_bubble_disclosure || fail "compact disclosure did not accept the Hidden-to-All click"
    sleep 0.8
    import -window root "$ARTIFACTS/interaction-reopened.png"
    tesseract "$ARTIFACTS/interaction-reopened.png" stdout --psm 11 \
        > "$ARTIFACTS/interaction-reopened-ocr.txt" 2> "$ARTIFACTS/interaction-reopened-tesseract.log" || fail "reopened-state OCR failed"
    awk 'index($0, "PetDex Dev") || index($0, "Linux smoke test passed") { found = 1 } END { exit !found }' \
        "$ARTIFACTS/interaction-reopened-ocr.txt" || fail "compact disclosure did not restore the portable card"
    kill -0 "$APP_PID" 2>/dev/null || fail "app exited during bubble interaction"
fi

if [ "$SCENARIO" = "perf" ]; then
    # This ceiling applies only to the deterministic Xvfb/cairo settled-state
    # workloads. It is deliberately generous relative to the measured 3-6%
    # post-fix samples, but catches the 70-93% cumulative signature of a
    # self-rearming presentation loop. Busy and rapid authored work are not
    # judged by this settled-state ceiling.
    settled_cpu_ceiling=0
    if [ "$PERF_WORKLOAD" = "idle" ] || [ "$PERF_WORKLOAD" = "static" ]; then
        settled_cpu_ceiling=35
    fi
    printf 'elapsed_ms,cpu_percent,rss_kib,threads,fds,voluntary_ctxt,involuntary_ctxt\n' > "$ARTIFACTS/resources.csv"
    sample=0
    while [ "$sample" -lt "$DURATION" ]; do
        if [ "$PERF_WORKLOAD" = "rapid" ]; then
            update_token=$(cat "$HOME/.petdex/runtime/update-token")
            curl -fsS -o /dev/null -X POST \
                -H "x-petdex-update-token: $update_token" \
                -H 'Content-Type: application/json' \
                --data "{\"text\":\"Rapid Linux update $sample\",\"title\":\"PetDex Dev\",\"session_id\":\"linux-smoke\",\"agent_source\":\"codex\",\"status\":\"running\",\"busy\":true}" \
                http://127.0.0.1:7777/bubble
            update_token=""
            rapid_popup=$(find_bubble_popup || true)
            if [ -n "$rapid_popup" ]; then
                rapid_x=$((24 + sample % 80))
                xdotool mousemove --window "$rapid_popup" "$rapid_x" 24 >/dev/null 2>&1 || true
            fi
        fi
        process_sample=$(ps -p "$APP_PID" -o %cpu=,rss=,nlwp= | awk '{$1=$1; print}')
        set -- $process_sample
        cpu=${1:-0}
        rss=${2:-0}
        threads=${3:-0}
        fds=$(find "/proc/$APP_PID/fd" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | awk '{$1=$1; print}')
        voluntary=$(awk '/^voluntary_ctxt_switches:/ {print $2}' "/proc/$APP_PID/status")
        involuntary=$(awk '/^nonvoluntary_ctxt_switches:/ {print $2}' "/proc/$APP_PID/status")
        printf '%s,%s,%s,%s,%s,%s,%s\n' "$((sample * 1000))" "$cpu" "$rss" "$threads" "$fds" "$voluntary" "$involuntary" >> "$ARTIFACTS/resources.csv"
        sample=$((sample + 1))
        sleep 1
    done
    awk -F, -v cpu_ceiling="$settled_cpu_ceiling" '
        NR == 2 {
            min_rss = max_rss = $3
            min_threads = max_threads = $4
            min_fds = max_fds = $5
        }
        NR > 2 {
            if ($3 < min_rss) min_rss = $3
            if ($3 > max_rss) max_rss = $3
            if ($4 < min_threads) min_threads = $4
            if ($4 > max_threads) max_threads = $4
            if ($5 < min_fds) min_fds = $5
            if ($5 > max_fds) max_fds = $5
            last_cpu = $2
        }
        END {
            if (NR < 3) exit 1
            if (max_rss - min_rss > 32768) exit 2
            if (max_threads - min_threads > 8) exit 3
            if (max_fds - min_fds > 8) exit 4
            if (cpu_ceiling > 0 && last_cpu > cpu_ceiling) exit 5
        }
    ' "$ARTIFACTS/resources.csv" || fail "resource growth or settled CPU exceeded the Xvfb/cairo smoke bounds"
    kill -0 "$APP_PID" 2>/dev/null || fail "app exited during performance sampling"
fi

stop_pid "$APP_PID"
APP_PID=""
for _ in $(seq 1 30); do
    [ -z "$(ss -H -ltn 'sport = :7777' 2>/dev/null)" ] && break
    sleep 0.1
done
[ -z "$(ss -H -ltn 'sport = :7777' 2>/dev/null)" ] || fail "hook listener remained after app cleanup"

if [ "$SCENARIO" = "perf" ]; then
    [ -s "$ARTIFACTS/bubble-stats.json" ] || fail "app did not emit aggregate performance counters"
    if [ "$PERF_WORKLOAD" != "idle" ]; then
        jq -e '.nativeSubmissions > 0 and .portableCommits == 0 and .viewGeneration > 1' "$ARTIFACTS/bubble-stats.json" >/dev/null ||
            fail "Linux GTK accessibility snapshots did not track portable bubble updates"
    fi
fi

FAILURE_REASON="passed"
write_summary pass "all assertions passed"
echo "linux desktop smoke ($SCENARIO): PASS"
