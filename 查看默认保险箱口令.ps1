$ErrorActionPreference = 'Stop'
$vaultPasswordPath = Join-Path $env:LOCALAPPDATA 'X-AI\default-vault-password.dpapi'
if (-not (Test-Path -LiteralPath $vaultPasswordPath)) { throw 'This computer has no provisioned default vault. Enter your own API key in X-AI settings.' }
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$securePassword = (Get-Content -Raw -LiteralPath $vaultPasswordPath).Trim() | ConvertTo-SecureString
$credential = New-Object System.Net.NetworkCredential('', $securePassword)
Write-Host 'Paste this unlock password into the X-AI vault password field. This is NOT your API key:'
Write-Host $credential.Password
Read-Host 'Press Enter to close'
