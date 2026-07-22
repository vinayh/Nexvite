# Fetch Nexudus API tokens and print the auth seed as KEY=value lines.
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
# Exactly three KEY=value lines go to stdout (nothing else). Copy them and feed
# them to scripts/nexudus-seed.sh on a machine with wrangler access
# (`pbpaste | scripts/nexudus-seed.sh`).
#
# The token request must be application/x-www-form-urlencoded (a JSON body
# returns unsupported_grant_type).

$ErrorActionPreference = 'Stop'

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
if (-not $Subdomain) { $Subdomain = 'your-space' }

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
    $detail = if ($_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
    [Console]::Error.WriteLine("Token request failed: $detail")
    exit 1
}

if ($resp.access_token -isnot [string] -or $resp.refresh_token -isnot [string]) {
    [Console]::Error.WriteLine("Token request failed: $($resp | ConvertTo-Json -Compress)")
    exit 1
}

Write-Output "NEXUDUS_USERNAME=$Username"
Write-Output "NEXUDUS_ACCESS_TOKEN=$($resp.access_token)"
Write-Output "NEXUDUS_REFRESH_TOKEN=$($resp.refresh_token)"
