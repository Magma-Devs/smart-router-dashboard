#!/usr/bin/env bash
set -euo pipefail

# The router and API always mount the SAME source directory. Resolve the
# existing SR_CONFIG_HOST option without copying or rendering secret YAML.
repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
action=${1:-check}
case "$action" in check|prepare|up|up-router|restart-router) ;; *)
  echo 'Usage: config-stack.sh {check|prepare|up|up-router|restart-router}' >&2
  exit 2 ;;
esac

# Let Compose read .env without sourcing it as executable shell code. Extract
# only installer settings; explicit process environment still wins below.
installer_env=$(env -u SR_CONFIG_HOST -u SR_CONFIG_GID -u SR_CONFIG_BUILD -u SR_COMPOSE_OVERRIDE \
  docker compose --project-directory "$repo_dir" -f "$repo_dir/docker-compose.yml" -f "$repo_dir/docker-compose.config.yml" \
  config --environment | sed -n -e '/^SR_CONFIG_HOST=/p' -e '/^SR_CONFIG_GID=/p' -e '/^SR_CONFIG_BUILD=/p' -e '/^SR_COMPOSE_OVERRIDE=/p')
setting() { printf '%s\n' "$installer_env" | sed -n "s/^$1=//p"; }
config_host=${SR_CONFIG_HOST:-$(setting SR_CONFIG_HOST)}
config_host=${config_host:-$repo_dir/dev-config/values.yml}
if [[ "$config_host" != /* ]]; then config_host="$repo_dir/$config_host"; fi
[[ -f "$config_host" && ! -L "$config_host" ]] || {
  echo 'SR_CONFIG_HOST must name an existing regular configuration file, not a symlink.' >&2
  exit 1
}
export SR_CONFIG_DIR
SR_CONFIG_DIR=$(cd "$(dirname "$config_host")" && pwd -P)
export SR_CONFIG_FILENAME
SR_CONFIG_FILENAME=$(basename "$config_host")
# These characters have meaning in Compose interpolation and mounted paths.
[[ "$SR_CONFIG_FILENAME" =~ ^[A-Za-z0-9._-]+$ ]] || {
  echo 'Use a configuration filename containing letters, digits, dots, underscores or hyphens.' >&2
  exit 1
}
export SR_CONFIG_CONTAINER_FILE="$SR_CONFIG_FILENAME"
export SR_CONFIG_GID=${SR_CONFIG_GID:-$(setting SR_CONFIG_GID)}
SR_CONFIG_GID=${SR_CONFIG_GID:-2000}
[[ "$SR_CONFIG_GID" =~ ^[1-9][0-9]{0,8}$ ]] || {
  echo 'SR_CONFIG_GID must be a nonzero numeric group ID.' >&2
  exit 1
}

compose=(docker compose --project-directory "$repo_dir" -f "$repo_dir/docker-compose.yml" -f "$repo_dir/docker-compose.config.yml")
SR_COMPOSE_OVERRIDE=${SR_COMPOSE_OVERRIDE:-$(setting SR_COMPOSE_OVERRIDE)}
if [[ -n ${SR_COMPOSE_OVERRIDE:-} ]]; then compose+=(-f "$SR_COMPOSE_OVERRIDE"); fi
docker info >/dev/null
"${compose[@]}" config --quiet
SR_CONFIG_BUILD=${SR_CONFIG_BUILD:-$(setting SR_CONFIG_BUILD)}
if [[ ${SR_CONFIG_BUILD:-1} != 0 ]]; then
  if [[ "$action" == up || "$action" == up-router ]]; then
    "${compose[@]}" build api web
  else
    "${compose[@]}" build api
  fi
fi

check_config() { "${compose[@]}" run --rm --no-deps config-check; }
prepare_config() { "${compose[@]}" run --rm --no-deps config-prepare; }
if [[ "$action" == prepare ]]; then
  prepare_config
  check_config
  exit
fi
if ! check_output=$(check_config); then
  printf '%s\n' "$check_output" >&2
  case "$check_output" in
    *'"status":"unreadable"'*)
      if [[ "$action" == check ]]; then
        echo 'Read access is missing. Run the prepare command for this configuration directory.' >&2
        exit 1
      fi
      echo 'Preparing group read access to the selected configuration file and directory.'
      prepare_config
      check_config ;;
    *) echo 'Configuration check failed; the stack was not started or restarted.' >&2; exit 1 ;;
  esac
else
  printf '%s\n' "$check_output"
fi

case "$action" in
  check) ;;
  up) "${compose[@]}" up -d --no-build prometheus api web ;;
  up-router) "${compose[@]}" --profile router up -d --no-build prometheus router api web ;;
  restart-router) "${compose[@]}" --profile router up -d --no-build --no-deps --force-recreate router ;;
esac
