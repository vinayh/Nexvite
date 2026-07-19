#!/usr/bin/env bash
#
# Fetch Nexudus API tokens and print the auth seed as KEY=value lines.
#
# Pipe the output into scripts/nexudus-seed.sh to write the auth record to KV
# (or copy the lines and `pbpaste | scripts/nexudus-seed.sh` later). Prompts
# for the account username + password (or reads NEXUDUS_USERNAME /
# NEXUDUS_PASSWORD from the environment); the subdomain defaults to the value
# in wrangler.jsonc.
#
# Exactly three KEY=value lines go to stdout (nothing else), so the output can
# be copied verbatim or piped straight into scripts/nexudus-seed.sh.
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

printf '%s' "$RESP" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
	let j = {};
	try { j = JSON.parse(s); } catch {}
	if (typeof j.access_token !== "string" || typeof j.refresh_token !== "string") {
		console.error("Token request failed:", j.error || s.slice(0, 200));
		process.exit(1);
	}
	console.log("NEXUDUS_USERNAME=" + process.argv[1]);
	console.log("NEXUDUS_ACCESS_TOKEN=" + j.access_token);
	console.log("NEXUDUS_REFRESH_TOKEN=" + j.refresh_token);
});
' "$USERNAME"
