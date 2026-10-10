#!/usr/bin/env bash
# Installed as manage.sh; pier-host is a symlink to this file.
set -euo pipefail

manager=$(readlink -f -- "${BASH_SOURCE[0]}")
install_dir=$(dirname -- "$manager")
[[ -f "$install_dir/install.env" ]] || { echo 'Not a managed Pier Host installation.' >&2; exit 1; }
# Written with bash %q by the installer, never supplied by an archive.
# shellcheck source=/dev/null
source "$install_dir/install.env"
if [[ "$(basename -- "$0")" == pier-cli ]]; then set -- cli "$@"; fi

service() {
  if [[ "$SCOPE" == user ]]; then systemctl --user "$@"; else systemctl "$@"; fi
}

case "${1:-run}" in
  run)
    [[ $# == 0 ]] || shift
    export PIER_DIR="$STATE_DIR" PI_PACKAGE_DIR="$install_dir/current"
    exec "$install_dir/current/pier-host" "$@"
    ;;
  cli)
    shift
    export PIER_DIR="$STATE_DIR"
    exec "$install_dir/current/pier-cli" "$@"
    ;;
  start|stop|restart|status)
    service "$1" pier-host.service
    ;;
  logs)
    if [[ "$SCOPE" == user ]]; then exec journalctl --user -u pier-host.service -f; fi
    exec journalctl -u pier-host.service -f
    ;;
  update)
    shift
    task_update_script=$(mktemp)
    trap 'rm -f -- "$task_update_script"' EXIT
    curl --proto '=https' --proto-redir '=https' -fsSL "$INSTALL_URL" -o "$task_update_script"
    export PIER_HOST_PREFIX="$PREFIX" PIER_HOST_STATE_DIR="$STATE_DIR"
    if [[ "$SCOPE" == user ]]; then export XDG_CONFIG_HOME="${SERVICE_FILE%/systemd/user/pier-host.service}"; fi
    bash "$task_update_script" "--$SCOPE" "$@"
    ;;
  uninstall)
    purge=false
    case "${2:-}" in
      '') [[ $# == 1 ]] || exit 2 ;;
      --purge) [[ $# == 2 ]] || exit 2; purge=true ;;
      *) echo 'Usage: pier-host uninstall [--purge]' >&2; exit 2 ;;
    esac
    if "$purge"; then
      state_path=$(realpath -m -- "$STATE_DIR")
      case "$state_path" in /|/etc|/usr|/var|/opt|/tmp|/home|/root|/srv) echo 'Refusing to purge a system directory.' >&2; exit 1;; esac
      if [[ "$HOME/" == "$state_path/"* || "$install_dir/" == "$state_path/"* ]]; then
        echo 'Refusing to purge a directory containing the home or installation.' >&2; exit 1
      fi
    fi
    # A failure must not leave a running service whose executable was deleted.
    can_reload=true
    if ! service disable --now pier-host.service; then
      if service show-environment >/dev/null 2>&1; then
        echo 'Could not stop the service; installation was kept.' >&2; exit 1
      fi
      can_reload=false
    fi
    if [[ -f "$STATE_DIR/run/host.json" ]]; then
      running_pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$STATE_DIR/run/host.json" | head -n 1)
      if [[ "$running_pid" =~ ^[0-9]+$ ]] && kill -0 "$running_pid" 2>/dev/null; then
        echo 'A Host is still running with this state directory. Stop it before uninstalling.' >&2; exit 1
      fi
    fi
    rm -f -- "$SERVICE_FILE"
    if "$can_reload"; then service daemon-reload; fi
    for name in pier-host pier-cli; do
      link="$BIN_DIR/$name"
      if [[ -L "$link" && "$(readlink -f -- "$link")" == "$install_dir/"* ]]; then rm -- "$link"; fi
    done
    rm -rf -- "$install_dir"
    if "$purge"; then rm -rf -- "$STATE_DIR"; echo "Removed Pier data: $STATE_DIR";
    else echo "Kept Pier configuration, pairing and task data: $STATE_DIR"; fi
    echo 'Pier Host uninstalled. Shared pi / Claude Code / Codex data and project files were kept.'
    ;;
  help)
    cat <<'HELP'
Usage: pier-host [run [host options]|cli|start|stop|restart|status|logs|update|uninstall [--purge]]
  cli          Open the local CLI; /remote on, /pair, then /pair yes to pair a device
  update       Install the latest release (or pass --version vX.Y.Z)
  uninstall    Stop and remove the service and program; keep user data
  --purge      Also remove this installation's Pier state; keep shared Agent data
HELP
    ;;
  *)
    export PIER_DIR="$STATE_DIR" PI_PACKAGE_DIR="$install_dir/current"
    exec "$install_dir/current/pier-host" "$@"
    ;;
esac
