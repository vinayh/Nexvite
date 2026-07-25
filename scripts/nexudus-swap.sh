#!/usr/bin/env bash
#
# Swap the live Nexudus auth record for another account's (e.g. your own, to
# test what that account sees) and swap back later. The original record is
# stashed under a second key in the same TOKENS namespace — still in
# Cloudflare, but outside the key the Worker reads, so it sits untouched
# while the test account is live.
#
#   scripts/nexudus-swap.sh test      # stash the live record, then seed the test account (prompts)
#   scripts/nexudus-swap.sh restore   # put the stashed record back and drop the stash
#   scripts/nexudus-swap.sh status    # show whose account is live and whether a stash exists
#
# Only the live record rotates its refresh token; the stash sits still, so
# restore within the refresh token's ~14-day validity. `test` refuses to run
# while a stash exists — restore first, or the original record would be
# overwritten. Requires `wrangler login`.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LIVE_KEY="nexudus" # TOKEN_KEY in src/nexudus.ts
STASH_KEY="nexudus-stash"

# Empty when the key is missing: wrangler exits non-zero but still chats on
# stdout, so only a successful exit's output counts, and only if it looks
# like the JSON record rather than CLI noise.
kv_get() {
	local out
	if out="$(npx wrangler kv key get --binding TOKENS --remote "$1" 2>/dev/null)"; then
		case "$out" in "{"*) printf '%s' "$out" ;; esac
	fi
}
username_of() { node -e 'try { console.log(JSON.parse(process.argv[1]).username ?? "?"); } catch { console.log("?"); }' "$1"; }

# Who is where, re-read from KV so it reflects what actually landed. Printed
# at the end of every command, not just `status`.
summary() {
	local live stashed
	live="$(kv_get "$LIVE_KEY")"
	stashed="$(kv_get "$STASH_KEY")"
	[ -n "$live" ] && echo "live ($LIVE_KEY): $(username_of "$live")" || echo "live ($LIVE_KEY): <missing>"
	[ -n "$stashed" ] && echo "stash ($STASH_KEY): $(username_of "$stashed")" || echo "stash ($STASH_KEY): <none>"
}

case "${1:-}" in
	test)
		LIVE="$(kv_get "$LIVE_KEY")"
		[ -z "$LIVE" ] && { echo "No live record under '$LIVE_KEY' — nothing to stash; seed normally instead." >&2; exit 1; }
		if [ -n "$(kv_get "$STASH_KEY")" ]; then
			echo "A stash already exists — run 'restore' first, or 'status' to see what's where." >&2
			echo "(Stashing again would overwrite the saved original with the current live record.)" >&2
			exit 1
		fi
		npx wrangler kv key put --binding TOKENS --remote "$STASH_KEY" "$LIVE" >/dev/null
		echo "Stashed the live record for $(username_of "$LIVE") under '$STASH_KEY'." >&2
		echo "Now enter the test account's credentials:" >&2
		scripts/nexudus-token.sh | scripts/nexudus-seed.sh
		echo "Run 'scripts/nexudus-swap.sh restore' when done (within ~14 days)." >&2
		summary
		;;
	restore)
		STASHED="$(kv_get "$STASH_KEY")"
		[ -z "$STASHED" ] && { echo "No stashed record under '$STASH_KEY' — nothing to restore." >&2; exit 1; }
		npx wrangler kv key put --binding TOKENS --remote "$LIVE_KEY" "$STASHED" >/dev/null
		npx wrangler kv key delete --binding TOKENS --remote "$STASH_KEY" >/dev/null
		echo "✅ Restored the record for $(username_of "$STASHED") and dropped the stash." >&2
		summary
		;;
	status)
		summary
		;;
	*)
		echo "Usage: scripts/nexudus-swap.sh test|restore|status" >&2
		exit 1
		;;
esac
