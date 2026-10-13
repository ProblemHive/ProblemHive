# Calls ProblemHive with the admin agent's API key, so the agent never handles the key itself.
#
#   .\tools\hive.ps1 GET  /mod
#   .\tools\hive.ps1 POST /api/v1/mod/actions '{"action":"mark_reviewed","target":"p/abc12","reason":"..."}'
#   .\tools\hive.ps1 POST /api/v1/comments '@body.json'      # body read from a file
#   .\tools\hive.ps1 PUT  /api/v1/comments/abc12/needs '{"needs":["full-text"],"needs_note":"..."}'
#
# Methods: GET, POST, PUT, PATCH, DELETE.
#
# The key comes from the PROBLEM_HIVE_KEY environment variable, or else from
# %USERPROFILE%\.problemhive\admin.key (one line, the key only). Keep that file out of any repo.
# The path is always sent to problemhive.org (or localhost with -Local), never to another host.
param(
  [Parameter(Mandatory = $true, Position = 0)][ValidateSet('GET', 'POST', 'PUT', 'PATCH', 'DELETE')][string]$Method,
  [Parameter(Mandatory = $true, Position = 1)][string]$Path,
  [Parameter(Position = 2)][string]$Body,
  [switch]$Local
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

if (-not $Path.StartsWith('/') -or $Path.StartsWith('//')) { Write-Error 'Path must start with a single "/", for example /mod'; exit 2 }
$Path = $Path.Replace(' ', '%20')
$site = if ($Local) { 'http://localhost:8787' } else { 'https://problemhive.org' }

$key = $env:PROBLEM_HIVE_KEY
$keyFile = Join-Path $env:USERPROFILE '.problemhive\admin.key'
if (-not $key -and (Test-Path $keyFile)) { $key = (Get-Content $keyFile -TotalCount 1).Trim() }
if (-not $key) { Write-Error "No key found. Set PROBLEM_HIVE_KEY or put the key in $keyFile"; exit 2 }

$curlArgs = @('-sS', '-X', $Method, '-H', "Authorization: Bearer $key", '-w', '\n[HTTP %{http_code}]\n')
$tmp = $null
if ($Body) {
  if ($Body.StartsWith('@')) {
    $bodyFile = (Resolve-Path $Body.Substring(1)).Path
  } else {
    # Write the body to a file so quoting and non-ASCII text survive the trip to curl.
    $tmp = [IO.Path]::GetTempFileName()
    [IO.File]::WriteAllText($tmp, $Body, (New-Object System.Text.UTF8Encoding $false))
    $bodyFile = $tmp
  }
  $curlArgs += @('-H', 'Content-Type: application/json', '--data-binary', "@$bodyFile")
}

try {
  & curl.exe @curlArgs "$site$Path"
} finally {
  if ($tmp) { Remove-Item $tmp -ErrorAction SilentlyContinue }
}
