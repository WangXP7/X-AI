"""OS-backed recovery for this checkout when both local helpers have stopped.

The Windows task runs once per minute and at this user's logon. It never reads
production projects or calls a generation API. Deliberate watchdog stops persist.
"""
import argparse
import base64
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from local_runtime import APP_ID, ROOT, workspace_id

TASK_PREFIX = 'X-AI-Recovery-'


def task_spec(root=ROOT, port=4183):
    if type(port) is not int or not 1024 <= port <= 65535:
        raise ValueError('Invalid X-AI recovery port')
    root = Path(root).resolve()
    interpreter = Path(sys.executable)
    if interpreter.with_name('pythonw.exe').is_file():
        interpreter = interpreter.with_name('pythonw.exe')
    identity = workspace_id(root)
    return dict(name=TASK_PREFIX + identity[:20],
                description=f'{APP_ID}; workspace={identity}; local media recovery',
                executable=str(interpreter),
                arguments=subprocess.list2cmdline([str(root / 'tools/background.py'),
                                                  'recovery', '--port', str(port)]),
                directory=str(root), port=port, workspace=identity)


def windows_task(spec, remove=False):
    # Only a fixed PowerShell program executes; paths/arguments travel as data.
    payload = base64.b64encode(json.dumps(spec).encode('utf-8')).decode('ascii')
    script = f"""$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new()
$spec=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{payload}')) | ConvertFrom-Json
$existing=Get-ScheduledTask -TaskName $spec.name -TaskPath '\\' -ErrorAction SilentlyContinue
if ($existing -and $existing.Description -ne $spec.description) {{ throw 'Refusing to change an unrelated Windows task.' }}
"""
    if remove:
        script += r"""if ($existing) { Unregister-ScheduledTask -TaskName $spec.name -TaskPath '\' -Confirm:$false }
@{name=$spec.name;removed=$true} | ConvertTo-Json -Compress
"""
    else:
        script += r"""$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$matching=$existing -and $existing.Actions.Count -eq 1 -and $existing.Actions[0].Execute -eq $spec.executable -and $existing.Actions[0].Arguments -eq $spec.arguments -and $existing.Actions[0].WorkingDirectory -eq $spec.directory -and $existing.Principal.LogonType -eq 'Interactive' -and $existing.Settings.Enabled -and $existing.Triggers.Count -eq 2 -and ($existing.Triggers | Where-Object { $_.Repetition.Interval -eq 'PT1M' }) -and ($existing.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' })
if (-not $matching) {
  $action=New-ScheduledTaskAction -Execute $spec.executable -Argument $spec.arguments -WorkingDirectory $spec.directory
  $repeat=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
  $logon=New-ScheduledTaskTrigger -AtLogOn -User $sid
  $principal=New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
  $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Seconds 90) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $spec.name -TaskPath '\' -Description $spec.description -Action $action -Trigger @($repeat,$logon) -Principal $principal -Settings $settings -Force | Out-Null
}
$task=Get-ScheduledTask -TaskName $spec.name -TaskPath '\'
if ($task.Actions[0].Execute -ne $spec.executable -or $task.Actions[0].Arguments -ne $spec.arguments -or -not $task.Settings.Enabled) { throw 'Windows recovery task verification failed.' }
@{name=$task.TaskName;enabled=$task.Settings.Enabled;intervalSeconds=60;logon=$true;user=$task.Principal.UserId;state=[string]$task.State} | ConvertTo-Json -Compress
"""
    encoded = base64.b64encode(script.encode('utf-16le')).decode('ascii')
    executable = str(Path(os.environ.get('SystemRoot', r'C:\Windows')) /
                     'System32/WindowsPowerShell/v1.0/powershell.exe')
    result = subprocess.run([executable, '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
                            capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=30,
                            creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode:
        raise RuntimeError('Windows recovery registration failed: ' + result.stderr[-1200:])
    return json.loads(result.stdout.strip())


def checkpoint(filename, **value):
    local = ROOT / '.local'
    local.mkdir(exist_ok=True)
    target = local / filename
    temporary = target.with_suffix('.tmp')
    temporary.write_text(json.dumps(dict(app=APP_ID, workspace=workspace_id(),
        checkedAt=time.time(), checkedTime=datetime.now(timezone.utc).isoformat(), **value),
        ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(target)


def install(port):
    if os.name != 'nt':
        return {'supported': False}
    value = windows_task(task_spec(port=port))
    checkpoint('recovery-task.json', **value, port=port)
    return value


def recover(port):
    from launch import ensure_server, ensure_supervisor
    # Scheduled ticks must never undo an explicit maintenance/user stop.
    if (ROOT / '.local/supervisor.stop').exists():
        checkpoint('recovery.json', status='paused', port=port)
        return 0
    try:
        identity, reused = ensure_server(port, strict=True)
        guardian = ensure_supervisor(port, resume=False)
        checkpoint('recovery.json', status='healthy', port=port,
                   serverPid=identity['pid'], watchdogPid=guardian['pid'], reused=reused)
        return 0
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        checkpoint('recovery.json', status='waiting', port=port, error=str(error))
        print(f'Local recovery will retry next tick: {error}', flush=True)
        return 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=4183)
    parser.add_argument('--uninstall', action='store_true')
    args = parser.parse_args()
    task_spec(port=args.port)  # Validate before making any mutation.
    if args.uninstall:
        local = ROOT / '.local'; local.mkdir(exist_ok=True)
        (local / 'supervisor.stop').write_text('stop', encoding='ascii')
        if os.name == 'nt':
            value = windows_task(task_spec(port=args.port), remove=True)
            checkpoint('recovery-task.json', **value, port=args.port)
        print('X-AI automatic recovery disabled; existing server is left running.')
        return 0
    return recover(args.port)


if __name__ == '__main__':
    sys.exit(main())
