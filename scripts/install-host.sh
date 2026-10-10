#!/usr/bin/env bash
# Linux headless installer. Run as the account that will own Agent sessions.
set -euo pipefail
umask 077

fail() { echo "pier-host: $*" >&2; exit 1; }
scope=auto
version=latest
start=true
local_install=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) scope=user ;;
    --system) scope=system ;;
    --version) [[ $# -ge 2 ]] || fail '--version requires a tag'; version=$2; shift ;;
    --no-start) start=false ;;
    --local) local_install=true ;;
    -h|--help)
      cat <<'HELP'
Install Pier Host on Linux, including its CLI and systemd service.
Usage: bash install-host.sh [--user|--system] [--version vX.Y.Z] [--no-start] [--local]
Default: user service for ordinary users, system service for root.
--no-start installs the service without enabling or starting it.
--local installs the already downloaded, extracted Host bundle beside this script.
PIER_HOST_PREFIX overrides ~/.local (user) or /opt/pier-host (system).
PIER_HOST_STATE_DIR overrides ~/.pier. Uninstall keeps it unless --purge is given.
HELP
      exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
  shift
done
[[ $(uname -s) == Linux ]] || fail 'Only Linux is supported.'
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) fail 'Supported architectures: x86_64 and arm64.' ;;
esac
if [[ "$scope" == auto ]]; then
  if [[ $(id -u) == 0 ]]; then scope=system; else scope=user; fi
fi
[[ "$scope" != system || $(id -u) == 0 ]] || fail '--system requires root.'
for tool in tar sha256sum systemctl realpath readlink; do command -v "$tool" >/dev/null || fail "Missing command: $tool"; done
if ! "$local_install"; then command -v curl >/dev/null || fail 'Missing command: curl'; fi

if [[ "$scope" == user ]]; then
  prefix=${PIER_HOST_PREFIX:-$HOME/.local}
  install_dir="$prefix/share/pier-host"
  bin_dir="$prefix/bin"
  service_file="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/pier-host.service"
  target=default.target
else
  prefix=${PIER_HOST_PREFIX:-/opt/pier-host}
  install_dir=$prefix
  bin_dir=/usr/local/bin
  service_file=/etc/systemd/system/pier-host.service
  target=multi-user.target
fi
prefix=$(realpath -m -- "$prefix")
install_dir=$(realpath -m -- "$install_dir")
bin_dir=$(realpath -m -- "$bin_dir")
state_dir=$(realpath -m -- "${PIER_HOST_STATE_DIR:-${PIER_DIR:-$HOME/.pier}}")
for path in "$prefix" "$install_dir" "$bin_dir" "$state_dir" "$service_file" "$HOME" "$PATH"; do
  [[ "$path" != *$'\n'* && "$path" != *$'\r'* ]] || fail 'Newlines are not supported in installation paths.'
done
[[ "$install_dir" != / && "$install_dir" != "$HOME" ]] || fail 'Unsafe installation directory.'
[[ ! -e "$install_dir" || -f "$install_dir/install.env" ]] || fail "Directory is not a managed installation: $install_dir"
for name in pier-host pier-cli; do
  link="$bin_dir/$name"
  if [[ -e "$link" || -L "$link" ]]; then
    [[ -L "$link" && "$(readlink -f -- "$link")" == "$install_dir/"* ]] || fail "Will not overwrite $link"
  fi
done
if [[ -e "$service_file" && ! -f "$install_dir/install.env" ]]; then fail "Will not overwrite $service_file"; fi
if [[ -f "$install_dir/install.env" ]]; then
  # Keep the identity/data directory across updates, even if PIER_DIR changed in the shell.
  saved_state=$(bash -c 'source "$1"; printf "%s" "$STATE_DIR"' _ "$install_dir/install.env")
  [[ "$saved_state" == "$state_dir" ]] || fail "Existing state directory is $saved_state; keep it when updating."
fi

