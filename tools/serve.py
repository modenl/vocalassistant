"""Local static server with caching disabled (so edited ES modules always reload).

Usage: python3 tools/serve.py [port]   → http://localhost:8765
Microphone access requires a secure context; http://localhost qualifies.
"""
import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.mjs': 'text/javascript'}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


class Server(http.server.ThreadingHTTPServer):
    # the page loads dozens of ES modules at once: the default backlog of 5
    # reset connections (ERR_CONNECTION_RESET) and left the page half-loaded
    request_queue_size = 128
    daemon_threads = True


if __name__ == '__main__':
    with Server(('127.0.0.1', PORT), NoCacheHandler) as httpd:
        print(f'VocalLab → http://localhost:{PORT}')
        httpd.serve_forever()
