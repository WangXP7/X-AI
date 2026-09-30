@echo off
setlocal
title X-AI - Copy local unlock password
echo X-AI: reading the password protected by your Windows account...
powershell.exe -NoProfile -Command "$ErrorActionPreference='Stop'; try { Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'); Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1'); $path=Join-Path $env:LOCALAPPDATA 'X-AI\default-vault-password.dpapi'; if(-not (Test-Path -LiteralPath $path)){throw 'No local preset exists for this Windows account. Use your own API key in X-AI.'}; $protected=(Get-Content -Raw -LiteralPath $path).Trim() | ConvertTo-SecureString; $unlock=[System.Net.NetworkCredential]::new('', $protected).Password; Set-Clipboard -Value $unlock; $unlock=$null; Write-Host 'COPIED. Return to X-AI, paste into the unlock-password field, then click Unlock.'; Write-Host 'This copies the unlock password, not the API key.' } catch { Write-Host ('Unable to copy: '+$_.Exception.Message); exit 1 }"
echo.
pause
