#!/usr/bin/env bash
#
# Write a fresh Nexudus auth seed to the NEXUDUS_AUTH_SEED Worker secret from
# KEY=value lines on stdin (the output of scripts/nexudus-token.sh). A new
# seed_version tells the Durable Object to replace its stored credential.
# Requires `wrangler login` and an existing deployed Worker.
#
#   scripts/nexudus-token.sh | scripts/nexudus-seed.sh
#   pbpaste | scripts/nexudus-seed.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

USERNAME="" ACCESS="" REFRESH=""
while IFS='=' read -r key value; do
	value="${value%$'\r'}"
	case "$key" in
		NEXUDUS_USERNAME) USERNAME="$value" ;;
		NEXUDUS_ACCESS_TOKEN) ACCESS="$value" ;;
		NEXUDUS_REFRESH_TOKEN) REFRESH="$value" ;;
	esac
done

if [ -z "$USERNAME" ] || [ -z "$ACCESS" ] || [ -z "$REFRESH" ]; then
	echo "Expected NEXUDUS_USERNAME, NEXUDUS_ACCESS_TOKEN and NEXUDUS_REFRESH_TOKEN on stdin." >&2
	exit 1
fi

RECORD="$(node -e '
const [u, a, r] = process.argv.slice(1);
console.log(JSON.stringify({ seed_version: Date.now(), username: u, access_token: a, refresh_token: r }));
' "$USERNAME" "$ACCESS" "$REFRESH")"

printf '%s' "$RECORD" | npx wrangler secret put NEXUDUS_AUTH_SEED >/dev/null
echo "✅ Nexudus auth seed updated; the Durable Object will import it on the next request." >&2
