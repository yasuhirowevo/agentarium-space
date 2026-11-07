param(
  [Parameter(Mandatory = $true)]
  [string]$ArtifactPath
)

$ErrorActionPreference = 'Stop'
$startTimeoutSeconds = 60
$artifact = (Resolve-Path -LiteralPath $ArtifactPath).Path
$originalEnvironment = @{
  HOME = $env:HOME
  USERPROFILE = $env:USERPROFILE
  APPDATA = $env:APPDATA
  LOCALAPPDATA = $env:LOCALAPPDATA
  AGENTARIUM_PORT = $env:AGENTARIUM_PORT
}
$smokeProfile = Join-Path ([System.IO.Path]::GetTempPath()) ("agentarium-space-portable-smoke-" + [guid]::NewGuid())
$wrapper = $null
$listener = $null

function Restore-EnvironmentVariable([string]$Name, $Value) {
  if ($null -eq $Value) {
    Remove-Item -Path "Env:$Name" -ErrorAction SilentlyContinue
  } else {
    Set-Item -Path "Env:$Name" -Value $Value
  }
}

try {
  New-Item -ItemType Directory -Path (Join-Path $smokeProfile 'AppData/Roaming') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $smokeProfile 'AppData/Local') -Force | Out-Null

  do {
    $port = Get-Random -Minimum 49152 -Maximum 65535
    $existingListener = Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort $port -ErrorAction SilentlyContinue
  } while ($null -ne $existingListener)

  $env:HOME = $smokeProfile
  $env:USERPROFILE = $smokeProfile
  $env:APPDATA = Join-Path $smokeProfile 'AppData/Roaming'
  $env:LOCALAPPDATA = Join-Path $smokeProfile 'AppData/Local'
  $env:AGENTARIUM_PORT = "$port"

  $wrapper = Start-Process -FilePath $artifact -PassThru
  $deadline = (Get-Date).AddSeconds($startTimeoutSeconds)
  do {
    Start-Sleep -Milliseconds 500
    $listener = Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort $port -ErrorAction SilentlyContinue |
      Select-Object -First 1
  } while ($null -eq $listener -and (Get-Date) -lt $deadline)

  if ($null -eq $listener) {
    throw "Portable EXE did not start the loopback server within $startTimeoutSeconds seconds."
  }

  $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -SkipHttpErrorCheck
  if ($response.StatusCode -ne 403) {
    throw "Portable EXE loopback server returned HTTP $($response.StatusCode), expected 403 for the tokenless path."
  }

  Start-Sleep -Seconds 2
  if ($null -eq (Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue)) {
    throw 'Portable EXE started the loopback server but the extracted application exited immediately.'
  }

  Write-Host "Portable Windows smoke test passed: $artifact"
} finally {
  if ($null -ne $listener) {
    Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
  }
  if ($null -ne $wrapper -and -not $wrapper.HasExited) {
    Stop-Process -Id $wrapper.Id -Force -ErrorAction SilentlyContinue
  }
  Restore-EnvironmentVariable 'HOME' $originalEnvironment.HOME
  Restore-EnvironmentVariable 'USERPROFILE' $originalEnvironment.USERPROFILE
  Restore-EnvironmentVariable 'APPDATA' $originalEnvironment.APPDATA
  Restore-EnvironmentVariable 'LOCALAPPDATA' $originalEnvironment.LOCALAPPDATA
  Restore-EnvironmentVariable 'AGENTARIUM_PORT' $originalEnvironment.AGENTARIUM_PORT
  Remove-Item -LiteralPath $smokeProfile -Recurse -Force -ErrorAction SilentlyContinue
}
