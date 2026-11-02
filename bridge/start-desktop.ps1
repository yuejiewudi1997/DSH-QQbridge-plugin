# start-desktop.ps1 -- launcher for the qq-bridge on DSH Desktop (Windows).
#
# DSH Desktop starts its web server on a RANDOM port every launch (`--port 0`),
# so config.json's dsh.baseUrl goes stale. This script finds the live port, syncs
# config.json, then runs the bridge in the foreground.
#
# Port detection order:
#   1. -Port <n> on the command line
#   2. $env:DSH_WEB_URL (set when launched from a DSH terminal)
#   3. scan loopback listening ports for DSH's unauthenticated signature:
#      401 + body "dsh web authentication required"
#   4. keep whatever config.json already has
param(
  [int]$Port = 0,
  [switch]$NoPortSync
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $root 'config.json'
if (-not (Test-Path $configPath)) { throw "config.json not found: $configPath" }

function Find-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  foreach ($candidate in @(
      (Join-Path $root '..\SnowLuma\node.exe'),
      'D:\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
    )) {
    if (Test-Path $candidate) { return (Resolve-Path $candidate).Path }
  }
  throw 'node not found: install Node.js 22.13+ or keep SnowLuma\node.exe next to this folder'
}

function Get-ListeningPorts {
  $ports = New-Object System.Collections.Generic.List[int]
  foreach ($line in (& netstat -ano 2>$null)) {
    if ($line -match '^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+\d+\s*$') {
      $p = [int]$Matches[1]
      if (@(3100, 3000, 3001, 5099) -notcontains $p -and -not $ports.Contains($p)) { $ports.Add($p) }
    }
  }
  return $ports
}

function Test-DshWebPort([int]$candidate) {
  $response = $null
  try {
    $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$candidate/")
    $request.Timeout = 800
    $request.ReadWriteTimeout = 800
    $request.AllowAutoRedirect = $false
    $response = $request.GetResponse()
  } catch [System.Net.WebException] {
    $response = $_.Exception.Response
  }
  if (-not $response) { return $false }
  try {
    if ([int]$response.StatusCode -ne 401) { return $false }
    $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
    $body = $reader.ReadToEnd()
    return ($body -like '*dsh web authentication required*')
  } catch {
    return $false
  } finally {
    $response.Close()
  }
}

function Resolve-DshPort {
  if ($Port -gt 0) { return $Port }
  if ($env:DSH_WEB_URL -match ':(\d+)') { return [int]$Matches[1] }
  $found = 0
  foreach ($candidate in (Get-ListeningPorts)) {
    Write-Host ("  probing port {0} ..." -f $candidate)
    if (Test-DshWebPort $candidate) { $found = $candidate; break }
  }
  return $found
}

if (-not $NoPortSync) {
  $port = Resolve-DshPort
  if ($port -le 0) {
    Write-Warning 'Could not detect DSH Desktop. Keeping the baseUrl already in config.json.'
    Write-Warning 'Start DSH Desktop first, or run:  .\start-desktop.ps1 -Port <port>'
  } else {
    $wanted = "http://127.0.0.1:$port"
    $text = [System.IO.File]::ReadAllText($configPath)
    if ($text -notmatch [regex]::Escape($wanted)) {
      $updated = [regex]::Replace($text, '("baseUrl"\s*:\s*")[^"]*(")', ('${1}' + $wanted + '${2}'))
      # UTF-8 without BOM: qq-bridge parses config.json with JSON.parse, which rejects a BOM.
      [System.IO.File]::WriteAllText($configPath, $updated, (New-Object System.Text.UTF8Encoding($false)))
      Write-Host "dsh.baseUrl -> $wanted"
    } else {
      Write-Host "dsh.baseUrl already points at $wanted"
    }
  }
}

$nodeExe = Find-Node
Write-Host "starting bridge: $nodeExe src/bridge.js"
& $nodeExe (Join-Path $root 'src\bridge.js')
exit $LASTEXITCODE
