"""Recovery regression: both helpers gone, real Windows task brings them back."""
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
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import recovery
import launch
from local_runtime import workspace_id
from test_local_startup import REPO, HTTP, free_port


class RecoveryPolicyTests(unittest.TestCase):
    def test_maintenance_stop_blocks_all_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / '.local').mkdir()
            (root / '.local/supervisor.stop').write_text('stop')
            with patch.object(recovery, 'ROOT', root), patch.object(launch, 'ensure_server') as server, \
                    patch.object(launch, 'ensure_supervisor') as guardian:
                self.assertEqual(recovery.recover(4183), 0)
                server.assert_not_called(); guardian.assert_not_called()
                self.assertEqual(json.loads((root / '.local/recovery.json').read_text())['status'], 'paused')

    def test_recovery_uses_exact_port_and_does_not_resume_stop(self):
        with patch.object(launch, 'ensure_server', return_value=({'pid': 12}, True)) as server, \
                patch.object(launch, 'ensure_supervisor', return_value={'pid': 13}) as guardian, \
                patch.object(recovery, 'checkpoint'), patch.object(Path, 'exists', return_value=False):
            self.assertEqual(recovery.recover(4183), 0)
            server.assert_called_once_with(4183, strict=True)
            guardian.assert_called_once_with(4183, resume=False)

    def test_foreign_port_stays_waiting_and_does_not_start_guardian(self):
        with patch.object(launch, 'ensure_server', side_effect=RuntimeError('occupied')) as server, \
                patch.object(launch, 'ensure_supervisor') as guardian, \
                patch.object(recovery, 'checkpoint') as record, patch.object(Path, 'exists', return_value=False):
            self.assertEqual(recovery.recover(4183), 1)
            server.assert_called_once_with(4183, strict=True); guardian.assert_not_called()
            self.assertEqual(record.call_args.kwargs['status'], 'waiting')

    def test_task_identity_and_fixed_arguments(self):
        first = recovery.task_spec(Path('C:/project with spaces/中文'), 4183)
        self.assertEqual(first['name'], recovery.task_spec(Path('C:/project with spaces/中文'), 49000)['name'])
        self.assertNotEqual(first['name'], recovery.task_spec(Path('C:/other project'), 4183)['name'])
        self.assertIn('background.py', first['arguments']); self.assertIn('recovery --port 4183', first['arguments'])
        with self.assertRaises(ValueError): recovery.task_spec(port=80)


@unittest.skipUnless(os.name == 'nt', 'Windows scheduled recovery integration')
class RecoveryIntegrationTests(unittest.TestCase):
    def test_real_task_recovers_dead_server_and_watchdog_without_launcher(self):
        with tempfile.TemporaryDirectory(prefix='x-ai-recovery-中文-') as directory:
            root = Path(directory); (root / 'tools').mkdir()
            for name in ['local_runtime.py', 'launch.py', 'serve.py', 'local_media.py', 'media_session.py',
                         'connector.py', 'process_lifetime.py', 'supervise.py', 'background.py', 'recovery.py']:
                shutil.copyfile(REPO / 'tools' / name, root / 'tools' / name)
            (root / 'package.json').write_text('{"version":"isolated-recovery-test"}')
            (root / 'index.html').write_text('isolated recovery')
            port = free_port(); spec = recovery.task_spec(root, port); registered = False
            state = guardian = None
            try:
                child = subprocess.run([sys.executable, str(root / 'tools/launch.py'), '--no-browser',
                                        '--port', str(port)], capture_output=True, text=True, timeout=60)
                state = json.loads((root / '.local/startup.json').read_text())
                guardian = json.loads((root / '.local/supervisor.json').read_text())
                registered = (root / '.local/recovery-task.json').exists()
                self.assertEqual(child.returncode, 0, child.stderr)
                task = json.loads((root / '.local/recovery-task.json').read_text())
                self.assertTrue(task['enabled']); self.assertTrue(task['logon'])
                self.assertEqual(task['intervalSeconds'], 60); self.assertEqual(task['name'], spec['name'])
                # Reinstall/relaunch must reuse the exact same OS task and helpers.
                again = subprocess.run([sys.executable, str(root / 'tools/launch.py'), '--no-browser',
                                        '--port', str(port)], capture_output=True, text=True, timeout=60)
                self.assertEqual(again.returncode, 0, again.stderr)
                self.assertEqual(json.loads((root / '.local/supervisor.json').read_text())['pid'], guardian['pid'])
                old_server, old_guardian = state['pid'], guardian['pid']
                # This is the defect not covered by v1.2.7's service-only kill test.
                os.kill(old_guardian, signal.SIGTERM); os.kill(old_server, signal.SIGTERM)
                began = time.monotonic(); deadline = began + 100
                while time.monotonic() < deadline:
                    try:
                        result = json.loads((root / '.local/recovery.json').read_text())
                        if result.get('status') == 'healthy' and result['serverPid'] != old_server and result['watchdogPid'] != old_guardian:
                            break
                    except (OSError, ValueError): pass
                    time.sleep(.5)
                else: self.fail('OS task did not recover both dead helpers')
                with HTTP.open(f'http://127.0.0.1:{port}/__xai_health') as response: identity = json.load(response)
                self.assertEqual(identity['workspace'], state['workspace']); self.assertEqual(identity['pid'], result['serverPid'])
                self.assertLess(time.monotonic() - began, 100)
                print(json.dumps({'doubleExitRecovered': True, 'elapsedSeconds': round(time.monotonic() - began, 2),
                                  'samePort': port, 'serverChanged': True, 'watchdogChanged': True}), flush=True)
                # A deliberate stop remains effective even if the scheduled tick runs.
                (root / '.local/supervisor.stop').write_text('stop')
                paused = subprocess.run([sys.executable, str(root / 'tools/recovery.py'), '--port', str(port)],
                                        capture_output=True, text=True, timeout=15)
                self.assertEqual(paused.returncode, 0, paused.stderr)
                self.assertEqual(json.loads((root / '.local/recovery.json').read_text())['status'], 'paused')
            finally:
                (root / '.local').mkdir(exist_ok=True)
                (root / '.local/supervisor.stop').write_text('stop')
                recovery.windows_task(spec, remove=True)
                # Only exact isolated helper PIDs under this verified workspace.
                for name in ['supervisor.json', 'startup.json']:
                    try:
                        value = json.loads((root / '.local' / name).read_text())
                        if value.get('workspace') == workspace_id(root):
                            from process_lifetime import WindowsProcess
                            process = WindowsProcess(value['pid'])
                            if process.poll() is None: process.terminate(); process.wait(timeout=5)
                    except (OSError, ValueError): pass
                time.sleep(.3)


if __name__ == '__main__':
    unittest.main()
