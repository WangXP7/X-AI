"""Exercise real loopback POST isolation, without accessing an upstream or credentials."""
import io
import json
from pathlib import Path
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
import serve
import local_media
HTTP=urllib.request.build_opener(urllib.request.ProxyHandler({}))


class Response(io.BytesIO):
    headers={'Content-Length':'8','Content-Type':'video/mp4'}


class MediaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=ThreadingHTTPServer(('127.0.0.1',0),serve.Handler)
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True);cls.thread.start()
        cls.origin='http://127.0.0.1:'+str(cls.server.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown();cls.server.server_close();cls.thread.join()

    def request(self,headers=None,url='https://cos-platform-outputs.agnes-ai.cn/videos/test.mp4'):
        h={'Content-Type':'application/json','Origin':self.origin,'Sec-Fetch-Site':'same-origin',**(headers or {})}
        req=urllib.request.Request(self.origin+'/__xai_media',data=json.dumps({'url':url}).encode(),headers=h)
        try:return HTTP.open(req,timeout=3)
        except urllib.error.HTTPError as e:return e

    def test_exact_origin_required_before_network(self):
        with patch('local_media.urllib.request.build_opener') as opener:
            for h in ({'Origin':'https://evil.test'},{'Origin':''},{'Sec-Fetch-Site':'cross-site'}):
                with self.request(h) as r:self.assertEqual(r.status,403)
            opener.assert_not_called()

    def test_no_credentials_accepted(self):
        for header in ('Authorization','Cookie'):
            with self.request({header:'synthetic'}) as r:self.assertEqual(r.status,400)

    def test_known_cdn_only_and_dns_checked(self):
        with patch('local_media.urllib.request.getproxies',return_value={}),patch('local_media.valid_media_url',side_effect=lambda u:u) as valid:
            for url in ('https://evil.test/videos/test.mp4','https://cos-platform-outputs.agnes-ai.cn/not-video/test.mp4','https://cos-platform-outputs.agnes-ai.cn/videos/test.txt'):
                with self.assertRaises(ValueError):local_media.media_url(url)
            valid.assert_not_called()
            local_media.media_url('https://cos-platform-outputs.agnes-ai.cn/videos/test.mp4');valid.assert_called_once()

    def test_existing_proxy_resolves_only_the_fixed_public_cdn(self):
        with patch('local_media.urllib.request.getproxies',return_value={'https':'http://127.0.0.1:7890'}),patch('local_media.valid_media_url') as dns:
            self.assertEqual(local_media.media_url('https://cos-platform-outputs.agnes-ai.cn/videos/test.mp4'),'https://cos-platform-outputs.agnes-ai.cn/videos/test.mp4');dns.assert_not_called()
            for url in ('http://cos-platform-outputs.agnes-ai.cn/videos/a.mp4','https://user:pass@cos-platform-outputs.agnes-ai.cn/videos/a.mp4','https://cos-platform-outputs.agnes-ai.cn:444/videos/a.mp4','https://127.0.0.1/videos/a.mp4'):
                with self.assertRaises(ValueError):local_media.media_url(url)

    def test_actual_bytes_and_length_are_relayed_without_authorization(self):
        with patch('local_media.valid_media_url',side_effect=lambda u:u),patch('local_media.urllib.request.build_opener') as opener:
            opener.return_value.open.return_value=Response(b'12345678')
            with self.request() as r:self.assertEqual(r.read(),b'12345678');self.assertEqual(r.headers['Content-Length'],'8')
            request=opener.return_value.open.call_args.args[0];self.assertFalse(request.has_header('Authorization'))


if __name__=='__main__':unittest.main()
