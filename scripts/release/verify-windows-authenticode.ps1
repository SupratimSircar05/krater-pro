[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\z')]
  [string] $Version,

  [Parameter(Mandatory = $true)]
  [string] $ReleaseDirectory
)

$ErrorActionPreference = "Stop"
$repository = "https://github.com/SupratimSircar05/krater-pro"
$releaseRoot = (Resolve-Path -LiteralPath $ReleaseDirectory).Path
$installerName = "Krater-Pro-Setup-$Version-x64.exe"
$installerPath = Join-Path $releaseRoot $installerName
$innerExecutable = Join-Path (Join-Path $releaseRoot "win-unpacked") "KraterPro.exe"

if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
  throw "The exact Windows installer was not produced: $installerName"
}
if (-not (Test-Path -LiteralPath $innerExecutable -PathType Leaf)) {
  throw "The shipped inner Windows executable was not produced: $innerExecutable"
}

$releaseExecutables = @(Get-ChildItem -LiteralPath $releaseRoot -File -Filter "*.exe")
if ($releaseExecutables.Count -eq 0) {
  throw "No Windows release executables were produced."
}
$executablesToVerify = @($releaseExecutables) + @(
  Get-Item -LiteralPath $innerExecutable
)

$installerSignature = $null
foreach ($executable in $executablesToVerify) {
  $signature = Get-AuthenticodeSignature -LiteralPath $executable.FullName
  if ($signature.Status -ne "Valid") {
    throw "Invalid Authenticode signature for $($executable.Name): $($signature.Status)"
  }
  if ($null -eq $signature.SignerCertificate) {
    throw "Authenticode signer certificate is missing for $($executable.Name)."
  }
  if ($null -eq $signature.TimeStamperCertificate) {
    throw "Authenticode timestamp is missing for $($executable.Name)."
  }
  if ($executable.FullName -eq (Get-Item -LiteralPath $installerPath).FullName) {
    $installerSignature = $signature
  }
}

if ($null -eq $installerSignature) {
  throw "The exact Windows installer was not included in signature verification."
}

$installerSha256 = (
  Get-FileHash -LiteralPath $installerPath -Algorithm SHA256
).Hash.ToLowerInvariant()
$receipt = [ordered]@{
  schemaVersion = 1
  product = "Krater Pro"
  version = $Version
  artifact = $installerName
  sha256 = $installerSha256
  source = [ordered]@{
    repository = $repository
    ref = "refs/tags/v$Version"
  }
  authenticode = [ordered]@{
    status = "Valid"
    signerSubject = $installerSignature.SignerCertificate.Subject
    signerThumbprint = $installerSignature.SignerCertificate.Thumbprint.ToLowerInvariant()
    timestampSignerSubject = $installerSignature.TimeStamperCertificate.Subject
    timestampSignerThumbprint = $installerSignature.TimeStamperCertificate.Thumbprint.ToLowerInvariant()
  }
}

$receiptPath = Join-Path $releaseRoot "krater-pro-windows-$Version.authenticode.json"
$json = ($receipt | ConvertTo-Json -Depth 5) + [Environment]::NewLine
$stream = [IO.File]::Open(
  $receiptPath,
  [IO.FileMode]::CreateNew,
  [IO.FileAccess]::Write,
  [IO.FileShare]::None
)
try {
  $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false))
  try {
    $writer.Write($json)
  }
  finally {
    $writer.Dispose()
  }
}
finally {
  $stream.Dispose()
}

Write-Output $receiptPath
