"""Local server for the live-rankings site.

  python3 server.py [port]

* Serves the static files with Cache-Control: no-cache, so a normal reload always
  revalidates and returning visitors never get a stale page.
* GET /api/history?tour=atp&id=3623  -> weekly official rank/points for one player
* GET /api/archive                   -> what the weekly rankings archive holds
* A background thread keeps data/rankings/ filled: it backfills every week back to
  2019 on first run, then re-checks for the newest week every 6 hours.
"""
import http.server
import json
import sys
import threading
import urllib.parse

import rankings_store as store


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _json(self, obj, code=200):
        body = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/api/history":
            q = urllib.parse.parse_qs(u.query)
            tour = (q.get("tour") or [""])[0]
            pid = (q.get("id") or [""])[0]
            if tour not in store.LEAGUE or not pid.isdigit():
                return self._json({"error": "bad request"}, 400)
            return self._json({"tour": tour, "id": pid, "weeks": store.history(tour, pid)})
        if u.path == "/api/archive":
            return self._json(store.status())
        return super().do_GET()

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    threading.Thread(target=store.sync_forever, daemon=True).start()
    srv = http.server.ThreadingHTTPServer(("", port), Handler)
    print(f"Serving on http://localhost:{port}", flush=True)
    srv.serve_forever()
