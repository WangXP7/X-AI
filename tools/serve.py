"""Serve static X-AI files on loopback. No API key or user media handling."""
import argparse
import functools
import json
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import unquote, urlsplit
from local_runtime import ROOT, server_identity

class Handler(SimpleHTTPRequestHandler):
    prefix = ''

    def do_GET(self):
        if self.prefix:
            if not self.path.startswith(self.prefix):
                self.send_error(404)
                return
            self.path = '/' + self.path[len(self.prefix):]
        parts = unquote(urlsplit(self.path).path).split('/')
        if any(p in {'.git', '.local', '__pycache__', 'test-results'} or p.startswith('.local-') for p in parts):
            self.send_error(404)
            return
        if urlsplit(self.path).path == '/__xai_health':
            body = json.dumps(server_identity()).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cache-Control', 'no-store' if '/private/' in self.path else 'no-cache')
        super().end_headers()

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=4173)
    parser.add_argument('--prefix', default='', help='Optional repository-style path, e.g. /x-ai/')
    args = parser.parse_args()
    Handler.prefix = '/' + args.prefix.strip('/') + '/' if args.prefix else ''
    Handler.extensions_map.update({'.js':'text/javascript','.wasm':'application/wasm','.svg':'image/svg+xml'})
    server = ThreadingHTTPServer(('127.0.0.1', args.port), functools.partial(Handler, directory=str(ROOT)))
    print(f'X-AI: http://127.0.0.1:{args.port} (Ctrl+C to stop)', flush=True)
    server.serve_forever()
