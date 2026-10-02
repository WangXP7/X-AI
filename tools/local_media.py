"""Local-only, same-origin recovery for the known Agnes output CDN; no API relay."""
import json
import urllib.parse
import urllib.request
from connector import valid_media_url

MAX_MEDIA = 512_000_000
MEDIA_HOST = 'cos-platform-outputs.agnes-ai.cn'


def media_url(value):
    if not isinstance(value, str) or len(value) > 4096:
        raise ValueError('Invalid media URL')
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme!='https' or parsed.username or parsed.password or parsed.port not in (None,443) or parsed.hostname != MEDIA_HOST or not parsed.path.startswith('/videos/') or not parsed.path.endswith('.mp4'):
        raise ValueError('Only the Agnes output video CDN is supported')
    # With an explicitly configured HTTPS proxy, the proxy resolves this fixed host.
    # Local DNS may return a 198.18/15 fake IP; it is not the connection destination.
    proxy=urllib.parse.urlsplit(urllib.request.getproxies().get('https',''))
    if proxy.scheme in ('http','https') and proxy.hostname:
        return value
    return valid_media_url(value)


class Redirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        media_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def relay(handler):
    port = handler.server.server_address[1]
    expected = {f'http://{host}:{port}' for host in ('127.0.0.1', 'localhost')}
    origin = handler.headers.get('Origin', '')
    if origin not in expected or handler.headers.get('Sec-Fetch-Site', 'same-origin') != 'same-origin':
        handler.send_error(403, 'Only this local X-AI page may download')
        return
    if handler.headers.get('Authorization') or handler.headers.get('Cookie'):
        handler.send_error(400, 'Credentials are not accepted')
        return
    started = False
    try:
        size = int(handler.headers.get('Content-Length', '0'))
        if not 0 < size <= 8192 or handler.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            raise ValueError('Invalid request')
        url = media_url(json.loads(handler.rfile.read(size))['url'])
        request = urllib.request.Request(url, headers={'User-Agent': 'X-AI/local-media'})
        with urllib.request.build_opener(Redirect()).open(request, timeout=150) as upstream:
            length = int(upstream.headers.get('Content-Length', '0'))
            if length > MAX_MEDIA or not upstream.headers.get('Content-Type', '').startswith('video/'):
                raise ValueError('Not a supported video response')
            handler.send_response(200)
            handler.send_header('Content-Type', 'video/mp4')
            if length:
                handler.send_header('Content-Length', str(length))
            handler.end_headers()
            started = True
            total = 0
            while chunk := upstream.read(256 * 1024):
                total += len(chunk)
                if total > MAX_MEDIA:
                    handler.close_connection = True
                    break
                handler.wfile.write(chunk)
    except (BrokenPipeError, ConnectionResetError):
        pass
    except (ValueError, KeyError, TypeError):
        if started:
            handler.close_connection = True
        else:
            handler.send_error(400, 'Unsupported video URL or request')
    except Exception:
        if started:
            handler.close_connection = True
        else:
            handler.send_error(502, 'Original video download failed; no task was created')
