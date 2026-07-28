"""
B2B Sales Strategist - Local Dev Server

Serves the static frontend and provides two small backend helpers:
  - /api/scrape    fetches a product URL server-side (SSRF-guarded) and returns plain text
  - /api/generate  proxies calls to the Gemini API using a server-held key, so the
                   API key never has to live in the browser (localStorage, URL, etc.)
  - /api/models    lists usable Gemini models without exposing the key to the client
  - /api/config    lets the UI store/clear the Gemini API key server-side

This is a small single-user local tool, not a hardened multi-tenant production
server. It still applies basic safety measures (SSRF allowlisting, no secrets
sent to the client, generic error messages) so it isn't trivially abusable.
"""

import http.client
import http.server
import ipaddress
import json
import os
import re
import socket
import ssl
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

PORT = int(os.environ.get("PORT", "8080"))

# Bind to localhost only by default. This is a single-user local tool that
# holds a live Gemini key server-side - if it were reachable from the rest
# of the network, anyone on the same LAN could spend that key's quota via
# /api/generate or use /api/scrape as an open (SSRF-guarded) relay. Set
# HOST=0.0.0.0 explicitly if you really want LAN access.
HOST = os.environ.get("HOST", "127.0.0.1")

# Reject POST bodies larger than this to avoid a trivial memory-exhaustion DoS
# via a spoofed Content-Length header.
MAX_BODY_BYTES = 2_000_000

# Where the Gemini key is persisted when the user saves it via the Settings UI.
# Kept outside of anything that looks like normal site content and explicitly
# blocked from being served as a static file (see do_GET below).
CONFIG_FILE = Path(__file__).resolve().parent / ".gemini_config.json"
BLOCKED_STATIC_PATHS = {"/" + CONFIG_FILE.name}

DEFAULT_MODEL = "gemini-2.5-flash"
FALLBACK_MODEL = "gemini-1.5-flash"


# --------------------------------------------------------------------------
# HTML text extraction helper (used for /api/scrape)
# --------------------------------------------------------------------------
class MLStripper(HTMLParser):
    def __init__(self):
        super().__init__()
        self.reset()
        self.strict = False
        self.convert_charrefs = True
        self.text = []

    def handle_data(self, d):
        self.text.append(d)

    def get_data(self):
        return "".join(self.text)


def strip_tags(html):
    s = MLStripper()
    s.feed(html)
    return s.get_data()


# --------------------------------------------------------------------------
# SSRF protection for /api/scrape
# --------------------------------------------------------------------------
def _is_blocked_ip(ip):
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
    )


def is_safe_public_url(url):
    """Only allow http(s) URLs that resolve to public, non-internal IP addresses.

    Returns (is_safe, error_message_or_None, pinned_ip_or_None). The caller
    must connect to `pinned_ip` for the actual request instead of letting
    the HTTP client re-resolve the hostname - otherwise a malicious DNS
    server could return a safe IP for this check and then a different,
    internal IP a moment later for the real connection ("DNS rebinding"),
    bypassing the check entirely.
    """
    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return False, "Ungültige URL.", None

    if parsed.scheme not in ("http", "https"):
        return False, "Nur http:// und https:// URLs sind erlaubt.", None

    hostname = parsed.hostname
    if not hostname:
        return False, "Ungültige URL.", None

    if hostname.lower() in ("localhost",) or hostname.lower().endswith(".local"):
        return False, "Diese Adresse ist nicht erlaubt.", None

    try:
        addr_infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror:
        return False, "Host konnte nicht aufgelöst werden.", None

    pinned_ip = None
    for info in addr_infos:
        ip_str = info[4][0]
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            continue
        if _is_blocked_ip(ip):
            return False, "Diese Adresse ist nicht erlaubt.", None
        if pinned_ip is None:
            pinned_ip = ip_str

    if pinned_ip is None:
        return False, "Host konnte nicht aufgelöst werden.", None

    return True, None, pinned_ip


def _make_pinned_opener(pinned_ip):
    """Build a urllib opener that connects to `pinned_ip` regardless of what
    the target hostname resolves to at request time, closing the DNS
    rebinding gap between validation and the actual request. The Host
    header / SNI / certificate hostname check still use the real hostname,
    so normal virtual hosting and TLS validation keep working.
    """

    class PinnedHTTPConnection(http.client.HTTPConnection):
        def connect(self):
            self.sock = socket.create_connection((pinned_ip, self.port), self.timeout)

    class PinnedHTTPSConnection(http.client.HTTPSConnection):
        def connect(self):
            sock = socket.create_connection((pinned_ip, self.port), self.timeout)
            context = self._context or ssl.create_default_context()
            self.sock = context.wrap_socket(sock, server_hostname=self.host)

    class PinnedHTTPHandler(urllib.request.HTTPHandler):
        def http_open(self, req):
            return self.do_open(PinnedHTTPConnection, req)

    class PinnedHTTPSHandler(urllib.request.HTTPSHandler):
        def https_open(self, req):
            return self.do_open(PinnedHTTPSConnection, req)

    return urllib.request.build_opener(PinnedHTTPHandler, PinnedHTTPSHandler)


