param(
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathRooted($OutputDirectory)) { throw 'OutputDirectory must be absolute.' }
$hostDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$hostSource = Join-Path $PSScriptRoot 'background-service-host.cs'
$hostExecutable = Join-Path $hostDirectory 'DoufengBackgroundHost.exe'
$hostManifest = Join-Path $hostDirectory 'host-build.json'
$hostSourceHash = (Get-FileHash -LiteralPath $hostSource -Algorithm SHA256).Hash
$hostBuild = $null
if (Test-Path -LiteralPath $hostManifest -PathType Leaf) {
    try { $hostBuild = Get-Content -LiteralPath $hostManifest -Raw | ConvertFrom-Json } catch {}
}
$hostReady = $false
if ($hostBuild.sourceHash -eq $hostSourceHash -and (Test-Path -LiteralPath $hostExecutable -PathType Leaf)) {
    $hostReady = (Get-FileHash -LiteralPath $hostExecutable -Algorithm SHA256).Hash -eq $hostBuild.executableHash
}
if (-not $CheckOnly -and -not $hostReady) {
    $hostCompiler = @(
        (Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
        (Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $hostCompiler) { throw 'The local .NET Framework C# compiler is unavailable.' }
    New-Item -ItemType Directory -Path $hostDirectory -Force | Out-Null
    $hostTemporary = Join-Path $hostDirectory ('host-build-' + [Guid]::NewGuid().ToString('N') + '.exe')
    try {
        $hostReference = Join-Path ([IO.Path]::GetDirectoryName($hostCompiler)) 'System.Web.Extensions.dll'
        & $hostCompiler /nologo /target:winexe /optimize+ ('/reference:' + $hostReference) ('/out:' + $hostTemporary) $hostSource | Out-Host
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $hostTemporary -PathType Leaf)) { throw 'WinExe host compilation failed.' }
        Move-Item -LiteralPath $hostTemporary -Destination $hostExecutable -Force
        [pscustomobject]@{
            sourceHash = $hostSourceHash
            executableHash = (Get-FileHash -LiteralPath $hostExecutable -Algorithm SHA256).Hash
            builtAt = (Get-Date -Format o)
        } | ConvertTo-Json | Set-Content -LiteralPath $hostManifest -Encoding utf8
        $hostReady = $true
    } finally {
        if (Test-Path -LiteralPath $hostTemporary) { Remove-Item -LiteralPath $hostTemporary -Force }
    }
}
[pscustomobject]@{ executable = $hostExecutable; needsBuild = -not $hostReady; sourceHash = $hostSourceHash }
