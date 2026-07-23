#!/usr/bin/env bash
#
# Decrypt the blob printed by scripts/nexudus-token.ps1 back into the three
# KEY=value lines, ready for scripts/nexudus-seed.sh:
#
#   pbpaste | scripts/nexudus-open.sh | scripts/nexudus-seed.sh
#
# Reads the blob on stdin (stray whitespace and line breaks are fine) and the
# RSA private key from $NEXVITE_TOKEN_KEY (default ~/.nexvite-token-key.pem).
# To rotate the key, delete the file, rerun scripts/nexudus-keygen.sh and
# re-embed the printed XML in scripts/nexudus-token.ps1.

set -euo pipefail

KEY="${NEXVITE_TOKEN_KEY:-$HOME/.nexvite-token-key.pem}"
[ -f "$KEY" ] || { echo "Private key not found at $KEY (run scripts/nexudus-keygen.sh)." >&2; exit 1; }

node -e '
const crypto = require("crypto"), fs = require("fs");
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
	const buf = Buffer.from(s.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
	const rsaBytes = 512; // 4096-bit key
	try {
		const aesKey = crypto.privateDecrypt(
			{ key: fs.readFileSync(process.argv[1], "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
			buf.subarray(0, rsaBytes)
		);
		const d = crypto.createDecipheriv("aes-256-cbc", aesKey, buf.subarray(rsaBytes, rsaBytes + 16));
		process.stdout.write(Buffer.concat([d.update(buf.subarray(rsaBytes + 16)), d.final()]).toString("utf8"));
	} catch (e) {
		console.error("Decryption failed (wrong key or corrupted blob):", e.message);
		process.exit(1);
	}
});
' "$KEY"
