"""Run browser.mjs with an isolated subpath server and clean up only that child."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent.parent

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', default='node')
    args = parser.parse_args()
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    result_dir = ROOT / 'test-results'
    result_dir.mkdir(exist_ok=True)
    base = f'http://127.0.0.1:{port}/x-ai/'
    with (result_dir / 'prefix-v114.log').open('w', encoding='utf-8') as log:
        server = subprocess.Popen([sys.executable, str(ROOT / 'tools' / 'serve.py'), '--port', str(port), '--prefix', 'x-ai'],
                                  cwd=ROOT, stdout=log, stderr=log,
                                  creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        try:
            for _ in range(50):
                if server.poll() is not None:
                    raise RuntimeError('Isolated test server exited before readiness')
                try:
                    with urllib.request.urlopen(base + '__xai_health', timeout=1) as response:
                        identity = json.load(response)
                    if identity['pid'] == server.pid and identity['app'] == 'x-ai-video-studio':
                        break
                except (OSError, urllib.error.URLError):
                    time.sleep(.1)
            else:
                raise RuntimeError('Isolated test server failed readiness')
            env = dict(os.environ, XAI_TEST_PREFIX_URL=base)
            return subprocess.run([args.node, str(ROOT / 'tests' / 'browser.mjs')], cwd=ROOT, env=env).returncode
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=5)

if __name__ == '__main__':
    raise SystemExit(main())