# --------------------------------------------------------------------------
# Gemini API key resolution / persistence
# --------------------------------------------------------------------------
def get_stored_api_key():
    # Environment variable always takes precedence (useful for deployments).
    env_key = os.environ.get("GEMINI_API_KEY")
    if env_key:
        return env_key.strip()

    if CONFIG_FILE.exists():
        try:
            data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            key = data.get("apiKey", "").strip()
            return key or None
        except (json.JSONDecodeError, OSError):
            return None
    return None


def save_api_key(key):
    CONFIG_FILE.write_text(json.dumps({"apiKey": key.strip()}), encoding="utf-8")
    try:
        os.chmod(CONFIG_FILE, 0o600)
    except OSError:
        pass


def clear_api_key():
    try:
        CONFIG_FILE.unlink()
    except FileNotFoundError:
        pass
    except OSError:
        # Some filesystems (e.g. synced folders) disallow deleting files that
        # were just created. Overwriting with an empty key achieves the same
        # effect (get_stored_api_key() treats an empty string as "not set").
        try:
            CONFIG_FILE.write_text(json.dumps({"apiKey": ""}), encoding="utf-8")
        except OSError:
            pass


# --------------------------------------------------------------------------
# Gemini API call helpers (server-side only - key never reaches the client)
# --------------------------------------------------------------------------
def normalize_model(model_name):
    if not model_name or model_name in ("gemini-3.1-flash-lite", "gemini-2.0-flash"):
        return DEFAULT_MODEL
    return model_name


def api_version_for(model_name):
    if any(tag in model_name for tag in ("2.5", "2.0", "3.1")):
        return "v1beta"
    return "v1"


def call_gemini_generate(api_key, prompt, model_name):
    model_name = normalize_model(model_name)

    def do_call(name):
        version = api_version_for(name)
        url = f"https://generativelanguage.googleapis.com/{version}/models/{name}:generateContent?key={api_key}"
        body = json.dumps({"contents": [{"parts": [{"text": prompt}]}]}).encode("utf-8")
        req = urllib.request.Request(
            url, data=body, headers={"Content-Type": "application/json"}, method="POST"
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))

    try:
        data = do_call(model_name)
    except urllib.error.HTTPError as e:
        if model_name != FALLBACK_MODEL:
            try:
                data = do_call(FALLBACK_MODEL)
            except urllib.error.HTTPError:
                raise e
        else:
            raise

    text = (
        data.get("candidates", [{}])[0]
        .get("content", {})
        .get("parts", [{}])[0]
        .get("text")
    )
    if not text:
        raise ValueError("Ungueltige Antwort von der Gemini API erhalten.")
    return text


def call_gemini_list_models(api_key):
    url = f"https://generativelanguage.googleapis.com/v1/models?key={api_key}"
    with urllib.request.urlopen(url, timeout=20) as resp:
        data = json.loads(resp.read().decode("utf-8"))

    models = data.get("models", [])
    result = []
    for m in models:
        methods = m.get("supportedGenerationMethods", [])
        if "generateContent" in methods:
            result.append(
                {
                    "name": m.get("name", "").replace("models/", ""),
                    "displayName": m.get("displayName", ""),
                }
            )
    return result


