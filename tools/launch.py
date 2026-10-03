"""Start or reuse this checkout's loopback server independently of the terminal."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener
import webbrowser

from local_runtime import APP_ID, ROOT, workspace_id
from process_lifetime import start_background

LOCAL = ROOT / '.local'
STATE = LOCAL / 'startup.json'
LOG = LOCAL / 'static-server.log'
HTTP = build_opener(ProxyHandler({}))


def health(port):
    try:
        with HTTP.open(f'http://127.0.0.1:{port}/__xai_health', timeout=0.6) as response:
            value = json.loads(response.read(4096))
        if isinstance(value, dict) and value.get('app') == APP_ID and value.get('workspace') == workspace_id(ROOT):
            return value
    except URLError as error:
        if hasattr(error, 'close'):
            error.close()
    except (OSError, ValueError):
        pass
    return None


def port_available(port):
    with socket.socket() as probe:
        try:
            probe.bind(('127.0.0.1', port))
            return True
        except OSError:
            return False


def candidate_ports(requested=None, saved=None):
    choices = [requested, saved, 4183, 4173, *range(4184, 4194)]
    return list(dict.fromkeys(p for p in choices if type(p) is int and 1024 <= p <= 65535))


@contextmanager
def launch_lock():
    """Serialize double-clicks; OS releases the lock when a launcher exits."""
    LOCAL.mkdir(exist_ok=True)
    with (LOCAL / 'startup.lock').open('a+b') as handle:
        if handle.tell() == 0:
            handle.write(b'0')
            handle.flush()
        deadline = time.monotonic() + 15
        while True:
            try:
                handle.seek(0)
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise RuntimeError('Another X-AI launcher is still starting. Please retry shortly.')
                time.sleep(0.2)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == 'nt':
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def saved_port():
    try:
        value = json.loads(STATE.read_text(encoding='utf-8'))
        return value.get('port') if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def remember(port, identity):
    value = {**identity, 'port': port, 'url': f'http://127.0.0.1:{port}/',
             'checked_at': datetime.now(timezone.utc).isoformat()}
    temporary = STATE.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2), encoding='utf-8')
    temporary.replace(STATE)
    return value


def start_server(port):
    process = start_background(ROOT, 'server', port)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        identity = health(port)
        if identity:
            return identity
        if process.poll() is not None:
            break
        time.sleep(0.2)
    # A server that failed to become ready is ours; never terminate port occupants.
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)
    raise RuntimeError(f'X-AI could not start on port {port}. Details: {LOG}')


def ensure_server(requested=None, strict=False):
    with launch_lock():
        ports = [requested] if strict else candidate_ports(requested, saved_port())
        # Search all known ports before choosing a free one to avoid duplicates.
        for port in ports:
            identity = health(port)
            if identity:
                return remember(port, identity), True
        for port in ports:
            if port_available(port):
                return remember(port, start_server(port)), False
    raise RuntimeError('All X-AI candidate ports are busy. Retry with --port followed by a free port.')


def ensure_supervisor(port):
    from supervise import singleton
    (LOCAL / 'supervisor.stop').unlink(missing_ok=True)
    with singleton() as available:
        if not available:
            try:
                value=json.loads((LOCAL / 'supervisor.json').read_text(encoding='utf-8'))
                if value.get('app')==APP_ID and value.get('workspace')==workspace_id(ROOT) and value.get('port')==port and value.get('status') in ('healthy','waiting') and time.time()-value.get('checkedAt',0)<40:
                    return value
            except (OSError, ValueError):
                pass
    # The child holds an OS singleton lock; concurrent launchers cannot create
    # competing restart loops. No PID-only termination of an existing process.
    process=start_background(ROOT, 'watchdog', port)
    deadline=time.monotonic()+12
    while time.monotonic()<deadline:
        try:
            value=json.loads((LOCAL / 'supervisor.json').read_text(encoding='utf-8'))
            if value.get('app')==APP_ID and value.get('workspace')==workspace_id(ROOT) and value.get('port')==port and value.get('status') in ('healthy','waiting') and time.time()-value.get('checkedAt',0)<40:
                return value
        except (OSError, ValueError):
            pass
        time.sleep(.2)
    raise RuntimeError('Local service started, but watchdog startup was not confirmed. See .local/supervisor.log.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, help='Preferred port; a running X-AI server is reused first.')
    parser.add_argument('--no-browser', action='store_true', help='Start/check without opening the browser.')
    parser.add_argument('--no-watchdog', action='store_true', help='Start one service without its background watchdog (tests/manual maintenance).')
    args = parser.parse_args()
    if args.port is not None and not 1024 <= args.port <= 65535:
        parser.error('--port must be between 1024 and 65535')
    try:
        state, reused = ensure_server(args.port)
        if not args.no_watchdog:
            ensure_supervisor(state['port'])
        print(f"X-AI {'already running' if reused else 'started'}: {state['url']} (PID {state['pid']})", flush=True)
        if not args.no_browser:
            if not webbrowser.open(state['url']):
                print('Open the address above in Chrome or Edge.', flush=True)
        return 0
    except (OSError, RuntimeError) as error:
        print(f'X-AI startup failed: {error}', file=sys.stderr, flush=True)
        return 1


if __name__ == '__main__':
    sys.exit(main())