service() { if [[ "$scope" == user ]]; then systemctl --user "$@"; else systemctl "$@"; fi; }
if "$start"; then service show-environment >/dev/null || fail 'No systemd manager; use --no-start, or enable the user manager with loginctl enable-linger.'; fi
task_tmp=$(mktemp -d)
trap 'rm -rf -- "$task_tmp"' EXIT
download() { curl --proto '=https' --proto-redir '=https' --fail --location --silent --show-error --retry 3 --connect-timeout 20 --max-time 600 "$1" -o "$2"; }
repo=https://github.com/yiranxiaohui/Pier
install_url=https://raw.githubusercontent.com/yiranxiaohui/Pier/main/scripts/install-host.sh
if "$local_install"; then
  script_path=${BASH_SOURCE[0]:-}
  [[ -n "$script_path" ]] || fail '--local requires the script from an extracted Host archive.'
  payload=$(cd -- "$(dirname -- "$script_path")" && pwd)
  [[ -f "$payload/VERSION" && -f "$payload/PLATFORM" ]] || fail 'No Host bundle found beside the installer.'
  bundle_version=$(cat "$payload/VERSION")
  [[ "$version" == latest || "$version" == "$bundle_version" ]] || fail 'Requested version does not match the local bundle.'
  version=$bundle_version
  [[ $(cat "$payload/PLATFORM") == "linux-$arch" ]] || fail 'Local bundle architecture does not match this computer.'
  [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[[:alnum:].-]+)?$ ]] || fail "Invalid bundle version: $version"
  echo "Installing downloaded Pier Host $version (linux-$arch)..."
else
  if [[ "$version" == latest ]]; then
    download https://api.github.com/repos/yiranxiaohui/Pier/releases/latest "$task_tmp/release.json"
    version=$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$task_tmp/release.json" | head -n 1)
  fi
  [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[[:alnum:].-]+)?$ ]] || fail "Invalid version tag: $version"
  asset="pier-host-$version-linux-$arch.tar.gz"
  base="$repo/releases/download/$version"
  download "$base/SHA256SUMS.txt" "$task_tmp/SHA256SUMS.txt"
  checksum=$(awk -v asset="$asset" '$2 == asset || $2 == "*" asset { print $1 }' "$task_tmp/SHA256SUMS.txt")
  [[ -n "$checksum" ]] || fail "No standalone Host archive for $version (linux-$arch). Choose v0.2.35 or later."
  [[ "$checksum" =~ ^[0-9a-fA-F]{64}$ ]] || fail 'Invalid release checksum.'
  echo "Downloading Pier Host $version (linux-$arch)..."
  download "$base/$asset" "$task_tmp/$asset"
  printf '%s  %s\n' "$checksum" "$asset" > "$task_tmp/checksum"
  (cd "$task_tmp" && sha256sum --check --status checksum) || fail 'Archive checksum mismatch; existing installation was kept.'
  payload="$task_tmp/payload"
  mkdir -p "$payload"
  tar -xzf "$task_tmp/$asset" -C "$payload" --no-same-owner
fi
for file in pier-host pier-cli manage.sh package.json photon_rs_bg.wasm; do [[ -f "$payload/$file" ]] || fail "Missing archive file: $file"; done
chmod 755 "$payload/pier-host" "$payload/pier-cli" "$payload/manage.sh"
"$payload/pier-host" --help >/dev/null
"$payload/pier-cli" --help >/dev/null
bash -n "$payload/manage.sh"

# Finish verifying the bundle before touching an existing service or installation.
mkdir -p "$install_dir" "$bin_dir" "$(dirname -- "$service_file")"
staging=$(mktemp -d "$install_dir/.next-XXXXXX")
cp -a "$payload/." "$staging/"
was_active=false
if [[ -d "$install_dir/current" ]] && service is-active --quiet pier-host.service; then
  was_active=true
  service stop pier-host.service
fi
if [[ -f "$state_dir/run/host.json" ]]; then
  running_pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$state_dir/run/host.json" | head -n 1)
  if [[ "$running_pid" =~ ^[0-9]+$ ]] && kill -0 "$running_pid" 2>/dev/null; then
    rm -rf -- "$staging"
    fail 'Another Host is running with this state directory. Stop it before installing.'
  fi
fi
mkdir "$staging/.previous-control"
for file in manage.sh install.env; do
  if [[ -f "$install_dir/$file" ]]; then cp -- "$install_dir/$file" "$staging/.previous-control/$file"; fi
