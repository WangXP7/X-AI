"""Fixed entry points for OS-launched, hidden X-AI helpers with local logs."""
import argparse
from datetime import datetime, timezone
from pathlib import Path
import runpy
import sys

ROOT=Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('role',choices=['server','watchdog'])
parser.add_argument('--port',type=int,required=True)
args=parser.parse_args()
if not 1024<=args.port<=65535:parser.error('Invalid port')
local=ROOT/'.local';local.mkdir(exist_ok=True)
log=local/('static-server.log' if args.role=='server' else 'supervisor.log')
with log.open('a',encoding='utf-8',buffering=1) as output:
    sys.stdout=sys.stderr=output
    print(f'\nOS-launched {args.role}, port {args.port}, {datetime.now(timezone.utc).isoformat()}',flush=True)
    target=ROOT/'tools'/('serve.py' if args.role=='server' else 'supervise.py')
    sys.argv=[str(target),'--port',str(args.port)]
    runpy.run_path(str(target),run_name='__main__')
