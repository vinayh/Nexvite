# Fetch Nexudus API tokens and print the auth seed as ONE encrypted base64
# line, safe to send back over chat or email.
#
# Windows equivalent of scripts/nexudus-token.sh. Runs on the PowerShell that
# ships with Windows 10/11 (5.1) as well as PowerShell 7; nothing to install.
#
#   powershell -ExecutionPolicy Bypass -File scripts\nexudus-token.ps1
#
# Prompts for the account username + password (or reads NEXUDUS_USERNAME /
# NEXUDUS_PASSWORD from the environment); the subdomain comes from
# NEXUDUS_SUBDOMAIN, then wrangler.jsonc when the repo is present, then the
# baked-in production default.
#
# The output is hybrid-encrypted to the embedded RSA public key (AES-256-CBC
# for the payload, RSA-4096 OAEP for the AES key; RSA alone cannot fit the
# tokens). Only the holder of the private key can read it:
#
#   pbpaste | scripts/nexudus-open.sh | scripts/nexudus-seed.sh
#
# Pass -Plain to skip encryption and print the three KEY=value lines instead
# (for use on a trusted machine).
#
# The token request must be application/x-www-form-urlencoded (a JSON body
# returns unsupported_grant_type).

param([switch]$Plain)

$ErrorActionPreference = 'Stop'

# Public half of the keypair from scripts/nexudus-keygen.sh; the private key
# never leaves the operator's machine.
$PublicKeyXml = '<RSAKeyValue><Modulus>wR8iaoMCpB2PoLWRjzPdjMHA0y1l66sEv89g78AP1ekiuaGbMveXAzciZw+n1pOsQ6u2E+N8INyoJxihiz2/PFMHj4IpxbKhDi26WNEEx7I68WYqQAD3h4BvT2KpySV4cwiiRiajFxt3DsL2bBmRW6ioXE5Zfe02GxWPwCvUnvF8nelcPV1WhupXnQ3L9eIHWhfo0OnTYM+eLlaIFE3vXBk3yoMPpAeeoAUagB65FesvQwMpBEdZtbDuFSvUDjR9hsGX7PYjuCNb4P+x1f3advbQQdloi0is9X7qIJ0inO3oA919B+PeH9+0IeZ/szjejRMgC/8yQi46st5Mdh2uf+AtLGeiBkcWWO0WgBNOXF89ihsFdtrD/wzX273mrpfNW2AnDRDqWpWUY1M6B+E8j4KpBmKj0Xy61wBD7ltp6Y76CGj8UbPEnS6Z2SfrkJXs6h9gTnYhDr6f3r0bRKDvDcieuSbsTT1FjK0msts+QtTsiXHVkSTJG121XnfwxjNk7frU5lcMR52qkRfIdJGs1irAbSF6PpE1LT0UmhxbM/HJz9cr6f8Dlt5AsSiGS4/+JVraLsX2StTjEjOyzHuAOljtHMHfLGUPtwPNNekTLnJ3TxkmS4LFfILTQBUXTgqGpnBJXh7jXtplyrTdnebdBzCn3VuuClb4WAfSG9uzUa0=</Modulus><Exponent>AQAB</Exponent></RSAKeyValue>'

# Windows PowerShell 5.1 can default to TLS 1.0, which Nexudus rejects.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Subdomain = $env:NEXUDUS_SUBDOMAIN
if (-not $Subdomain) {
    $wrangler = Join-Path $PSScriptRoot '..\wrangler.jsonc'
    if (Test-Path $wrangler) {
        $m = [regex]::Match((Get-Content $wrangler -Raw), '"NEXUDUS_SUBDOMAIN"\s*:\s*"([^"]*)"')
        if ($m.Success) { $Subdomain = $m.Groups[1].Value }
    }
}
if (-not $Subdomain) { $Subdomain = Read-Host -Prompt 'Nexudus subdomain ({sub}.spaces.nexudus.com)' }

$Username = $env:NEXUDUS_USERNAME
if (-not $Username) { $Username = Read-Host -Prompt 'Nexudus username (email)' }

$Password = $env:NEXUDUS_PASSWORD
if (-not $Password) {
    $secure = Read-Host -Prompt 'Nexudus password' -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $Password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

try {
    $resp = Invoke-RestMethod -Method Post `
        -Uri "https://$Subdomain.spaces.nexudus.com/api/token" `
        -ContentType 'application/x-www-form-urlencoded' `
        -Body @{ grant_type = 'password'; username = $Username; password = $Password }
} catch {
    [Console]::Error.WriteLine("Token request failed.")
    exit 1
}

if ($resp.access_token -isnot [string] -or $resp.refresh_token -isnot [string]) {
    [Console]::Error.WriteLine("Token response did not contain both required tokens.")
    exit 1
}

$lines = "NEXUDUS_USERNAME=$Username`n" +
    "NEXUDUS_ACCESS_TOKEN=$($resp.access_token)`n" +
    "NEXUDUS_REFRESH_TOKEN=$($resp.refresh_token)`n"

if ($Plain) {
    Write-Output $lines.TrimEnd("`n")
    exit 0
}

$aes = [System.Security.Cryptography.Aes]::Create()
$aes.KeySize = 256
$payload = [Text.Encoding]::UTF8.GetBytes($lines)
$ct = $aes.CreateEncryptor().TransformFinalBlock($payload, 0, $payload.Length)

$rsa = [System.Security.Cryptography.RSA]::Create()
$rsa.FromXmlString($PublicKeyXml)
$ek = $rsa.Encrypt($aes.Key, [System.Security.Cryptography.RSAEncryptionPadding]::OaepSHA1)

$blob = [Convert]::ToBase64String([byte[]]($ek + $aes.IV + $ct))
Write-Output $blob
try {
    Set-Clipboard -Value $blob
    [Console]::Error.WriteLine('The encrypted line above was also copied to your clipboard; just paste it in a reply.')
} catch {}
