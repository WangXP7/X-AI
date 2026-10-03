"""Exact configured Pages origin -> short-lived, media-only loopback capability.

No keys, local paths, files or API routes are exposed. Never learn allowed origins
from requests. Browser local-network permission remains enforced by the browser.
"""
import hashlib
import hmac
import json
import secrets
import time
from urllib.parse import urlsplit
from local_runtime import ROOT

SECRET = secrets.token_bytes(32)
PROTOCOL = 'x-ai-media-v1'
TOKEN_TTL = 900
PATHS = {'/__xai_media_session', '/__xai_media'}


def page_origins():
    try:
        config = json.loads((ROOT / 'media-relay.json').read_text(encoding='utf-8'))
        if config.get('protocol') != PROTOCOL:
            return set()
        return {value for value in config.get('pageOrigins', []) if isinstance(value, str)
                and urlsplit(value).scheme == 'https' and urlsplit(value).netloc
                and value == 'https://' + urlsplit(value).netloc
                and not urlsplit(value).username and not urlsplit(value).password}
    except (OSError, ValueError, TypeError):
        return set()


def loopback_host(handler):
    port = handler.server.server_address[1]
    return handler.headers.get('Host', '') in {f'127.0.0.1:{port}', f'localhost:{port}'}


def remote_allowed(handler):
    return loopback_host(handler) and handler.headers.get('Origin', '') in page_origins()


def signature(origin, expiry):
    return hmac.new(SECRET, f'{PROTOCOL}\n{origin}\n{expiry}'.encode(), hashlib.sha256).hexdigest()


def valid_token(handler):
    if not remote_allowed(handler):
        return False
    try:
        expiry, digest = handler.headers.get('X-XAI-Media-Token', '').split('.')
        remaining = int(expiry) - int(time.time())
        return 0 < remaining <= TOKEN_TTL and hmac.compare_digest(digest, signature(handler.headers['Origin'], expiry))
    except (ValueError, TypeError):
        return False


def cors(handler):
    if not remote_allowed(handler):
        return
    handler.send_header('Access-Control-Allow-Origin', handler.headers['Origin'])
    handler.send_header('Vary', 'Origin')
    handler.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    handler.send_header('Access-Control-Allow-Headers', 'Content-Type, X-XAI-Media-Token')
    handler.send_header('Access-Control-Expose-Headers', 'Content-Type, Content-Length, Retry-After')
    if handler.headers.get('Access-Control-Request-Private-Network') == 'true':
        handler.send_header('Access-Control-Allow-Private-Network', 'true')


def reply(handler, status, value):
    body = json.dumps(value).encode()
    handler.send_response(status)
    handler.send_header('Content-Type', 'application/json')
    handler.send_header('Content-Length', str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def session(handler):
    if not remote_allowed(handler):
        reply(handler, 403, {'code': 'origin_refused'})
    elif handler.headers.get('Authorization') or handler.headers.get('Cookie'):
        reply(handler, 400, {'code': 'credentials_refused'})
    else:
        expiry = str(int(time.time()) + TOKEN_TTL)
        reply(handler, 200, {'protocol': PROTOCOL, 'expiresAt': int(expiry)*1000,
                             'token': expiry + '.' + signature(handler.headers['Origin'], expiry)})


def preflight(handler, path):
    methods = {'/__xai_media_session': 'GET', '/__xai_media': 'POST'}
    headers = {h.strip().lower() for h in handler.headers.get('Access-Control-Request-Headers', '').split(',') if h.strip()}
    if not remote_allowed(handler) or handler.headers.get('Access-Control-Request-Method') != methods.get(path) or not headers <= {'content-type', 'x-xai-media-token'}:
        reply(handler, 403, {'code': 'preflight_refused'})
        return
    handler.send_response(204)
    handler.end_headers()
