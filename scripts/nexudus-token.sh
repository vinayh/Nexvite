#!/usr/bin/env bash
#
# Fetch Nexudus API tokens and print them as KEY=value lines.
#
# Run it, copy the two lines it prints, and hand them over to set the Worker
# secrets (scripts/nexudus-set-secrets.sh). Prompts for the account username +
# password (or reads NEXUDUS_USERNAME / NEXUDUS_PASSWORD from the environment);
# the subdomain defaults to the value in wrangler.jsonc.
#
# Only the two generated tokens go to stdout. NEXUDUS_USERNAME (the stable
# account email) is set once, separately: wrangler secret put NEXUDUS_USERNAME
#
# The token request must be application/x-www-form-urlencoded (a JSON body
# returns unsupported_grant_type).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

SUBDOMAIN="${NEXUDUS_SUBDOMAIN:-$(grep -o '"NEXUDUS_SUBDOMAIN"[[:space:]]*:[[:space:]]*"[^"]*"' "$ROOT/wrangler.jsonc" | sed 's/.*"\([^"]*\)"$/\1/')}"
[ -z "$SUBDOMAIN" ] && { read -r -p "Nexudus subdomain: " SUBDOMAIN; }

USERNAME="${NEXUDUS_USERNAME:-}"
[ -z "$USERNAME" ] && read -r -p "Nexudus username (email): " USERNAME

PASSWORD="${NEXUDUS_PASSWORD:-}"
[ -z "$PASSWORD" ] && { read -r -s -p "Nexudus password: " PASSWORD; echo >&2; }

RESP="$(curl -sS -X POST "https://$SUBDOMAIN.spaces.nexudus.com/api/token" \
	-H 'Content-Type: application/x-www-form-urlencoded' \
	--data-urlencode grant_type=password \
	--data-urlencode "username=$USERNAME" \
	--data-urlencode "password=$PASSWORD")"

# Print exactly two KEY=value lines to stdout (nothing else), so the output
# can be copied verbatim or piped straight into scripts/nexudus-set-secrets.sh.
printf '%s' "$RESP" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
	let j = {};
	try { j = JSON.parse(s); } catch {}
	if (typeof j.access_token !== "string" || typeof j.refresh_token !== "string") {
		console.error("Token request failed:", j.error || s.slice(0, 200));
		process.exit(1);
	}
	console.log("NEXUDUS_ACCESS_TOKEN=" + j.access_token);
	console.log("NEXUDUS_REFRESH_TOKEN=" + j.refresh_token);
});
'
