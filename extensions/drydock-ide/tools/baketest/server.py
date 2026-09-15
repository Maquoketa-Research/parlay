"""Static server for the bake smoke test; POST /save/<name> writes the body to <name>."""
import http.server, os, sys

ROOT = os.path.dirname(os.path.abspath(__file__))


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def do_POST(self):
        name = os.path.basename(self.path.split("/save/", 1)[-1])
        n = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(n)
        with open(os.path.join(ROOT, "out", name), "wb") as f:
            f.write(body)
        self.send_response(200); self.send_header("Content-Length", "2"); self.end_headers(); self.wfile.write(b"ok")

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, *a):
        pass


os.makedirs(os.path.join(ROOT, "out"), exist_ok=True)
http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 8123), H).serve_forever()
