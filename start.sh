#!/usr/bin/env bash
# Install and manage DeepSeek Harness as a host-native systemd service.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "$SCRIPT_DIR/scripts/deployment/common.sh"
source "$SCRIPT_DIR/scripts/deployment/native-service.sh"

native_usage() {
  cat <<'EOF'
Usage: ./start.sh [command]

Commands:
  install     Install or update, enable, and start the service (default)
  start       Start the installed service
  stop        Stop the installed service
  restart     Restart the installed service
  status      Show service state and URLs
  logs        Follow service logs
  uninstall   Disable and remove the service while preserving configuration
  help        Show this help
EOF
}

main() {
  local command="${1:-install}"
  case "$command" in
    __service)
      shift
      [ "$#" -eq 5 ] || dsh_die "__service requires config, repository, user, home, and login shell"
      native_service_run "$@"
      ;;
    install|start|stop|restart|status|logs|uninstall)
      [ "$#" -le 1 ] || dsh_die "unexpected arguments; run './start.sh help'"
      native_command "$command" "$SCRIPT_DIR"
      ;;
    help|-h|--help)
      native_usage
      ;;
    *) dsh_die "unknown command: $command (run './start.sh help')" ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
