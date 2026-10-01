"""Optional local CORS connector. Python standard library; never stores API keys.

Only explicit browser origins + a random pairing token are accepted. Authenticated
requests go to two fixed Agnes origins. CDN downloads never receive Authorization.
"""
import argparse
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import secrets
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import urllib.error
import urllib.parse
import urllib.request

ORIGINS = {'https://api.agnes-ai.cn', 'https://apihub.agnes-ai.com'}
API_LOCK = threading.Lock()
RATE_FILE = Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'X-AI' / 'connector-rate.json'

def local_page_origins(root=None, extra_port=None):
    root = Path(root) if root is not None else Path(__file__).resolve().parent.parent
    ports = {4173}
    try:
        state = json.loads((root / '.local' / 'startup.json').read_text(encoding='utf-8'))
        expected = hashlib.sha256(os.path.normcase(str(root.resolve())).encode('utf-8')).hexdigest()
        if isinstance(state,dict) and state.get('app') == 'x-ai-video-studio' and state.get('workspace') == expected:
            port = state.get('port')
            if type(port) is int and 1024 <= port <= 65535:
                ports.add(port)
    except (OSError,ValueError):
        pass
    if extra_port is not None:
        if type(extra_port) is not int or not 1024 <= extra_port <= 65535:
            raise ValueError('Local page port must be between 1024 and 65535')
        ports.add(extra_port)
    return {f'http://{host}:{port}' for host in ('127.0.0.1','localhost') for port in ports}

def valid_media_url(url):
    p = urllib.parse.urlsplit(url)
    if p.scheme != 'https' or p.username or p.password or not p.hostname or p.port not in (None,443):
        raise ValueError('Media URL must use public HTTPS')
    for result in socket.getaddrinfo(p.hostname, 443, type=socket.SOCK_STREAM):
        if not ipaddress.ip_address(result[4][0]).is_global:
            raise ValueError('Private network media URLs are not allowed')
    return url

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('Authenticated redirects are refused')

class MediaRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        valid_media_url(newurl)
        return super().redirect_request(req,fp,code,msg,headers,newurl)

def reserve_slot(authorization, minimum=90):
    digest = hashlib.sha256(authorization.encode()).hexdigest()
    try:
        data = json.loads(RATE_FILE.read_text(encoding='utf-8'))
    except (FileNotFoundError, ValueError):
        data = {}
    delay = max(0, data.get(digest,0) + minimum - time.time())
    if delay:
        time.sleep(delay)
    data[digest] = time.time()
    RATE_FILE.parent.mkdir(parents=True,exist_ok=True)
    temporary=RATE_FILE.with_suffix('.tmp')
    temporary.write_text(json.dumps(data),encoding='utf-8')
    temporary.replace(RATE_FILE)

