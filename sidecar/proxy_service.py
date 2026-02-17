import argparse
import asyncio
import gzip
import json
import queue
import socket
import threading
import time
import zlib
from datetime import datetime, timezone

from mitmproxy import http, options
from mitmproxy.tools.dump import DumpMaster


MAX_BODY_CAPTURE = 100 * 1024
TEXTUAL_CONTENT_HINTS = (
    "text/",
    "application/json",
    "application/xml",
    "application/javascript",
    "application/x-www-form-urlencoded",
    "application/graphql",
    "application/x-ndjson",
)
BINARY_CONTENT_HINTS = (
    "application/octet-stream",
    "application/x-protobuf",
    "application/protobuf",
    "application/grpc",
    "application/pdf",
    "application/zip",
    "image/",
    "audio/",
    "video/",
    "font/",
)


def _truncate_bytes(data, limit=MAX_BODY_CAPTURE):
    if data is None:
        return b""
    if len(data) <= limit:
        return data
    return data[:limit]


def _safe_decode(data):
    if not data:
        return "", False
    try:
        text = data.decode("utf-8")
        return text, False
    except UnicodeDecodeError:
        text = data.decode("utf-8", errors="replace")
        return text, True


def _get_header_value(headers, name):
    if not headers:
        return ""
    target = name.lower()
    try:
        items = headers.items(multi=True)
    except TypeError:
        items = headers.items()
    for k, v in items:
        if str(k).lower() == target:
            return str(v)
    return ""


def _looks_binary_from_text(text):
    if not text:
        return False
    sample = text[:2000]
    control_count = sum(1 for c in sample if ord(c) < 32 and c not in ("\n", "\r", "\t"))
    replacement_count = sample.count("\ufffd")
    ratio = (control_count + replacement_count) / max(1, len(sample))
    return ratio > 0.08


def _decode_for_display(data, headers):
    if not data:
        return ""

    content_type = _get_header_value(headers, "content-type").lower()
    content_encoding = _get_header_value(headers, "content-encoding").lower()

    lowered_ct = content_type.lower()
    is_likely_binary = any(hint in lowered_ct for hint in BINARY_CONTENT_HINTS)

    decoded_bytes = data
    try:
        if "gzip" in content_encoding:
            decoded_bytes = gzip.decompress(data)
        elif "deflate" in content_encoding:
            decoded_bytes = zlib.decompress(data)
        elif "br" in content_encoding:
            try:
                import brotli  # optional dependency at runtime

                decoded_bytes = brotli.decompress(data)
            except Exception:
                decoded_bytes = data
    except Exception:
        decoded_bytes = data

    text, had_decode_issue = _safe_decode(decoded_bytes)
    is_textual = any(hint in lowered_ct for hint in TEXTUAL_CONTENT_HINTS)

    if (is_likely_binary and not is_textual) or (had_decode_issue and not is_textual) or _looks_binary_from_text(text):
        kind = content_type or "binary/unknown"
        return f"[binary body omitted: {kind}; {len(data)} bytes]"

    return text


def _headers_to_list(headers):
    try:
        items = headers.items(multi=True)
    except TypeError:
        items = headers.items()
    return [{"name": k, "value": v} for k, v in items]


def _iso_time(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def _wait_for_port(host, port, timeout=5.0):
    start = time.time()
    while time.time() - start < timeout:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.05)
    return False


def _port_in_use(host, port):
    try:
        with socket.create_connection((host, port), timeout=0.2):
            return True
    except OSError:
        return False


class CaptureState:
    def __init__(self):
        self.capture_enabled = threading.Event()
        self.capture_enabled.set()
        self.paused = threading.Event()

    def should_capture(self):
        return self.capture_enabled.is_set() and not self.paused.is_set()


