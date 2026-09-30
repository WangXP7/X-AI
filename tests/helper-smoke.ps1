# Tests the shipped command with synthetic DPAPI data and a mocked clipboard.
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1')
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1')
$projectPath = if ($PSScriptRoot) { [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')) } else { (Get-Location).Path }
$caseRoot = Join-Path $projectPath ('.local\helper-test-' + [Guid]::NewGuid().ToString('N'))
$caseDirectory = Join-Path $caseRoot 'X-AI'
$caseFile = Join-Path $caseDirectory 'default-vault-password.dpapi'
$savedLocalAppData = $env:LOCALAPPDATA
$script:copiedValue = $null
function global:Set-Clipboard { param([string]$Value) $script:copiedValue = $Value }
try {
    New-Item -ItemType Directory -Path $caseDirectory -Force | Out-Null
    ConvertTo-SecureString 'synthetic-helper-unlock-password' -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -LiteralPath $caseFile
    $env:LOCALAPPDATA = $caseRoot
    $line = Get-Content -LiteralPath (Join-Path $projectPath 'tools\copy-unlock-password.cmd') | Where-Object { $_.StartsWith('powershell.exe ') }
    $marker = '-Command "'
    $command = $line.Substring($line.IndexOf($marker) + $marker.Length)
    $command = $command.Substring(0, $command.Length - 1)
    & ([scriptblock]::Create($command))
    if ($script:copiedValue -ne 'synthetic-helper-unlock-password') { throw 'Clipboard output mismatch' }
    Write-Output 'PASS: synthetic DPAPI password copied through the mocked clipboard. User clipboard untouched.'
} finally {
    $env:LOCALAPPDATA = $savedLocalAppData
    Remove-Item -LiteralPath $caseFile -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $caseDirectory -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $caseRoot -ErrorAction SilentlyContinue
    Remove-Item Function:\Set-Clipboard -ErrorAction SilentlyContinue
}
