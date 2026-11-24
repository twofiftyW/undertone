"""Local interface QA; the installed native app does not use this server."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("UNDERTONE_CACHE_DIR", str(ROOT / ".tools/catalog-preview-cache"))
os.environ.setdefault("UNDERTONE_DOWNLOAD_DIR", str(ROOT / ".tools/preview-data/downloads"))
sys.path.insert(0, str(ROOT / "music"))
from backend import dispatch


class Handler(SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/api/music":
            self.send_error(404)
            return
        origin = self.headers.get("Origin")
        if origin and origin != "http://" + self.headers.get("Host", ""):
            self.send_error(403)
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length > 65536:
            self.send_error(413)
            return
        try:
            request = json.loads(self.rfile.read(length))
            body = {"data": dispatch(str(request.get("operation") or ""), request.get("args") or {})}
            status = 200
        except Exception as error:
            body = {"error": str(error) if isinstance(error, ValueError) else "The music service couldn’t complete that request. Please retry."}
            status = 502
        output = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(output)))
        self.end_headers()
        self.wfile.write(output)

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4173
    server = ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, directory=str(ROOT / "web")))
    print(f"Preview: http://127.0.0.1:{port}", flush=True)
    server.serve_forever()