class Handler(BaseHTTPRequestHandler):
    protocol_version='HTTP/1.0'

    def log_message(self, fmt, *args):
        # Request headers and bodies (including keys and prompts) are never logged.
        return

    def cors(self):
        origin=self.headers.get('Origin','')
        if origin in self.server.allowed_origins:
            self.send_header('Access-Control-Allow-Origin',origin)
            self.send_header('Vary','Origin')
        self.send_header('Access-Control-Allow-Methods','GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers','Authorization, Content-Type, X-XAI-Token, X-XAI-Origin')
        self.send_header('Access-Control-Allow-Private-Network','true')
        self.send_header('Access-Control-Expose-Headers','Content-Type, Content-Length')
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')

    def json_response(self,status,value):
        raw=json.dumps(value,ensure_ascii=False).encode('utf-8')
        self.send_response(status);self.cors();self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)

    def allowed(self):
        return self.headers.get('Origin','') in self.server.allowed_origins and hmac.compare_digest(self.headers.get('X-XAI-Token',''),self.server.token)

    def do_OPTIONS(self):
        if self.headers.get('Origin','') not in self.server.allowed_origins:
            self.json_response(403,{'message':'Origin not paired. Restart connector with --origin <your Pages origin>'});return
        self.send_response(204);self.cors();self.end_headers()

    def read_body(self, limit):
        n=int(self.headers.get('Content-Length','0'))
        if not 0<n<=limit:
            raise ValueError('Request body size is invalid')
        return self.rfile.read(n)

    def do_GET(self):
        self.dispatch()

    def do_POST(self):
        self.dispatch()

    def dispatch(self):
        if not self.allowed():
            self.json_response(403,{'message':'本机配对码或页面来源不匹配。'});return
        try:
            if self.path=='/media' and self.command=='POST':
                url=valid_media_url(json.loads(self.read_body(8192))['url'])
                request=urllib.request.Request(url,headers={'User-Agent':'X-AI/1.0'})
                with urllib.request.build_opener(MediaRedirect()).open(request,timeout=150) as response:
                    length=int(response.headers.get('Content-Length','0'))
                    if length>512_000_000:raise ValueError('Media exceeds 512MB')
                    self.send_response(200);self.cors();self.send_header('Content-Type',response.headers.get('Content-Type','application/octet-stream'));self.end_headers()
                    total=0
                    while chunk:=response.read(1024*1024):
                        total+=len(chunk)
                        if total>512_000_000:break
                        self.wfile.write(chunk)
                return
            if not self.path.startswith('/api/'):
                self.json_response(404,{'message':'Unknown local route'});return
            route=self.path[4:];parsed=urllib.parse.urlsplit(route)
            allowed=(self.command=='POST' and parsed.path=='/v1/videos') or (self.command=='GET' and parsed.path in {'/agnesapi','/v1/models'})
            origin=self.headers.get('X-XAI-Origin','')
            authorization=self.headers.get('Authorization','')
            if not allowed or origin not in ORIGINS or not authorization.startswith('Bearer ') or len(authorization)>2048:
                self.json_response(400,{'message':'Unsupported API route or missing authorization'});return
            body=self.read_body(50_000_000) if self.command=='POST' else None
            request=urllib.request.Request(origin+route,data=body,method=self.command,headers={'Authorization':authorization,'Content-Type':'application/json','Accept':'application/json','User-Agent':'X-AI/1.0'})
            with API_LOCK:
                reserve_slot(authorization)
                try:
                    response=urllib.request.build_opener(NoRedirect()).open(request,timeout=120)
                except urllib.error.HTTPError as error:
                    response=error
                with response:
                    raw=response.read(4_000_001)
                    if len(raw)>4_000_000:raise ValueError('API response unexpectedly large')
                    self.send_response(response.status);self.cors();self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
        except (BrokenPipeError,ConnectionResetError):
            pass
        except Exception:
            # A POST timeout may have created a paid task. Never re-send it here.
            self.json_response(502,{'message':'连接器未能完成请求。提交结果可能不明，请保留原任务核实；下载失败可重试。'})

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin',action='append',default=[],help='Exact Pages origin, e.g. https://yourname.github.io (no repository path)')
    parser.add_argument('--local-port',type=int,help='Additional local static page port, if not launched by launch.py')
    args=parser.parse_args()
    try:
        allowed=local_page_origins(extra_port=args.local_port)
    except ValueError as error:
        parser.error(str(error))
    for origin in args.origin:
        p=urllib.parse.urlsplit(origin)
        if p.scheme!='https' or not p.hostname or p.path not in ('','/') or p.query or p.username:
            parser.error('--origin must be an HTTPS origin without a path')
        allowed.add(origin.rstrip('/'))
    server=ThreadingHTTPServer(('127.0.0.1',4174),Handler)
    server.allowed_origins=allowed;server.token=secrets.token_urlsafe(24)
    print('X-AI local connector: http://127.0.0.1:4174',flush=True)
    print('Pairing code (paste into X-AI settings): '+server.token,flush=True)
    print('Allowed page origins: '+', '.join(sorted(allowed)),flush=True)
    print('Keys are not stored. Keep this window running. Ctrl+C to stop.',flush=True)
    server.serve_forever()
