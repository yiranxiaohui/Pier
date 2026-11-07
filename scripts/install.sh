#!/usr/bin/env bash
# Install or update Pier on Linux with one command:
#
#   curl -fsSL https://raw.githubusercontent.com/yiranxiaohui/Pier/main/scripts/install.sh | bash
#
# Where raw.githubusercontent.com is unreachable, fetch this script through a mirror instead:
#
#   curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/yiranxiaohui/Pier/main/scripts/install.sh | bash
#
# Downloads the single-file pier of a GitHub release, verifies it against the release's
# SHA256SUMS.txt and its own --version, then installs it as a systemd service plus the pier
# command (`pier install`), or with --portable as the pier command only. Rerun it to update.
# Pier state (~/.pier), pairing, Agent data and project files are never modified or removed.
# Downloads pick the fastest route (GitHub or a mirror) and switch routes, keeping the part
# already downloaded, when one fails, is too slow, or s is pressed.
# Everything runs inside main, so a partially downloaded script does nothing.
set -euo pipefail

PIER_RELEASES=https://github.com/yiranxiaohui/Pier/releases
# Routes: GitHub itself, or a mirror that receives the full GitHub URL as its path. A custom
# route is an https:// prefix ending in a slash.
BUILTIN_ROUTES=(github ghfast gh-proxy ghproxy)
stage=''
download_pid=''
probe_pids=()
keys=false

say() { printf '%s\n' "$*"; }
warn() { printf 'pier-install: %s\n' "$*" >&2; }
fail() { warn "$*"; exit 1; }

usage() {
  cat <<'HELP'
Install or update Pier on Linux (x86_64 / arm64) from GitHub Releases.

  curl -fsSL https://raw.githubusercontent.com/yiranxiaohui/Pier/main/scripts/install.sh | bash
  curl -fsSL https://raw.githubusercontent.com/yiranxiaohui/Pier/main/scripts/install.sh | bash -s -- [options]

Where raw.githubusercontent.com is unreachable, fetch the script through a mirror, e.g.

  curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/yiranxiaohui/Pier/main/scripts/install.sh | bash

(gh-proxy.com and ghproxy.net work the same way.)

Options:
  --version vX.Y.Z   Install this release instead of the latest one
  --service          Install the background service and the pier command
                     (the default, except on a graphical desktop)
  --portable         Install only the pier command, without a service
                     (the default on a graphical desktop)
  --user | --system  Service scope (default: user for ordinary accounts, system for root)
  --no-start         Install the service without starting it
  --mirror ROUTE     Download route. auto (the default) measures GitHub and the mirrors,
                     uses the fastest and switches when one fails or is too slow; github,
                     ghfast, gh-proxy, ghproxy or another https:// mirror prefix starts
                     with that route and stays on it
  --force            Reinstall even when this version is already installed
  -h, --help         Show this help

While downloading in a terminal, press s to switch to the next route; the part already
downloaded is kept. Checksums always come from GitHub when it answers.
Rerunning the installer updates Pier. An installed service also updates with: pier update
Environment: PIER_VERSION and PIER_MIRROR preset --version and --mirror; PIER_PREFIX and
PIER_DIR choose the installation prefix and the Pier state directory (default ~/.pier).
HELP
}

cleanup() {
  local pid
  for pid in ${download_pid:+"$download_pid"} ${probe_pids[@]+"${probe_pids[@]}"}; do kill "$pid" 2>/dev/null || true; done
  if [[ -n "$stage" ]]; then rm -rf -- "$stage"; fi
}

# fetch <url> <file> [quick]: a small file; quick fails fast and quietly, for an optional source.
fetch() {
  local url=$1 file=$2 how=${3:-} args
  if [[ "$fetcher" == curl ]]; then
    args=(--proto '=https' --proto-redir '=https' --fail --location --silent)
    if [[ "$how" == quick ]]; then args+=(--connect-timeout 10 --max-time 60)
    else args+=(--show-error --retry 3 --connect-timeout 20 --max-time 120); fi
    curl "${args[@]}" --output "$file" "$url"
  else
    args=(--quiet)
    if [[ "$how" == quick ]]; then args+=(--tries=1 --timeout=10); else args+=(--tries=3 --timeout=60); fi
    wget "${args[@]}" -O "$file" "$url" || { rm -f -- "$file"; return 1; }
  fi
}

