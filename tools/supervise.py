"""Per-workspace local service watchdog. No project files or API requests."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
import time
from launch import LOCAL, health, ensure_server
from local_runtime import APP_ID, ROOT, workspace_id
from process_lifetime import job_lifetime

STATE = LOCAL / 'supervisor.json'
STOP = LOCAL / 'supervisor.stop'


@contextmanager
def singleton():
    LOCAL.mkdir(exist_ok=True)
    with (LOCAL / 'supervisor.lock').open('a+b') as handle:
        if handle.tell() == 0:
            handle.write(b'0'); handle.flush()
        handle.seek(0)
        locked = False
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            locked = True
        except OSError:
            pass
        try:
            yield locked
        finally:
            if locked:
                handle.seek(0)
                if os.name == 'nt':
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(handle, fcntl.LOCK_UN)


def checkpoint(port, status, restarts, **extra):
    value = dict(app=APP_ID, workspace=workspace_id(), pid=os.getpid(), port=port,
                 status=status, restarts=restarts, checkedAt=time.time(),
                 checkedTime=datetime.now(timezone.utc).isoformat(), lifetime=job_lifetime(), **extra)
    temporary=STATE.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(STATE)


def maintain(port):
    identity=health(port)
    if identity:
        return identity, False
    state, reused=ensure_server(port, strict=True)
    return state, not reused


def run(port):
    with singleton() as locked:
        if not locked:
            return 0
        # A deliberate stop persists until the launcher explicitly starts again.
        restarts=0
        while not STOP.exists():
            try:
                identity, restarted=maintain(port)
                restarts += int(restarted)
                checkpoint(port, 'healthy', restarts, serverPid=identity['pid'])
            except (OSError, RuntimeError) as error:
                checkpoint(port, 'waiting', restarts, error=str(error))
            for _ in range(30):
                if STOP.exists():
                    break
                time.sleep(1)
        checkpoint(port, 'stopped', restarts)
    return 0


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=4183)
    parser.add_argument('--stop', action='store_true', help='Stop watchdog only; existing service is left running.')
    args=parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('Port must be between 1024 and 65535')
    if args.stop:
        LOCAL.mkdir(exist_ok=True);STOP.write_text('stop', encoding='ascii')
        print('X-AI watchdog will stop within one health-check cycle; the service stays running.')
    else:
        sys.exit(run(args.port))
