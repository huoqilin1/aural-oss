"""Loopback-only proxy for the already built HR web rewrite target."""
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import requests
class Proxy(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def run_request(self):
        if not (self.path.startswith('/v1/') or self.path in ('/health','/version')):
            self.send_error(404);return
        body=self.rfile.read(int(self.headers.get('Content-Length',0)))
        headers={k:v for k,v in self.headers.items() if k.lower() not in ('host','connection','content-length','accept-encoding')}
        r=requests.request(self.command,'http://127.0.0.1:3301'+self.path,data=body,headers=headers,allow_redirects=False,timeout=30)
        self.send_response(r.status_code)
        for k,v in r.raw.headers.items():
            if k.lower() not in ('connection','transfer-encoding','content-length','content-encoding','set-cookie'):self.send_header(k,v)
        for cookie in r.raw.headers.getlist('Set-Cookie'):self.send_header('Set-Cookie',cookie)
        self.send_header('Content-Length',str(len(r.content)));self.end_headers();self.wfile.write(r.content)
    do_GET=run_request
    do_POST=run_request
    do_OPTIONS=run_request
ThreadingHTTPServer(('127.0.0.1',5204),Proxy).serve_forever()