# route_url <route> <GitHub URL>
route_url() {
  case "$1" in
    github) printf '%s' "$2" ;;
    ghfast) printf 'https://ghfast.top/%s' "$2" ;;
    gh-proxy) printf 'https://gh-proxy.com/%s' "$2" ;;
    ghproxy) printf 'https://ghproxy.net/%s' "$2" ;;
    *) printf '%s%s' "$1" "$2" ;;
  esac
}

route_name() {
  case "$1" in
    github) printf 'GitHub' ;;
    ghfast) printf 'GHFast' ;;
    gh-proxy) printf 'GH-Proxy' ;;
    ghproxy) printf 'GHProxy' ;;
    *) printf '%s' "$1" ;;
  esac
}

route_where() {
  if [[ "$1" == github ]]; then printf 'from GitHub'; else printf 'through %s' "$(route_name "$1")"; fi
}

speed_text() {
  awk -v s="$1" 'BEGIN {
    if (s <= 0) print "failed"; else if (s >= 1048576) printf "%.1f MB/s\n", s / 1048576; else printf "%d KB/s\n", (s + 1023) / 1024
  }'
}

# kept_text <file>: ", keeping 12.3 MB" for the part of a download already in <file>.
kept_text() {
  local bytes=0
  [[ ! -s "$1" ]] || bytes=$(wc -c <"$1")
  awk -v b="$bytes" 'BEGIN { if (b > 0) printf ", keeping %.1f MB", b / 1048576 }'
}

# probe <url> <seconds>: bytes per second once data flows, over up to 4 MiB of the file, so
# a slow redirect or TLS setup does not hide the bandwidth; 0 when under 256 KiB arrived.
probe() {
  local result
  result=$(curl --proto '=https' --proto-redir '=https' --fail --location --silent --range 0-4194303 \
    --connect-timeout 5 --max-time "$2" --output /dev/null \
    --write-out '%{size_download} %{time_starttransfer} %{time_total}' "$1" 2>/dev/null) || true
  awk -v r="$result" 'BEGIN {
    split(r, a, " "); t = a[3] - a[2]; if (t < 0.1) t = 0.1
    print (a[1] + 0 >= 262144 ? int(a[1] / t) : 0)
  }'
}

# rank_routes <GitHub URL> <whether GitHub answered>: order routes by measured speed. A
# GitHub faster than 2 MB/s is used without contacting the mirrors; unusable routes stay
# last, in their order.
rank_routes() {
  local url=$1 github_ok=$2 i speed order report=()
  local -a speeds=()
  for i in "${!routes[@]}"; do speeds[i]=0; done
  if "$github_ok"; then
    speeds[0]=$(probe "$(route_url github "$url")" 5)
    if (( speeds[0] >= 2097152 )); then
      say "Route speed: GitHub $(speed_text "${speeds[0]}")"
      return 0
    fi
  fi
  for i in "${!routes[@]}"; do
    [[ "${routes[i]}" != github ]] || continue
    probe "$(route_url "${routes[i]}" "$url")" 5 >"$stage/probe.$i" &
    probe_pids+=("$!")
  done
  wait ${probe_pids[@]+"${probe_pids[@]}"} || true
  probe_pids=()
  for i in "${!routes[@]}"; do
    if [[ "${routes[i]}" != github ]]; then
      speed=$(cat "$stage/probe.$i" 2>/dev/null || true)
      [[ "$speed" =~ ^[0-9]+$ ]] || speed=0
      speeds[i]=$speed
    fi
    report+=("$(route_name "${routes[i]}") $(speed_text "${speeds[i]}")")
  done
  printf -v speed '%s, ' "${report[@]}"
  say "Route speed: ${speed%, }"
  order=$(for i in "${!routes[@]}"; do printf '%s %s\n' "${speeds[i]}" "$i"; done | sort -k1,1nr -k2,2n | awk '{ print $2 }')
  local -a ranked=()
  for i in $order; do ranked+=("${routes[i]}"); done
  routes=("${ranked[@]}")
}

