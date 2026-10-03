"""Local-only startup checks. Never calls AgnesAI or stops an existing service."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import ProxyHandler, build_opener

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / 'tools'))
import launch
from local_runtime import APP_ID, workspace_id

HTTP = build_opener(ProxyHandler({}))


def free_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.payload = {'app': APP_ID, 'workspace': workspace_id(), 'pid': 42}
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                body = json.dumps(owner.payload).encode()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_):
                pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_port

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_health_accepts_this_checkout(self):
        self.assertEqual(launch.health(self.port), self.payload)

    def test_health_rejects_other_checkout(self):
        self.payload['workspace'] = 'different-checkout'
        self.assertIsNone(launch.health(self.port))

    def test_health_rejects_other_application(self):
        self.payload['app'] = 'other-local-service'
        self.assertIsNone(launch.health(self.port))

    def test_busy_port_is_not_available(self):
        self.assertFalse(launch.port_available(self.port))


class LauncherLogicTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='x-ai-startup-')
        self.addCleanup(self.directory.cleanup)
        local = Path(self.directory.name)
        for name, value in [('LOCAL', local), ('STATE', local / 'startup.json'), ('LOG', local / 'server.log')]:
            patcher = patch.object(launch, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_candidates_keep_saved_origin_and_remove_invalid_duplicates(self):
        self.assertEqual(launch.candidate_ports(4183, 4183)[:2], [4183, 4173])
        self.assertEqual(launch.candidate_ports(None, 49000)[0], 49000)
        self.assertNotIn(80, launch.candidate_ports(80, '4183'))

    def test_reuses_existing_server_before_starting_on_another_port(self):
        identity = {'app': APP_ID, 'workspace': workspace_id(), 'pid': 123}
        with patch.object(launch, 'health', side_effect=lambda p: identity if p == 4183 else None), \
                patch.object(launch, 'start_server') as start:
            state, reused = launch.ensure_server(49000)
        self.assertTrue(reused)
        self.assertEqual(state['port'], 4183)
        start.assert_not_called()

    def test_skips_occupied_foreign_port(self):
        identity = {'app': APP_ID, 'workspace': workspace_id(), 'pid': 123}
        with patch.object(launch, 'health', return_value=None), \
                patch.object(launch, 'port_available', side_effect=lambda p: p != 4173), \
                patch.object(launch, 'start_server', return_value=identity) as start:
            state, reused = launch.ensure_server(4173)
        self.assertFalse(reused)
        self.assertEqual(state['port'], 4183)
        start.assert_called_once_with(4183)

    def test_corrupt_checkpoint_does_not_prevent_start(self):
        launch.STATE.write_text('{unfinished', encoding='utf-8')
        self.assertIsNone(launch.saved_port())


class DetachedStartupTests(unittest.TestCase):
    def test_two_launchers_share_one_server_that_survives_their_exit(self):
        with tempfile.TemporaryDirectory(prefix='x-ai-startup-integration-') as directory:
            root = Path(directory)
            (root / 'tools').mkdir()
            for name in ['local_runtime.py', 'launch.py', 'serve.py', 'local_media.py', 'media_session.py', 'connector.py', 'process_lifetime.py', 'background.py']:
                shutil.copyfile(REPO / 'tools' / name, root / 'tools' / name)
            (root / 'package.json').write_text('{"version":"startup-test"}', encoding='utf-8')
            (root / 'index.html').write_text('<h1>X-AI isolated startup test</h1>', encoding='utf-8')
            port = free_port()
            command = [sys.executable, str(root / 'tools' / 'launch.py'), '--port', str(port), '--no-browser', '--no-watchdog']
            parents = [subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                       for _ in range(2)]
            state = None
            try:
                outputs = [p.communicate(timeout=35) for p in parents]
                self.assertEqual([p.returncode for p in parents], [0, 0], outputs)
                state = json.loads((root / '.local' / 'startup.json').read_text())
                self.assertEqual(state['port'], port)
                self.assertEqual(state['workspace'], workspace_id(root))
                self.assertEqual(sum('already running' in o[0] for o in outputs), 1)
                self.assertTrue(all(f"PID {state['pid']}" in o[0] for o in outputs))
                with HTTP.open(f'http://127.0.0.1:{port}/__xai_health') as response:
                    identity = json.load(response)
                self.assertEqual(identity['pid'], state['pid'])
                with HTTP.open(state['url']) as response:
                    self.assertIn(b'isolated startup test', response.read())
                for route in ['.local/startup.json', '.git/config', 'test-results/ignored.txt']:
                    with self.assertRaises(HTTPError) as error:
                        HTTP.open(state['url'] + route)
                    self.assertEqual(error.exception.code, 404)
                    error.exception.close()
                # A stale PID alone never counts as a running site.
                state['pid'] = 999999
                (root / '.local' / 'startup.json').write_text(json.dumps(state))
                again = subprocess.run(command, capture_output=True, text=True, timeout=20)
                self.assertEqual(again.returncode, 0, again.stderr)
                self.assertIn(f"PID {identity['pid']}", again.stdout)
            finally:
                for parent in parents:
                    if parent.poll() is None:
                        parent.terminate()
                        parent.wait(timeout=5)
                # Stop only the exact isolated test server, verified by workspace.
                if (root / '.local' / 'startup.json').exists():
                    recorded = json.loads((root / '.local' / 'startup.json').read_text())
                    try:
                        with HTTP.open(f'http://127.0.0.1:{port}/__xai_health', timeout=1) as response:
                            identity = json.load(response)
                        if identity.get('workspace') == workspace_id(root):
                            if os.name == 'nt':
                                import ctypes
                                kernel = ctypes.WinDLL('kernel32', use_last_error=True)
                                kernel.OpenProcess.restype = ctypes.c_void_p
                                kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
                                kernel.CloseHandle.argtypes = [ctypes.c_void_p]
                                handle = kernel.OpenProcess(0x00100000, False, identity['pid'])
                                try:
                                    os.kill(identity['pid'], 15)
                                    if handle:
                                        self.assertEqual(kernel.WaitForSingleObject(handle, 5000), 0)
                                finally:
                                    if handle:
                                        kernel.CloseHandle(handle)
                            else:
                                os.kill(identity['pid'], 15)
                    except OSError:
                        pass


if __name__ == '__main__':
    unittest.main(verbosity=2)
