#!/usr/bin/env bash
#
# Write the Nexudus auth record { username, access_token, refresh_token } to
# the TOKENS KV namespace, from KEY=value lines on stdin (the output of
# scripts/nexudus-token.sh). Requires `wrangler login`.
#
#   scripts/nexudus-token.sh | scripts/nexudus-seed.sh           # production KV
#   scripts/nexudus-token.sh | scripts/nexudus-seed.sh --local   # wrangler dev storage
#   pbpaste | scripts/nexudus-seed.sh                            # from a copied snippet
#
# The production TOKENS namespace is shared between the Nexvite and Nexroom
# Workers, so one seeding covers both.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TARGET="--remote"
[ "${1:-}" = "--local" ] && TARGET="--local"

USERNAME="" ACCESS="" REFRESH=""
while IFS='=' read -r key value; do
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
console.log(JSON.stringify({ username: u, access_token: a, refresh_token: r }));
' "$USERNAME" "$ACCESS" "$REFRESH")"

npx wrangler kv key put --binding TOKENS "$TARGET" nexudus "$RECORD" >/dev/null
echo "✅ Nexudus auth record seeded to KV ($TARGET)." >&2