# download <url> <file> <slow|stall>: continue the download in <file>, aborting when it is
# slower than 100 KB/s for 20 s (slow) or stalls for a minute. Returns 0 when complete,
# 2 when s was pressed to switch routes, 3 when the route cannot resume, else the error.
download() {
  local url=$1 file=$2 floor=$3 args pid key status
  if [[ "$fetcher" == curl ]]; then
    args=(--proto '=https' --proto-redir '=https' --fail --location --connect-timeout 20 --continue-at -)
    if [[ "$floor" == slow ]]; then args+=(--speed-limit 102400 --speed-time 20); else args+=(--speed-limit 1024 --speed-time 60); fi
    if [[ -t 2 ]]; then args+=(--progress-bar); else args+=(--silent --show-error); fi
    curl "${args[@]}" --output "$file" "$url" &
  else
    args=(--quiet --continue --tries=1 --timeout=60)
    if [[ -t 2 && "$(wget --help 2>&1)" == *--show-progress* ]]; then args+=(--show-progress); fi
    wget "${args[@]}" -O "$file" "$url" &
  fi
  pid=$!
  download_pid=$pid
  while "$keys" && kill -0 "$pid" 2>/dev/null; do
    if IFS= read -rsn1 -t 1 key <&3; then
      [[ "$key" == [sS] ]] || continue
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      download_pid=''
      printf '\n' >&2
      return 2
    elif (( $? <= 128 )); then
      keys=false # The terminal went away; just wait.
    fi
  done
  if wait "$pid"; then status=0; else status=$?; fi
  download_pid=''
  if [[ "$fetcher" == curl && "$status" == 33 ]]; then return 3; fi
  return "$status"
}

sha256_of() {
  if [[ "$hasher" == sha256sum ]]; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{ print tolower($1) }'
}

# sum_of <SHA256SUMS.txt> <asset>: its checksum, if listed.
sum_of() { awk -v name="$2" '{ f = $2; sub(/^\*/, "", f); if (f == name) { print tolower($1); exit } }' "$1"; }

# json_value <file> <key>: a string or number value from Pier's pretty-printed JSON files.
json_value() {
  [[ -f "$1" ]] || return 0
  awk -v key="\"$2\"" '{
    i = index($0, key ":"); if (!i) next
    v = substr($0, i + length(key) + 1); sub(/^[ \t]*"?/, "", v); sub(/"?[ \t]*,?[ \t\r]*$/, "", v)
    print v; exit
  }' "$1"
}

systemd_available() {
  command -v systemctl >/dev/null 2>&1 || return 1
  if [[ "$1" == user ]]; then systemctl --user show-environment; else systemctl show-environment; fi </dev/null >/dev/null 2>&1
}

linger() { loginctl show-user "$1" -p Linger --value </dev/null 2>/dev/null || true; }

# A user service stops at logout and waits for a login unless the account lingers. Turn it on
# when that needs no password (polkit or passwordless sudo); pier install already prints how.
enable_linger() {
  local user
  user=$(id -un)
  command -v loginctl >/dev/null 2>&1 || return 0
  [[ "$(linger "$user")" != yes ]] || return 0
  loginctl enable-linger "$user" </dev/null >/dev/null 2>&1 \
    || { command -v sudo >/dev/null 2>&1 && sudo -n loginctl enable-linger "$user" </dev/null >/dev/null 2>&1; } \
    || true
  if [[ "$(linger "$user")" == yes ]]; then
    say "Enabled lingering for $user: Pier keeps running after logout and starts at boot."
  fi
}