# --------------------------------------------------------------------------
# HTTP handler
# --------------------------------------------------------------------------
class CustomHandler(http.server.SimpleHTTPRequestHandler):
    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    class _BodyTooLarge(Exception):
        pass

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0:
            return {}
        if length > MAX_BODY_BYTES:
            raise self._BodyTooLarge()
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None

    # ---------------------------------------------------------------- GET
    def do_GET(self):
        parsed_url = urllib.parse.urlparse(self.path)

        if parsed_url.path in BLOCKED_STATIC_PATHS:
            self._send_json(404, {"error": "Not found"})
            return

        if parsed_url.path == "/api/scrape":
            self._handle_scrape(parsed_url)
            return

        if parsed_url.path == "/api/config/status":
            self._send_json(200, {"configured": get_stored_api_key() is not None})
            return

        if parsed_url.path == "/api/models":
            self._handle_list_models()
            return

        return super().do_GET()

    def _handle_scrape(self, parsed_url):
        query_params = urllib.parse.parse_qs(parsed_url.query)
        target_url = query_params.get("url", [None])[0]

        if not target_url:
            self._send_json(400, {"error": "Missing url parameter"})
            return

        safe, reason, pinned_ip = is_safe_public_url(target_url)
        if not safe:
            self._send_json(400, {"error": reason})
            return

        try:
            req = urllib.request.Request(
                target_url,
                headers={
                    "User-Agent": (
                        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                    )
                },
            )
            # Connect to the exact IP we just validated (see _make_pinned_opener)
            # instead of letting urllib resolve the hostname again, which would
            # reopen the DNS-rebinding gap the check above is meant to close.
            opener = _make_pinned_opener(pinned_ip)
            with opener.open(req, timeout=10) as response:
                html_content = response.read(2_000_000).decode("utf-8", errors="ignore")

            html_content = re.sub(r"<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>", "", html_content)
            html_content = re.sub(r"<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>", "", html_content)

            text = strip_tags(html_content)
            text = re.sub(r"\s+", " ", text).strip()
            truncated_text = text[:4000]

            self._send_json(200, {"text": truncated_text})
        except Exception as e:
            print(f"[scrape] failed for {target_url}: {e}")
            self._send_json(502, {"error": "Website konnte nicht abgerufen werden."})

    def _handle_list_models(self):
        api_key = get_stored_api_key()
        if not api_key:
            self._send_json(400, {"error": "Kein API-Key hinterlegt.", "models": []})
            return
        try:
            models = call_gemini_list_models(api_key)
            self._send_json(200, {"models": models})
        except Exception as e:
            print(f"[models] failed: {e}")
            self._send_json(502, {"error": "Modelle konnten nicht geladen werden.", "models": []})

    # --------------------------------------------------------------- POST
    def do_POST(self):
        parsed_url = urllib.parse.urlparse(self.path)

        try:
            if parsed_url.path == "/api/generate":
                self._handle_generate()
                return

            if parsed_url.path == "/api/config":
                self._handle_save_config()
                return

            if parsed_url.path == "/api/config/clear":
                try:
                    clear_api_key()
                    self._send_json(200, {"ok": True})
                except Exception as e:
                    print(f"[config/clear] failed: {e}")
                    self._send_json(500, {"error": "Konnte den Key nicht entfernen."})
                return

            self._send_json(404, {"error": "Not found"})
        except self._BodyTooLarge:
            self._send_json(413, {"error": "Anfrage ist zu groß."})

    def _handle_generate(self):
        body = self._read_json_body()
        if body is None:
            self._send_json(400, {"error": "Ungueltiger Request-Body."})
            return

        prompt = (body or {}).get("prompt", "").strip()
        model = (body or {}).get("model", DEFAULT_MODEL)

        if not prompt:
            self._send_json(400, {"error": "Fehlender Prompt."})
            return

        api_key = get_stored_api_key()
        if not api_key:
            self._send_json(400, {"error": "Kein Gemini API-Key hinterlegt. Bitte zuerst in den Einstellungen speichern."})
            return

        try:
            text = call_gemini_generate(api_key, prompt, model)
            self._send_json(200, {"text": text})
        except urllib.error.HTTPError as e:
            try:
                err_body = json.loads(e.read().decode("utf-8"))
                message = err_body.get("error", {}).get("message", f"HTTP-Fehler {e.code}")
            except Exception:
                message = f"HTTP-Fehler {e.code}"
            print(f"[generate] Gemini HTTP error: {message}")
            self._send_json(502, {"error": message})
        except Exception as e:
            print(f"[generate] failed: {e}")
            self._send_json(502, {"error": "Anfrage an die KI ist fehlgeschlagen."})

    def _handle_save_config(self):
        body = self._read_json_body()
        if body is None:
            self._send_json(400, {"error": "Ungueltiger Request-Body."})
            return

        api_key = (body or {}).get("apiKey", "").strip()
        if not api_key:
            self._send_json(400, {"error": "Kein API-Key uebergeben."})
            return

        save_api_key(api_key)
        self._send_json(200, {"ok": True})

    def log_message(self, format, *args):
        # Keep default stdout logging, but route through print() consistently.
        print("%s - %s" % (self.address_string(), format % args))


class MyThreadingServer(http.server.ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with MyThreadingServer((HOST, PORT), CustomHandler) as httpd:
        print(f"Serving Sales Strategist on http://{'localhost' if HOST in ('127.0.0.1', 'localhost') else HOST}:{PORT}")
        if HOST not in ("127.0.0.1", "localhost"):
            print(f"WARNUNG: Server ist auf {HOST} erreichbar, nicht nur von diesem Rechner. "
                  f"Jeder im selben Netzwerk kann deinen gespeicherten Gemini-Key mitbenutzen.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
