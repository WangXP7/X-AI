import importlib.util
import io
import hashlib
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer

spec=importlib.util.spec_from_file_location('connector',Path(__file__).resolve().parents[1]/'tools/connector.py')
connector=importlib.util.module_from_spec(spec);spec.loader.exec_module(connector)

class ConnectorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=ThreadingHTTPServer(('127.0.0.1',0),connector.Handler)
        cls.server.allowed_origins={'https://owner.github.io'}
        cls.server.token='synthetic-pairing-token'
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True);cls.thread.start()
        cls.url='http://127.0.0.1:'+str(cls.server.server_address[1])

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown();cls.server.server_close();cls.thread.join()

    def request(self,path,headers,method='GET'):
        try:return urllib.request.urlopen(urllib.request.Request(self.url+path,headers=headers,method=method),timeout=2)
        except urllib.error.HTTPError as error:return error

    def test_wrong_origin_and_token_blocked_before_api(self):
        for headers in [{'Origin':'https://evil.test','X-XAI-Token':self.server.token},{'Origin':'https://owner.github.io','X-XAI-Token':'wrong'}]:
            with self.request('/api/v1/models',headers) as res:self.assertEqual(res.status,403)

    def test_preflight_explicitly_allows_authorization(self):
        with self.request('/api/v1/models',{'Origin':'https://owner.github.io'},'OPTIONS') as res:
            self.assertEqual(res.status,204)
            self.assertEqual(res.headers['Access-Control-Allow-Origin'],'https://owner.github.io')
            self.assertIn('Authorization',res.headers['Access-Control-Allow-Headers'])

    def test_arbitrary_proxy_destination_refused(self):
        with self.request('/api/v1/models',{'Origin':'https://owner.github.io','X-XAI-Token':self.server.token,'X-XAI-Origin':'https://evil.test','Authorization':'Bearer dummy'}) as res:self.assertEqual(res.status,400)

    def test_media_refuses_private_addresses_credentials_and_http(self):
        for url in ['http://example.com/a.mp4','https://user:pass@example.com/a.mp4','https://example.com:444/a.mp4']:
            with self.assertRaises(ValueError):connector.valid_media_url(url)
        with patch('socket.getaddrinfo',return_value=[(2,1,6,'',('127.0.0.1',443))]):
            with self.assertRaises(ValueError):connector.valid_media_url('https://example.com/a.mp4')

    def test_launcher_port_is_an_exact_allowed_origin(self):
        with tempfile.TemporaryDirectory(prefix='x-ai-connector-origin-') as directory:
            root=Path(directory);(root/'.local').mkdir()
            identity=hashlib.sha256(os.path.normcase(str(root.resolve())).encode()).hexdigest()
            state={'app':'x-ai-video-studio','workspace':identity,'port':4183}
            (root/'.local/startup.json').write_text(json.dumps(state))
            allowed=connector.local_page_origins(root)
            self.assertIn('http://127.0.0.1:4183',allowed)
            self.assertNotIn('http://127.0.0.1:4184',allowed)
            state['workspace']='other-project'
            (root/'.local/startup.json').write_text(json.dumps(state))
            self.assertNotIn('http://127.0.0.1:4183',connector.local_page_origins(root))

    def test_malformed_launcher_state_keeps_default_and_explicit_local_port(self):
        with tempfile.TemporaryDirectory(prefix='x-ai-connector-origin-') as directory:
            root=Path(directory);(root/'.local').mkdir()
            (root/'.local/startup.json').write_text('{invalid')
            allowed=connector.local_page_origins(root,49000)
            self.assertIn('http://127.0.0.1:4173',allowed)
            self.assertIn('http://127.0.0.1:49000',allowed)
            self.assertNotIn('https://evil.test',allowed)

    def test_invalid_local_port_is_rejected(self):
        with self.assertRaises(ValueError):connector.local_page_origins(extra_port=80)

    def test_queries_bypass_submission_lock_and_preserve_retry_after(self):
        class Response(io.BytesIO):
            status=429
            headers={'Retry-After':'25'}
        headers={'Origin':'https://owner.github.io','X-XAI-Token':self.server.token,'X-XAI-Origin':'https://api.agnes-ai.cn','Authorization':'Bearer synthetic'}
        with patch.object(connector,'reserve_slot') as reserve,patch.object(connector.urllib.request,'build_opener') as opener:
            opener.return_value.open.return_value=Response(b'{"code":"rate_limit_exceeded"}')
            # A pending submission must not hold up an independent GET.
            connector.API_LOCK.acquire()
            try:
                with self.request('/api/agnesapi?video_id=known',headers) as res:
                    self.assertEqual(res.status,429);self.assertEqual(res.headers['Retry-After'],'25')
            finally:connector.API_LOCK.release()
            reserve.assert_not_called()

    def test_submission_slot_is_strictly_more_than_sixty_seconds(self):
        with tempfile.TemporaryDirectory() as directory:
            file=Path(directory)/'rate.json';digest=hashlib.sha256(b'Bearer synthetic').hexdigest();file.write_text(json.dumps({digest:1000}))
            with patch.object(connector,'RATE_FILE',file),patch.object(connector.time,'time',return_value=1000),patch.object(connector.time,'sleep') as sleep:
                connector.reserve_slot('Bearer synthetic');sleep.assert_called_once_with(61)

if __name__=='__main__':unittest.main()
