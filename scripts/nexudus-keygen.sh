#!/usr/bin/env bash
#
# Generate the RSA keypair for the encrypted Windows token flow and print the
# <RSAKeyValue> public key XML to embed in scripts/nexudus-token.ps1.
#
# The private key is written to $NEXVITE_TOKEN_KEY (default
# ~/.nexvite-token-key.pem) and must never leave this machine or enter the
# repo. scripts/nexudus-open.sh reads it from the same path. To rotate, delete
# the key file, rerun this script and re-embed the printed XML.

set -euo pipefail

KEY="${NEXVITE_TOKEN_KEY:-$HOME/.nexvite-token-key.pem}"

if [ -e "$KEY" ]; then
	echo "Refusing to overwrite existing $KEY (delete it first to rotate)." >&2
	exit 1
fi

umask 077
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out "$KEY" 2>/dev/null

node -e '
const crypto = require("crypto"), fs = require("fs");
const jwk = crypto.createPublicKey(fs.readFileSync(process.argv[1])).export({ format: "jwk" });
const b64 = (s) => Buffer.from(s, "base64url").toString("base64");
console.log(`<RSAKeyValue><Modulus>${b64(jwk.n)}</Modulus><Exponent>${b64(jwk.e)}</Exponent></RSAKeyValue>`);
' "$KEY"

echo "Private key written to $KEY" >&2
