"""Launch only X-AI helpers outside a terminal's Windows kill-on-close job."""
import os
import subprocess
import sys
import json
import base64
from pathlib import Path


def job_lifetime():
    if os.name != 'nt':
        return {'detachedSession': True}
    import ctypes
    from ctypes import wintypes as w
    class Basic(ctypes.Structure):
        _fields_=[('t1',ctypes.c_longlong),('t2',ctypes.c_longlong),('flags',w.DWORD),('min',ctypes.c_size_t),('max',ctypes.c_size_t),('active',w.DWORD),('affinity',ctypes.c_size_t),('priority',w.DWORD),('schedule',w.DWORD)]
    class Extended(ctypes.Structure):
        _fields_=[('basic',Basic),('io',ctypes.c_ulonglong*6),('memory',ctypes.c_size_t*4)]
    kernel=ctypes.WinDLL('kernel32',use_last_error=True);kernel.GetCurrentProcess.restype=w.HANDLE
    member=w.BOOL();kernel.IsProcessInJob(w.HANDLE(kernel.GetCurrentProcess()),None,ctypes.byref(member))
    info=Extended();known=bool(kernel.QueryInformationJobObject(None,9,ctypes.byref(info),ctypes.sizeof(info),None)) if member.value else True
    return {'inJob':bool(member.value),'limitsKnown':known,'killOnJobClose':bool(info.basic.flags & 0x2000) if known else None,'flags':info.basic.flags if known else None}


class WindowsProcess:
    """Own a handle to the exact child instance, never terminate by a stale PID."""
    def __init__(self, pid):
        import ctypes
        from ctypes import wintypes as w
        self.ctypes=ctypes;self.pid=pid;self.k=ctypes.WinDLL('kernel32',use_last_error=True)
        self.k.OpenProcess.restype=w.HANDLE
        self.handle=self.k.OpenProcess(0x1000|0x100000|0x1,False,pid)
        if not self.handle and ctypes.get_last_error()!=87:raise OSError(ctypes.get_last_error(),'Cannot track X-AI child process')
    def poll(self):
        if not self.handle:return 0
        from ctypes import wintypes as w
        code=w.DWORD()
        if not self.k.GetExitCodeProcess(w.HANDLE(self.handle),self.ctypes.byref(code)):raise OSError(self.ctypes.get_last_error())
        return None if code.value==259 else code.value
    def terminate(self):
        from ctypes import wintypes as w
        if self.poll() is None:self.k.TerminateProcess(w.HANDLE(self.handle),1)
    kill=terminate
    def wait(self, timeout=None):
        if not self.handle:return 0
        from ctypes import wintypes as w
        result=self.k.WaitForSingleObject(w.HANDLE(self.handle),0xffffffff if timeout is None else int(timeout*1000))
        if result==258:raise subprocess.TimeoutExpired('X-AI background process',timeout)
        return self.poll()
    def __del__(self):
        if getattr(self,'handle',None):
            try:
                from ctypes import wintypes as w
                self.k.CloseHandle(w.HANDLE(self.handle));self.handle=None
            except Exception:
                pass


def start_background(root, role, port):
    if role not in ('server','watchdog'):
        raise ValueError('Unknown X-AI background role')
    interpreter=Path(sys.executable)
    if os.name=='nt' and interpreter.with_name('pythonw.exe').is_file():interpreter=interpreter.with_name('pythonw.exe')
    command=[str(interpreter),str(Path(root)/'tools/background.py'),role,'--port',str(port)]
    if os.name!='nt':
        return subprocess.Popen(command,cwd=str(root),stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=True,start_new_session=True)
    # Windows may place a terminal under multiple nested kill-on-close jobs.
    # CIM starts the helper through Windows, outside that terminal ancestry.
    # Only fixed helper roles/paths/ports are passed; no shell interpolation.
    spec=base64.b64encode(json.dumps({'command':subprocess.list2cmdline(command),'cwd':str(root)}).encode()).decode()
    script=f'''$ErrorActionPreference='Stop'
$spec=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{spec}')) | ConvertFrom-Json
$startup=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{{ShowWindow=[uint16]0}}
$result=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{{CommandLine=$spec.command;CurrentDirectory=$spec.cwd;ProcessStartupInformation=$startup}}
$result | Select-Object ProcessId,ReturnValue | ConvertTo-Json -Compress
'''
    encoded=base64.b64encode(script.encode('utf-16le')).decode()
    system_root=os.environ.get('SystemRoot',r'C:\Windows')
    powershell=str(Path(system_root)/'System32/WindowsPowerShell/v1.0/powershell.exe')
    result=subprocess.run([powershell,'-NoProfile','-NonInteractive','-EncodedCommand',encoded],capture_output=True,text=True,timeout=25,creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode:raise RuntimeError('Windows could not start the independent X-AI helper: '+result.stderr[-800:])
    value=json.loads(result.stdout.strip())
    if value.get('ReturnValue')!=0:raise RuntimeError('Windows helper start returned '+str(value.get('ReturnValue')))
    return WindowsProcess(value['ProcessId'])
