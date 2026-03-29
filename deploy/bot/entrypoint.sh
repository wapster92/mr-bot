#!/bin/sh
set -eu

append_host() {
  host="$1"
  ip="$2"

  if [ -z "$host" ] || [ -z "$ip" ]; then
    return
  fi

  if grep -Eq "[[:space:]]$host\$" /etc/hosts; then
    return
  fi

  printf '%s %s\n' "$ip" "$host" >> /etc/hosts
}

append_host "${CORP_GITLAB_HOST:-}" "${CORP_GITLAB_IP:-}"
append_host "${CORP_JIRA_HOST:-}" "${CORP_JIRA_IP:-}"

exec "$@"