class FlowCollector:
    def __init__(self, out_queue, state):
        self.out_queue = out_queue
        self.state = state

    def error(self, flow: http.HTTPFlow):
        if not self.state.should_capture():
            return
        req = flow.request
        started = req.timestamp_start or time.time()
        ended = time.time()
        duration_ms = max(0, int((ended - started) * 1000))
        error_msg = ""
        if flow.error:
            error_msg = getattr(flow.error, "msg", str(flow.error))

        record = {
            "id": flow.id,
            "started": started,
            "ended": ended,
            "duration_ms": duration_ms,
            "method": req.method,
            "url": req.url,
            "host": req.host,
            "path": req.path,
            "scheme": req.scheme,
            "status_code": 0,
            "request_headers": _headers_to_list(req.headers),
            "response_headers": None,
            "request_body_size": len(req.content or b""),
            "response_body_size": 0,
            "request_body": _decode_for_display(_truncate_bytes(req.content or b""), req.headers),
            "response_body": "",
            "request_body_truncated": len(req.content or b"") > MAX_BODY_CAPTURE,
            "response_body_truncated": False,
            "error": error_msg,
            "started_iso": _iso_time(started),
        }
        self.out_queue.put({"type": "flow", "record": record})

    def response(self, flow: http.HTTPFlow):
        if not self.state.should_capture():
            return
        req = flow.request
        resp = flow.response

        started = req.timestamp_start or time.time()
        ended = resp.timestamp_end or time.time()
        duration_ms = max(0, int((ended - started) * 1000))
        resp_body = resp.content or b""
        req_body = req.content or b""

        record = {
            "id": flow.id,
            "started": started,
            "ended": ended,
            "duration_ms": duration_ms,
            "method": req.method,
            "url": req.url,
            "host": req.host,
            "path": req.path,
            "scheme": req.scheme,
            "status_code": resp.status_code if resp else 0,
            "request_headers": _headers_to_list(req.headers),
            "response_headers": _headers_to_list(resp.headers) if resp else None,
            "request_body_size": len(req_body),
            "response_body_size": len(resp_body),
            "request_body": _decode_for_display(_truncate_bytes(req_body), req.headers),
            "response_body": _decode_for_display(_truncate_bytes(resp_body), resp.headers if resp else None),
            "request_body_truncated": len(req_body) > MAX_BODY_CAPTURE,
            "response_body_truncated": len(resp_body) > MAX_BODY_CAPTURE,
            "error": "",
            "started_iso": _iso_time(started),
        }
        self.out_queue.put({"type": "flow", "record": record})


class ProxyService:
    def __init__(self, event_queue):
        self.event_queue = event_queue
        self.state = CaptureState()
        self.proxy_thread = None
        self.proxy_master = None
        self.proxy_loop = None
        self.current_port = None
        self._lock = threading.Lock()
        self._start_in_progress = False
        self._last_start_error = ""

    def _running_message(self, port):
        return f"Proxy Running on 127.0.0.1:{port}" if port else "Proxy Running"

    def current_status_payload(self):
        port = self.current_port
        if self.proxy_thread and self.proxy_thread.is_alive():
            if self.state.paused.is_set():
                return {"type": "status", "status": "paused", "message": "Paused", "port": port}
            if self.state.capture_enabled.is_set():
                return {
                    "type": "status",
                    "status": "running",
                    "message": self._running_message(port),
                    "port": port,
                }
        return {"type": "status", "status": "stopped", "message": "Ready", "port": port}

    def _candidate_ports(self, requested_port):
        yield requested_port
        for candidate in range(requested_port + 1, requested_port + 21):
            yield candidate

    def start(self, port):
        with self._lock:
            previous_port = self.current_port
            if self.proxy_thread and self.proxy_thread.is_alive():
                # If already running on requested port, just resume capture.
                if previous_port == port:
                    self.state.capture_enabled.set()
                    self.state.paused.clear()
                    self._status("running", self._running_message(port), port=port)
                    return
                # Restart on a different port.
                self._shutdown_proxy_locked()

            self.state.capture_enabled.set()
            self.state.paused.clear()
            self._start_in_progress = True
            self._last_start_error = ""

            def run_proxy(listen_port):
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                self.proxy_loop = loop
                opts = options.Options(listen_host="127.0.0.1", listen_port=listen_port, ssl_insecure=True)
                master = DumpMaster(opts, loop=loop, with_termlog=False, with_dumper=False)
                self.proxy_master = master
                master.addons.add(FlowCollector(self.event_queue, self.state))
                try:
                    result = master.run()
                    if asyncio.iscoroutine(result):
                        loop.run_until_complete(result)
                except Exception as exc:
                    self._last_start_error = str(exc)
                    if not self._start_in_progress:
                        self.event_queue.put({"type": "error", "message": str(exc)})
                        self._status("stopped", "Stopped", port=self.current_port)
                finally:
                    try:
                        master.shutdown()
                    except Exception:
                        pass
                    try:
                        loop.close()
                    except Exception:
                        pass
                    self.proxy_master = None
                    self.proxy_loop = None
                    self.proxy_thread = None

            started = False
            for candidate in self._candidate_ports(port):
                # Fast skip for ports that are already occupied.
                if _port_in_use("127.0.0.1", candidate):
                    continue
                self.current_port = candidate
                self.proxy_thread = threading.Thread(target=run_proxy, args=(candidate,), daemon=True)
                self.proxy_thread.start()
                if _wait_for_port("127.0.0.1", candidate, timeout=2.5) and self.proxy_thread.is_alive():
                    self._status("running", self._running_message(candidate), port=candidate)
                    started = True
                    break
                self._shutdown_proxy_locked()

            self._start_in_progress = False
            if not started:
                self.current_port = None
                self._status("stopped", f"Failed to start proxy near 127.0.0.1:{port}", port=port)
                detail = self._last_start_error or "Port may be busy or blocked."
                self.event_queue.put(
                    {
                        "type": "error",
                        "message": f"Proxy failed to start near 127.0.0.1:{port}. {detail}",
                    }
                )

    def stop(self):
        with self._lock:
            self.state.capture_enabled.clear()
            self.state.paused.clear()
            self._shutdown_proxy_locked()
            self._status("stopped", "Stopped", port=self.current_port)
            self.current_port = None

    def pause(self):
        with self._lock:
            if not (self.proxy_thread and self.proxy_thread.is_alive()):
                return
            self.state.paused.set()
            self._status("paused", "Paused", port=self.current_port)

    def resume(self):
        with self._lock:
            if not (self.proxy_thread and self.proxy_thread.is_alive()):
                return
            self.state.paused.clear()
            self._status("running", self._running_message(self.current_port), port=self.current_port)

    def _status(self, status, message, port=None):
        self.event_queue.put({"type": "status", "status": status, "message": message, "port": port})

    def _shutdown_proxy_locked(self):
        if self.proxy_master is not None:
            try:
                if self.proxy_loop is not None:
                    self.proxy_loop.call_soon_threadsafe(self.proxy_master.shutdown)
                else:
                    self.proxy_master.shutdown()
            except Exception:
                pass
        if self.proxy_thread and self.proxy_thread.is_alive():
            self.proxy_thread.join(timeout=5)
        self.proxy_master = None
        self.proxy_loop = None
        self.proxy_thread = None


