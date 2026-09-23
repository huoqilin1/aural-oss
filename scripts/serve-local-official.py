"""Serve the exact local Vite build, with SPA history fallback on loopback."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit, unquote
ROOT=Path(__file__).resolve().parents[1]/'output/local-sandbox/official-20260915'
assert (ROOT/'index.html').is_file()
class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs): super().__init__(*args,directory=str(ROOT),**kwargs)
    def log_message(self,*args): pass
    def do_GET(self):
        path=Path(self.translate_path(unquote(urlsplit(self.path).path)))
        if not path.is_file() and not path.suffix: self.path='/index.html'
        return super().do_GET()
print('LOCAL_OFFICIAL_READY_3308',flush=True)
ThreadingHTTPServer(('127.0.0.1',3308),Handler).serve_forever()
