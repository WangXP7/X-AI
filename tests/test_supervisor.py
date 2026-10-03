"""Service lifetime tests: isolated checkout, never touch production processes."""
import ctypes
from ctypes import wintypes as w
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'tools'))
import launch
import supervise
from test_local_startup import REPO, HTTP, free_port


class WatchdogPolicyTests(unittest.TestCase):
    def test_healthy_server_is_not_restarted(self):
        with patch.object(supervise, 'health', return_value={'pid':123}), patch.object(supervise, 'ensure_server') as start:
            self.assertEqual(supervise.maintain(4183), ({'pid':123},False));start.assert_not_called()

    def test_restart_keeps_exact_port(self):
        with patch.object(supervise, 'health', return_value=None), patch.object(supervise, 'ensure_server', return_value=({'pid':124},False)) as start:
            self.assertEqual(supervise.maintain(4183), ({'pid':124},True));start.assert_called_once_with(4183,strict=True)

    def test_conflicting_port_is_never_killed_or_replaced_by_another_port(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(launch,'LOCAL',Path(directory)), patch.object(launch,'health',return_value=None), patch.object(launch,'port_available',return_value=False) as available, patch.object(launch,'start_server') as start:
            with self.assertRaises(RuntimeError):launch.ensure_server(4183,strict=True)
            available.assert_called_once_with(4183);start.assert_not_called()


@unittest.skipUnless(os.name=='nt','Windows Job Object lifecycle')
class WatchdogIntegrationTests(unittest.TestCase):
    def test_survives_launcher_job_cleanup_and_restarts_dead_server(self):
        with tempfile.TemporaryDirectory(prefix='x-ai-watchdog-') as directory:
            root=Path(directory);(root/'tools').mkdir()
            for name in ['local_runtime.py','launch.py','serve.py','local_media.py','media_session.py','connector.py','process_lifetime.py','supervise.py','background.py']:
                shutil.copyfile(REPO/'tools'/name,root/'tools'/name)
            (root/'package.json').write_text('{"version":"isolated-watchdog-test"}')
            (root/'index.html').write_text('isolated watchdog')
            port=free_port();state=None
            try:
                wrapper=subprocess.run([sys.executable,str(Path(__file__).resolve()),'job-wrapper',str(root),str(port)],capture_output=True,text=True,timeout=35)
                self.assertEqual(wrapper.returncode,0,wrapper.stderr)
                state=json.loads((root/'.local/startup.json').read_text())
                guardian=json.loads((root/'.local/supervisor.json').read_text())
                self.assertFalse(state['lifetime']['killOnJobClose'],state['lifetime']);self.assertFalse(guardian['lifetime']['killOnJobClose'],guardian['lifetime'])
                with HTTP.open(f'http://127.0.0.1:{port}/__xai_health') as response:
                    identity=json.load(response)
                self.assertEqual(identity['workspace'],state['workspace'])
                old_pid=identity['pid'];os.kill(old_pid,signal.SIGTERM)
                deadline=time.monotonic()+45
                while time.monotonic()<deadline:
                    guardian=json.loads((root/'.local/supervisor.json').read_text())
                    if guardian.get('status')=='healthy' and guardian.get('serverPid')!=old_pid:break
                    time.sleep(.5)
                self.assertEqual(guardian['status'],'healthy');self.assertNotEqual(guardian['serverPid'],old_pid)
                self.assertEqual(guardian['port'],port);self.assertEqual(guardian['restarts'],1)
                with HTTP.open(f'http://127.0.0.1:{port}/__xai_health') as response:
                    self.assertEqual(json.load(response)['pid'],guardian['serverPid'])
            finally:
                (root/'.local').mkdir(exist_ok=True)
                (root/'.local/supervisor.stop').write_text('stop')
                deadline=time.monotonic()+15
                while time.monotonic()<deadline:
                    try:
                        guardian=json.loads((root/'.local/supervisor.json').read_text())
                        if guardian.get('status')=='stopped':break
                    except (OSError,ValueError):pass
                    time.sleep(.25)
                try:
                    with HTTP.open(f'http://127.0.0.1:{port}/__xai_health',timeout=2) as response:identity=json.load(response)
                    if state and identity.get('workspace')==state['workspace']:os.kill(identity['pid'],signal.SIGTERM)
                except (OSError,ValueError):pass
                time.sleep(.5)


def job_wrapper(root,port):
    # Reproduce terminal cleanup: nested Job Object kills descendants on close,
    # but explicitly permits correctly marked service children to break away.
    class Basic(ctypes.Structure):
        _fields_=[('time1',ctypes.c_longlong),('time2',ctypes.c_longlong),('flags',w.DWORD),('min',ctypes.c_size_t),('max',ctypes.c_size_t),('active',w.DWORD),('affinity',ctypes.c_size_t),('priority',w.DWORD),('scheduling',w.DWORD)]
    class Extended(ctypes.Structure):
        _fields_=[('basic',Basic),('io',ctypes.c_ulonglong*6),('memory',ctypes.c_size_t*4)]
    k=ctypes.WinDLL('kernel32',use_last_error=True);k.CreateJobObjectW.restype=w.HANDLE;k.GetCurrentProcess.restype=w.HANDLE
    job=k.CreateJobObjectW(None,None);info=Extended();info.basic.flags=0x2000|0x800
    if not k.SetInformationJobObject(w.HANDLE(job),9,ctypes.byref(info),ctypes.sizeof(info)):raise OSError(ctypes.get_last_error())
    if not k.AssignProcessToJobObject(w.HANDLE(job),w.HANDLE(k.GetCurrentProcess())):raise OSError(ctypes.get_last_error())
    child=subprocess.run([sys.executable,str(Path(root)/'tools/launch.py'),'--no-browser','--port',str(port)],capture_output=True,text=True,timeout=30)
    print(child.stdout,flush=True)
    if child.returncode:raise RuntimeError(child.stderr)
    # The OS closes the job handle at process exit. Escaped service/guardian live.


if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='job-wrapper':job_wrapper(sys.argv[2],int(sys.argv[3]))
    else:unittest.main()