class IpcServer:
    def __init__(self, host, port, proxy_service):
        self.host = host
        self.port = port
        self.proxy_service = proxy_service
        self.event_queue = proxy_service.event_queue
        self.clients = set()

    async def start(self):
        server = await asyncio.start_server(self._handle_client, self.host, self.port)
        async with server:
            await server.serve_forever()

    async def _handle_client(self, reader, writer):
        self.clients.add(writer)
        try:
            await self._send(writer, self.proxy_service.current_status_payload())
            while True:
                line = await reader.readline()
                if not line:
                    break
                try:
                    msg = json.loads(line.decode("utf-8"))
                    await self._handle_command(msg)
                except json.JSONDecodeError:
                    continue
        finally:
            self.clients.discard(writer)
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    async def _handle_command(self, msg):
        msg_type = msg.get("type")
        if msg_type == "start":
            port = int(msg.get("port", 8080))
            self.proxy_service.start(port)
        elif msg_type == "stop":
            self.proxy_service.stop()
        elif msg_type == "pause":
            self.proxy_service.pause()
        elif msg_type == "resume":
            self.proxy_service.resume()

    async def broadcast(self, payload):
        if not self.clients:
            return
        dead = []
        for writer in self.clients:
            try:
                await self._send(writer, payload)
            except Exception:
                dead.append(writer)
        for writer in dead:
            self.clients.discard(writer)

    async def _send(self, writer, payload):
        writer.write((json.dumps(payload) + "\n").encode("utf-8"))
        await writer.drain()


async def pump_events(ipc_server, event_queue):
    while True:
        payload = await asyncio.to_thread(event_queue.get)
        await ipc_server.broadcast(payload)


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ipc-port", type=int, default=8787)
    args = parser.parse_args()

    event_queue = queue.Queue()
    proxy_service = ProxyService(event_queue)
    ipc_server = IpcServer("127.0.0.1", args.ipc_port, proxy_service)

    await asyncio.gather(ipc_server.start(), pump_events(ipc_server, event_queue))


if __name__ == "__main__":
    asyncio.run(main())
