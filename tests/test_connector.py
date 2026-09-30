import importlib.util
from pathlib import Path
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

if __name__=='__main__':unittest.main()
