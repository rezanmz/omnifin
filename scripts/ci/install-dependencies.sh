#!/usr/bin/env bash

set -uo pipefail

readonly maximum_attempts=3
readonly retry_delay_seconds="${INSTALL_RETRY_DELAY_SECONDS:-5}"
if [[ ! "$retry_delay_seconds" =~ ^([0-9]|[12][0-9]|30)$ ]]; then
  printf 'INSTALL_RETRY_DELAY_SECONDS must be an integer from 0 through 30.\n' >&2
  exit 2
fi
attempt=1

while (( attempt <= maximum_attempts )); do
  if pnpm install --frozen-lockfile "$@"; then
    exit 0
  else
    status=$?
  fi
  if (( attempt == maximum_attempts )); then
    printf 'Dependency installation failed after %d attempts.\n' "$maximum_attempts" >&2
    exit "$status"
  fi

  delay=$((attempt * retry_delay_seconds))
  printf '::warning::Dependency installation attempt %d failed; retrying in %d seconds.\n' \
    "$attempt" "$delay" >&2
  if (( delay > 0 )); then
    sleep "$delay"
  fi
  attempt=$((attempt + 1))
done