done
if [[ -f "$service_file" ]]; then cp -- "$service_file" "$staging/.previous-control/service"; fi
if [[ -d "$install_dir/current" ]]; then mv -- "$install_dir/current" "$install_dir/previous"; fi
mv -- "$staging" "$install_dir/current"
cp -- "$install_dir/current/manage.sh" "$install_dir/manage.sh"
chmod 755 "$install_dir/manage.sh"
{
  printf 'PREFIX=%q\nSCOPE=%q\nBIN_DIR=%q\nSERVICE_FILE=%q\nSTATE_DIR=%q\nINSTALL_URL=%q\nVERSION=%q\n' \
    "$prefix" "$scope" "$bin_dir" "$service_file" "$state_dir" "$install_url" "$version"
} > "$install_dir/install.env"
ln -sfn -- "$install_dir/manage.sh" "$bin_dir/pier-host"
ln -sfn -- "$install_dir/manage.sh" "$bin_dir/pier-cli"
systemd_quote() {
  local value=$1
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail 'Newlines are not supported in installation paths.'
  value=${value//\\/\\\\}; value=${value//\"/\\\"}; value=${value//%/%%}
  printf '"%s"' "$value"
}
{
  printf '[Unit]\nDescription=Pier Host (headless)\nAfter=network.target\n\n[Service]\nType=simple\n'
  printf 'ExecStart=%s run\n' "$(systemd_quote "$install_dir/manage.sh")"
  printf 'WorkingDirectory=%s\n' "$(systemd_quote "$HOME")"
  printf 'Environment=%s\n' "$(systemd_quote "HOME=$HOME")"
  printf 'Environment=%s\n' "$(systemd_quote "PIER_DIR=$state_dir")"
  printf 'Environment=%s\n' "$(systemd_quote "PATH=$bin_dir:$PATH")"
  printf 'UMask=0077\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=20\nStandardOutput=null\nStandardError=journal\n\n[Install]\nWantedBy=%s\n' "$target"
} > "$service_file"
wait_ready() {
  local service_pid host_pid attempt
  for (( attempt=0; attempt<30; attempt++ )); do
    service is-active --quiet pier-host.service || return 1
    service_pid=$(service show -p MainPID --value pier-host.service)
    host_pid=
    if [[ -f "$state_dir/run/host.json" ]]; then
      host_pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$state_dir/run/host.json" | head -n 1)
    fi
    if [[ "$service_pid" =~ ^[1-9][0-9]*$ && "$host_pid" == "$service_pid" ]] && kill -0 "$service_pid" 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}
if "$start"; then
  if ! service daemon-reload || ! service enable --now pier-host.service || ! wait_ready; then
    service stop pier-host.service || true
    if [[ -d "$install_dir/previous" ]]; then
      for file in manage.sh install.env; do
        cp -- "$install_dir/current/.previous-control/$file" "$install_dir/$file"
      done
      cp -- "$install_dir/current/.previous-control/service" "$service_file"
      rm -rf -- "$install_dir/current"
      mv -- "$install_dir/previous" "$install_dir/current"
      service daemon-reload || true
      if "$was_active"; then service start pier-host.service || true; fi
    else
      service disable --now pier-host.service || true
    fi
    fail 'Service startup failed. Previous binaries were restored if present; inspect journalctl and retry.'
  fi
fi
rm -rf -- "$install_dir/previous"
rm -rf -- "$install_dir/current/.previous-control"
echo "Installed Pier Host $version ($scope service)."
echo "Commands: $bin_dir/pier-host {status|logs|cli|update|uninstall}"
echo 'Pairing: pier-host cli, then /remote on, /pair, and /pair yes.'
if [[ ":$PATH:" != *":$bin_dir:"* ]]; then echo "Add $bin_dir to PATH, or use the absolute command above."; fi
if ! "$start"; then echo 'Service was not started. Use pier-host run, or reload systemd and enable pier-host.service.';
elif [[ "$scope" == user ]]; then printf 'For startup before login and after SSH logout: sudo loginctl enable-linger %q\n' "$(id -un)"; fi
