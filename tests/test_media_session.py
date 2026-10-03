"""Real loopback CORS/capability checks; the upstream is mocked only here."""
import json
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch
import urllib.request
sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_local_media as base
import media_session


HTTP, Response = base.HTTP, base.Response

class SessionTests(unittest.TestCase):
    setUpClass = classmethod(base.MediaTests.setUpClass.__func__)
    tearDownClass = classmethod(base.MediaTests.tearDownClass.__func__)
    request = base.MediaTests.request
    pages = 'https://wangxp7.github.io'

    def session_request(self, origin=None, **headers):
        request = urllib.request.Request(self.origin + '/__xai_media_session', headers={'Origin': origin or self.pages, **headers})
        try:
            return HTTP.open(request, timeout=3)
        except urllib.error.HTTPError as error:
            return error

    def token(self):
        with self.session_request() as response:
            self.assertEqual(response.headers['Access-Control-Allow-Origin'], self.pages)
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
            data = json.loads(response.read())
            self.assertEqual(set(data), {'protocol', 'token', 'expiresAt'})
            return data['token']

    def test_pages_without_token_refused(self):
        with self.request({'Origin': self.pages, 'Sec-Fetch-Site': 'cross-site'}) as response:
            self.assertEqual(response.status, 403)

    def test_exact_origin_and_host_required(self):
        for origin in ('https://evil.test', 'https://wangxp7.github.io.evil.test', 'null'):
            with self.session_request(origin) as response:
                self.assertEqual(response.status, 403)
                self.assertIsNone(response.headers.get('Access-Control-Allow-Origin'))
        with self.session_request(Host='evil.test') as response:
            self.assertEqual(response.status, 403)

    def test_pages_preflight_and_real_token_media(self):
        token = self.token()
        request = urllib.request.Request(self.origin+'/__xai_media', method='OPTIONS', headers={
            'Origin': self.pages, 'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type,x-xai-media-token',
            'Access-Control-Request-Private-Network': 'true'})
        with HTTP.open(request) as response:
            self.assertEqual(response.status, 204)
            self.assertEqual(response.headers['Access-Control-Allow-Private-Network'], 'true')
        with patch('local_media.valid_media_url', side_effect=lambda u:u), patch('local_media.urllib.request.build_opener') as opener:
            opener.return_value.open.return_value = Response(b'12345678')
            with self.request({'Origin': self.pages, 'Sec-Fetch-Site': 'cross-site', 'X-XAI-Media-Token': token}) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers['Access-Control-Allow-Origin'], self.pages)
                self.assertEqual(response.read(), b'12345678')
            upstream = opener.return_value.open.call_args.args[0]
            self.assertEqual(set(upstream.header_items()), {('User-agent', 'X-AI/local-media')})

    def test_expired_forged_and_other_origin_token(self):
        token = self.token()
        expiry = str(int(time.time())-1)
        for value in ('forged', expiry+'.'+media_session.signature(self.pages, expiry), token[:-1]+('a' if token[-1]!='a' else 'b')):
            with self.request({'Origin':self.pages, 'Sec-Fetch-Site':'cross-site', 'X-XAI-Media-Token':value}) as response:
                self.assertEqual(response.status, 403)
        with self.request({'Origin':'https://evil.test', 'X-XAI-Media-Token':token}) as response:
            self.assertEqual(response.status, 403)

    def test_token_does_not_allow_other_cdn_or_credentials(self):
        token = self.token()
        h = {'Origin':self.pages, 'Sec-Fetch-Site':'cross-site', 'X-XAI-Media-Token':token}
        with self.request(h, 'https://evil.test/videos/a.mp4') as response:
            self.assertEqual(response.status, 400)
        with self.request({**h, 'Authorization':'synthetic'}) as response:
            self.assertEqual(response.status, 400)

    def test_preflight_cannot_grant_auth_or_arbitrary_routes(self):
        for path, headers in (('/__xai_media','authorization'), ('/private/default-access.json',''), ('/__xai_health','')):
            request = urllib.request.Request(self.origin+path, method='OPTIONS', headers={
                'Origin':self.pages, 'Access-Control-Request-Method':'POST', 'Access-Control-Request-Headers':headers})
            with self.assertRaises(urllib.error.HTTPError) as raised:
                HTTP.open(request)
            raised.exception.close()
            self.assertEqual(raised.exception.code, 403)
