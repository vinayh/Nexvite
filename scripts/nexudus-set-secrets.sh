#!/usr/bin/env bash
#
# Set the Nexudus token secrets on the Worker from KEY=value lines on stdin
# (the output of scripts/nexudus-token.sh), then clear the cached KV pair so
# the new seed takes effect. Requires `wrangler login`.
#
#   scripts/nexudus-token.sh | scripts/nexudus-set-secrets.sh
#   pbpaste | scripts/nexudus-set-secrets.sh          # from a copied snippet

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

USERNAME="" ACCESS="" REFRESH=""
while IFS='=' read -r key value; do
	case "$key" in
		NEXUDUS_USERNAME) USERNAME="$value" ;;
		NEXUDUS_ACCESS_TOKEN) ACCESS="$value" ;;
		NEXUDUS_REFRESH_TOKEN) REFRESH="$value" ;;
	esac
done

if [ -z "$ACCESS" ] || [ -z "$REFRESH" ]; then
	echo "Expected NEXUDUS_ACCESS_TOKEN and NEXUDUS_REFRESH_TOKEN on stdin." >&2
	exit 1
fi

# NEXUDUS_USERNAME (the stable account email) is set once, separately
# (`wrangler secret put NEXUDUS_USERNAME`), but honor a piped line if present.
if [ -n "$USERNAME" ]; then
	printf '%s' "$USERNAME" | npx wrangler secret put NEXUDUS_USERNAME
fi
printf '%s' "$ACCESS" | npx wrangler secret put NEXUDUS_ACCESS_TOKEN
printf '%s' "$REFRESH" | npx wrangler secret put NEXUDUS_REFRESH_TOKEN

# Drop the cached token pair so the Worker re-seeds from the new secrets.
# "Key not found" (first setup) is fine; any other failure means the Worker
# keeps using the stale cached pair — never report success for that.
if OUT="$(npx wrangler kv key delete --binding TOKENS nexudus 2>&1)"; then
	echo "✅ Nexudus secrets set and KV token cache cleared." >&2
elif printf '%s' "$OUT" | grep -qi "not found"; then
	echo "✅ Nexudus secrets set (no cached KV pair to clear)." >&2
else
	printf '%s\n' "$OUT" >&2
	echo "⚠️  Secrets set, but clearing the KV token cache FAILED — the Worker will keep" >&2
	echo "   using the old cached pair. Clear it manually:" >&2
	echo "   npx wrangler kv key delete --binding TOKENS nexudus" >&2
	exit 1
fi