# path_hint <command>: how to reach the installed command when PATH does not lead to it.
path_hint() {
  local dir=${1%/*} found
  case ":$PATH:" in
    *":$dir:"*) ;;
    *) say "  Add $dir to PATH to run pier directly: export PATH=\"$dir:\$PATH\""; return 0 ;;
  esac
  found=$(command -v pier 2>/dev/null || true)
  if [[ -n "$found" && "$found" != "$1" ]]; then
    say "  Note: pier currently runs $found; use $1, or put $dir earlier in PATH."
  fi
}

main() {
  local version=${PIER_VERSION:-latest} mirror_option=${PIER_MIRROR:-} mode='' scope='' start=true force=false
  local service_option=false auto_portable=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --version) [[ $# -ge 2 ]] || fail '--version requires a release, for example v0.2.57'; version=$2; shift ;;
      --version=*) version=${1#*=} ;;
      --mirror) [[ $# -ge 2 ]] || fail '--mirror requires auto, github, ghfast, gh-proxy, ghproxy or an https:// prefix'; mirror_option=$2; shift ;;
      --mirror=*) mirror_option=${1#*=} ;;
      --service|--portable)
        [[ -z "$mode" || "$mode" == "${1#--}" ]] || fail 'Choose either --service or --portable'
        mode=${1#--} ;;
      --user|--system)
        [[ -z "$scope" || "$scope" == "${1#--}" ]] || fail 'Choose either --user or --system'
        scope=${1#--}; service_option=true ;;
      --no-start) start=false; service_option=true ;;
      --force) force=true ;;
      -h|--help) usage; return 0 ;;
      *) fail "Unknown option: $1 (see --help)" ;;
    esac
    shift
  done
  if [[ "$mode" == portable ]] && "$service_option"; then
    fail '--portable installs no service; it cannot be combined with --user, --system or --no-start'
  fi

  case "$(uname -s)" in
    Linux) ;;
    Darwin) fail "This installer is for Linux. On macOS, install the .dmg from $PIER_RELEASES/latest" ;;
    *) fail "This installer is for Linux. Download Pier for this system from $PIER_RELEASES/latest" ;;
  esac
  local machine arch
  machine=$(uname -m)
  case "$machine" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) fail "Unsupported architecture: $machine (Pier runs on x86_64 and arm64)" ;;
  esac
  [[ "${HOME:-}" == /* ]] || fail 'HOME must be set to an absolute path'
  for tool in awk mktemp; do command -v "$tool" >/dev/null 2>&1 || fail "Missing command: $tool"; done
  if command -v curl >/dev/null 2>&1; then fetcher=curl
  elif command -v wget >/dev/null 2>&1; then fetcher=wget
  else fail 'Install curl or wget first'; fi
  if command -v sha256sum >/dev/null 2>&1; then hasher=sha256sum
  elif command -v shasum >/dev/null 2>&1; then hasher=shasum
  else fail 'Install sha256sum (coreutils) first'; fi

  if [[ "$version" != latest ]]; then
    [[ "$version" == v* ]] || version=v$version
    [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || fail "Invalid version: $version (expected vX.Y.Z)"
  fi
  # auto ranks every route; a chosen route comes first and the others stay for pressing s.
  local pinned=''
  local -a routes=()
  case "$mirror_option" in
    ''|auto) ;;
    github|ghfast|gh-proxy|ghproxy) pinned=$mirror_option ;;
    *://*)
      [[ "$mirror_option" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$ ]] \
        || fail "Invalid mirror: $mirror_option (an https:// prefix without credentials, query or fragment)"
      pinned=${mirror_option%"${mirror_option##*[!/]}"}/ ;;
    *) fail "Unknown mirror: $mirror_option (use auto, github, ghfast, gh-proxy, ghproxy or an https:// prefix)" ;;
  esac
  [[ -z "$pinned" ]] || routes=("$pinned")
  for candidate in "${BUILTIN_ROUTES[@]}"; do
    [[ "$candidate" == "$pinned" ]] || routes+=("$candidate")
  done

  # The same layout and precedence as `pier install`, to find what is already installed.
  local uid prefix=${PIER_PREFIX:-${PIER_HOST_PREFIX:-}} install_dir legacy_dir service_bin portable_bin
  uid=$(id -u)
  if [[ -z "$scope" ]]; then
    if [[ "$uid" == 0 ]]; then scope=system; else scope=user; fi
  fi
  [[ "$scope" != system || "$uid" == 0 ]] || fail '--system requires root; pipe the installer to sudo bash'
  [[ -z "$prefix" || "$prefix" == /* ]] || fail 'PIER_PREFIX must be an absolute path'
  if [[ "$scope" == user ]]; then
    install_dir=${prefix:-$HOME/.local}/share/pier
    legacy_dir=${prefix:-$HOME/.local}/share/pier-host
    service_bin=${prefix:-$HOME/.local}/bin/pier
  else
    install_dir=${prefix:-/opt/pier}
    legacy_dir=${prefix:-/opt/pier-host}
    service_bin=/usr/local/bin/pier
  fi
  if [[ -n "$prefix" ]]; then portable_bin=$prefix/bin/pier
  elif [[ "$uid" == 0 ]]; then portable_bin=/usr/local/bin/pier
  else portable_bin=$HOME/.local/bin/pier; fi
  local metadata='' installed_version='' graphical=false
  for candidate in "$install_dir/installation.json" "$legacy_dir/installation.json"; do
    if [[ -f "$candidate" ]]; then metadata=$candidate; break; fi
  done
  [[ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] || graphical=true
  # Keep what is installed; otherwise a desktop gets only the command, since its window
  # and a background service cannot share the Pier state directory at the same time.
  if [[ -z "$mode" ]]; then
    if "$service_option" || [[ -n "$metadata" || -f "$legacy_dir/install.env" ]]; then mode=service
    elif [[ -f "$portable_bin" && ! -L "$portable_bin" ]]; then mode=portable
    elif "$graphical"; then mode=portable; auto_portable=true
    else mode=service; fi
  fi

  local state=${PIER_HOST_STATE_DIR:-${PIER_DIR:-$HOME/.pier}} pid reported
  if [[ "$mode" == service ]]; then
    if [[ -f "$legacy_dir/install.env" ]]; then
      fail "$(printf '%s\n' \
        "Found a Pier Host installed by the old install-host.sh in $legacy_dir." \
        'Remove it first (Pier data and pairing are kept), then rerun this installer:' \
        '  pier-host uninstall')"
    fi
    [[ -z "$metadata" ]] || installed_version=$(json_value "$metadata" version)
    if [[ -z "$metadata" ]]; then
      if [[ -e "$service_bin" && ! -L "$service_bin" ]]; then
        fail "$service_bin already exists and was not installed by pier install. Remove it (rm $service_bin), or keep it with --portable"
      fi
      pid=$(json_value "$state/run/host.json" pid)
      if [[ "$pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$pid" 2>/dev/null; then
        fail "A Pier Host is already running with $state (the Pier desktop app or pier run). Quit it first, or install only the command with --portable"
      fi
    fi
  elif [[ -L "$portable_bin" ]]; then
    fail "$portable_bin belongs to an installed Pier service; rerun without --portable to update it"
  elif [[ -e "$portable_bin" ]]; then
    reported=$("$portable_bin" --version </dev/null 2>/dev/null || true)
    reported=${reported%%$'\n'*}
    [[ "$reported" =~ ^pier(-host)?\ [0-9] ]] || fail "Will not overwrite $portable_bin: it is not a Pier executable"
    installed_version=${reported#* }
  fi

  # Stage in the user's cache rather than /tmp, which is often a small tmpfs or noexec.
  local cache=${XDG_CACHE_HOME:-}
  [[ "$cache" == /* ]] || cache=$HOME/.cache
  mkdir -p -- "$cache" || fail "Cannot create $cache"
  stage=$(mktemp -d "$cache/pier-install.XXXXXX") || fail "Cannot create a temporary directory in $cache"
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  local sums=$stage/SHA256SUMS.txt sums_url release sums_from=''
  if [[ "$version" == latest ]]; then
    sums_url=$PIER_RELEASES/latest/download/SHA256SUMS.txt; release='the latest release'
  else
    sums_url=$PIER_RELEASES/download/$version/SHA256SUMS.txt; release=$version
  fi
  # Checksums come from GitHub itself whenever it answers, so a mirror only relays the file.
  local -a sums_routes=(github)
  if [[ -z "$pinned" ]]; then sums_routes+=(ghfast gh-proxy ghproxy)
  elif [[ "$pinned" != github ]]; then sums_routes+=("$pinned"); fi
  local last=$(( ${#sums_routes[@]} - 1 )) n how
  for (( n = 0; n <= last; n++ )); do
    how=''
    if (( n < last )); then how=quick; fi
    if fetch "$(route_url "${sums_routes[n]}" "$sums_url")" "$sums" "$how"; then sums_from=${sums_routes[n]}; break; fi
  done
  if [[ -z "$sums_from" ]]; then
    case "$pinned" in
      '') fail "Could not download the checksums of $release from GitHub or its mirrors. Check the network and the version" ;;
      github) fail "Could not download the checksums of $release from GitHub. Check the network and the version, or leave out --mirror github to try the mirrors" ;;
      *) fail "Could not download the checksums of $release from GitHub or through $(route_name "$pinned")" ;;
    esac
  fi
  if [[ "$sums_from" != github ]]; then warn "GitHub did not answer, so the checksums came through $(route_name "$sums_from")"; fi

  local asset='' tag checksum
  if [[ "$version" == latest ]]; then
    asset=$(awk -v suffix="-linux-$arch" '{
      f = $2; sub(/^\*/, "", f); n = length(f) - length(suffix)
      if (f ~ /^pier-v[0-9]+\.[0-9]+\.[0-9]+/ && n > 0 && substr(f, n + 1) == suffix) print f
    }' "$sums")
    [[ -n "$asset" && "$asset" != *$'\n'* ]] || fail "The latest release has no single-file Pier for linux-$arch"
    tag=${asset#pier-}
    tag=${tag%-linux-"$arch"}
  else
    tag=$version
    for name in "pier-$tag-linux-$arch" "pier-host-$tag-linux-$arch"; do
      if [[ -n "$(sum_of "$sums" "$name")" ]]; then asset=$name; break; fi
    done
    [[ -n "$asset" ]] || fail "Pier $tag has no single file for linux-$arch; choose another version"
  fi
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || fail "Unexpected release asset: $asset"
  checksum=$(sum_of "$sums" "$asset")
  [[ "$checksum" =~ ^[0-9a-f]{64}$ ]] || fail "Invalid checksum for $asset"

  local target=${tag#v}
  if ! "$force" && [[ "$installed_version" == "$target" ]]; then
    if [[ "$mode" == service ]]; then
      say "Pier $tag is already installed ($scope service). Check it with: pier status (--force reinstalls)"
    else
      say "Pier $tag is already installed: $portable_bin (--force reinstalls)"
    fi
    return 0
  fi

  local asset_url=$PIER_RELEASES/download/$tag/$asset github_ok=false
  [[ "$sums_from" != github ]] || github_ok=true
  if [[ -z "$pinned" ]]; then
    if [[ "$fetcher" == curl ]]; then rank_routes "$asset_url" "$github_ok"
    elif ! "$github_ok"; then routes=(ghfast gh-proxy ghproxy github); fi
  fi
  # A key press switches routes; it needs the terminal, which is not stdin under curl | bash.
  if [[ -t 2 ]] && { exec 3</dev/tty; } 2>/dev/null; then keys=true; fi

  local count=${#routes[@]} i=0 failures=0 limit=3 status reason floor current
  # auto tries each route quickly once, then again waiting out slow ones; a chosen route retries.
  [[ -n "$pinned" ]] || limit=$(( 2 * count ))
  if [[ -n "$installed_version" ]]; then say "Updating Pier $installed_version to $target (linux-$arch) $(route_where "${routes[0]}")..."
  else say "Downloading Pier $tag (linux-$arch) $(route_where "${routes[0]}")..."; fi
  if "$keys"; then say '  Press s to switch to another route; the part already downloaded is kept.'; fi
  while :; do
    current=${routes[i]}
    floor=stall
    if [[ -z "$pinned" ]] && (( failures < count - 1 )); then floor=slow; fi
    if download "$(route_url "$current" "$asset_url")" "$stage/pier" "$floor"; then break; else status=$?; fi
    if (( status == 2 )); then
      i=$(( (i + 1) % count ))
      say "Switching to $(route_name "${routes[i]}")$(kept_text "$stage/pier")..."
      continue
    fi
    if (( status == 3 )); then
      warn "$(route_name "$current") cannot continue a partial download; starting over"
      rm -f -- "$stage/pier"
      continue
    fi
    failures=$(( failures + 1 ))
    if (( failures >= limit )); then
      if [[ -z "$pinned" ]]; then fail "Downloading $asset failed on every route; nothing was changed. Check the network and retry"; fi
      fail "Downloading $asset $(route_where "$current") failed; nothing was changed. Retry, or leave out --mirror to try every route"
    fi
    [[ -n "$pinned" ]] || i=$(( (i + 1) % count ))
    if (( status == 28 )); then reason='was too slow'; else reason="failed (exit $status)"; fi
    if [[ "${routes[i]}" == "$current" ]]; then
      warn "$(route_name "$current") $reason; retrying$(kept_text "$stage/pier")"
    else
      warn "$(route_name "$current") $reason; continuing through $(route_name "${routes[i]}")$(kept_text "$stage/pier")"
    fi
  done
  if "$keys"; then exec 3<&-; keys=false; fi
  [[ "$(sha256_of "$stage/pier")" == "$checksum" ]] || fail "Checksum mismatch for $asset; nothing was changed"
  chmod 755 "$stage/pier"
  if ! reported=$("$stage/pier" --version </dev/null 2>"$stage/version.log"); then
    fail "The downloaded Pier does not start here ($(head -c 300 "$stage/version.log")). If $cache is mounted noexec, set XDG_CACHE_HOME to another directory"
  fi
  [[ "$reported" == "pier $target" || "$reported" == "pier-host $target" ]] \
    || fail "Version check failed: expected pier $target, got '${reported%%$'\n'*}'"

  if [[ "$mode" == service ]]; then
    local args=(install "--$scope") no_manager=false
    if "$start" && ! systemd_available "$scope"; then start=false; no_manager=true; fi
    "$start" || args+=(--no-start)
    "$stage/pier" "${args[@]}" </dev/null || fail 'pier install failed (see above)'
    if "$no_manager"; then
      warn 'No systemd manager answers for this account, so the service was installed without starting.'
      warn 'Start it from a login session with: pier start, or run Pier in the foreground with: pier run'
    fi
    if [[ "$scope" == user ]] && "$start"; then enable_linger; fi
    say "Pier $tag is ready."
    say '  Pair a device: run pier, then /remote on and /pair; paste the link into the Pier app, then /pair yes'
    say '  Manage it:     pier status | logs | update | stop | uninstall'
    if "$graphical"; then
      say '  Before opening the Pier window here (pier desktop), run pier stop: both use the same Pier state.'
    fi
    path_hint "$service_bin"
  else
    local dir=${portable_bin%/*} next
    mkdir -p -- "$dir" || fail "Cannot create $dir"
    next=$(mktemp "$dir/.pier.XXXXXX") || fail "Cannot write to $dir"
    # Move into the same directory first, so the final rename never leaves a partial pier.
    if ! { mv -f -- "$stage/pier" "$next" && chmod 755 "$next" && mv -f -- "$next" "$portable_bin"; }; then
      rm -f -- "$next"
      fail "Could not install $portable_bin"
    fi
    say "Installed Pier $tag: $portable_bin"
    say '  Open Pier: pier (the window on a graphical desktop, the CLI in a terminal)'
    say '  Update:    rerun this installer'
    if "$auto_portable"; then
      say '  A graphical desktop was found, so no background service was installed; rerun with --service for one.'
    fi
    path_hint "$portable_bin"
  fi
}

main "$@"
