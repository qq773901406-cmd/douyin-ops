"""Offline event-reconnect tests; no Gradio, HTTP or generation service used."""
import asyncio
import concurrent.futures
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
from collections import deque
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("free_wan", Path(__file__).resolve().parents[1] / "tools/video_generation/free_wan.py")
wan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wan)
SESSION, EVENT = "fixture-session", "fixture-event"
VIDEO = wan.APP_URL + "/gradio_api/file=/tmp/gradio/" + "a" * 64 + "/video.mp4"
RESULT = [{"url": VIDEO, "path": "/tmp/gradio/" + "a" * 64 + "/video.mp4", "meta": {"_type": "gradio.FileData"}}, 42]


def completed(event=EVENT, result=RESULT, success=True):
    return {"msg": "process_completed", "event_id": event, "success": success, "output": {"data": result}}


class FakeStream:
    status_code = 200
    headers = {"content-type": "text/event-stream; charset=utf-8"}

    def __init__(self, script, observer):
        self.script, self.observer = script, observer

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def aiter_lines(self):
        self.observer()
        if self.script == "timeout":
            await asyncio.sleep(10)
        elif isinstance(self.script, Exception):
            raise self.script
        else:
            for event in self.script:
                yield "data: " + json.dumps(event)
                yield ""


class FakeHttp:
    def __init__(self, scripts, observer=lambda: None):
        self.scripts, self.observer, self.calls = list(scripts), observer, []

    def AsyncClient(self, **options):
        owner = self

        class Transport:
            async def __aenter__(self):
                assert options["verify"] is True and options["follow_redirects"] is False
                return self

            async def __aexit__(self, *args):
                return False

            def stream(self, method, url, **kwargs):
                assert method == "GET"
                assert url == wan.APP_URL + "/gradio_api/queue/data"
                assert kwargs["params"] == {"session_hash": SESSION}
                owner.calls.append((method, url, kwargs))
                return FakeStream(owner.scripts.pop(0), owner.observer)

        return Transport()


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="wan-get-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.receipt = self.root / "request.json"
        self.record = {"session_hash": SESSION, "event_id": EVENT, "status": "unknown"}
        self.client = SimpleNamespace(session_hash=SESSION, sse_url=wan.APP_URL + "/gradio_api/queue/data", ssl_verify=True,
            httpx_kwargs={}, headers={}, cookies={}, streaming_future=None)
        self.job = SimpleNamespace(communicator=SimpleNamespace(event_id=EVENT, should_cancel=False))

    def recover(self, scripts, **kwargs):
        http = FakeHttp(scripts)
        result = wan.recover_cancelled_result(self.record, self.client, self.job, self.receipt, httpx_module=http, **kwargs)
        return result, http

    def test_matching_original_event_after_eof_only_two_gets(self):
        result, http = self.recover([[completed("other-event")], [completed()]])
        self.assertEqual(result, RESULT)
        self.assertEqual(len(http.calls), 2)
        persisted = json.loads(self.receipt.read_text())
        self.assertEqual(persisted["get_recovery"]["status"], "recovered")
        self.assertFalse(persisted["get_recovery"]["remote_resubmitted"])
        self.assertFalse(persisted["get_recovery"]["attempts"][0]["observations"][0]["matches_event"])
        self.assertEqual(persisted["get_recovery"]["attempts"][1]["completion"]["output"]["data"], RESULT)

    def test_missing_mismatched_or_cancelled_identity_does_not_read(self):
        for field, target, value in [("event_id", self.record, None), ("session_hash", self.client, "changed"),
            ("event_id", self.job.communicator, "changed"), ("should_cancel", self.job.communicator, True),
            ("sse_url", self.client, "https://other.example/queue/data")]:
            original = target[field] if isinstance(target, dict) else getattr(target, field)
            if isinstance(target, dict):
                target[field] = value
            else:
                setattr(target, field, value)
            result, http = self.recover([])
            self.assertIsNone(result)
            self.assertEqual(http.calls, [])
            if isinstance(target, dict):
                target[field] = original
            else:
                setattr(target, field, original)

    def test_missing_invalid_or_failed_completion_remains_unknown(self):
        for scripts in [
            [[completed("other-event")], []],
            [[{"msg": "unexpected_error", "message": "Session not found"}]],
            [[completed(success=False)]], [[completed(result=[])]],
            [[completed(result=[{"url": "https://other.example/video.mp4"}])]],
            [[{"msg": "process_completed", "success": True, "output": {"data": RESULT}}], []],
        ]:
            result, http = self.recover(scripts)
            self.assertIsNone(result)
            self.assertLessEqual(len(http.calls), 2)
            self.assertEqual(self.record["status"], "unknown")
            self.assertEqual(self.record["get_recovery"]["status"], "unresolved")

    def test_transport_failure_retries_only_get_and_has_one_total_deadline(self):
        result, http = self.recover([ConnectionError("disconnected"), [completed()]])
        self.assertEqual(result, RESULT)
        self.assertEqual(len(http.calls), 2)
        started = time.monotonic()
        result, http = self.recover(["timeout"], timeout_seconds=0.02)
        self.assertIsNone(result)
        self.assertLess(time.monotonic() - started, 1)
        self.assertEqual(len(http.calls), 1)
        self.assertEqual(self.record["get_recovery"]["error_type"], "TimeoutError")

    def generate_fixture(self, exception, scripts):
        source = self.root / "input.jpg"
        source.write_bytes(b"\xff\xd8\xfffixture")
        output = self.root / "job"
        record = {"input_image": str(source), "out_dir": str(output), "parameters": {"duration_seconds": 5, "seed": 42}}
        counts = {"clients": 0, "submits": 0, "closed": 0, "downloads": 0}
        client = self.client
        client.heartbeat_running = True
        client.view_api = lambda **kwargs: {"named_endpoints": {"/generate_video": {}}}

        def client_factory(*args, **kwargs):
            counts["clients"] += 1
            return client

        def submit(**kwargs):
            counts["submits"] += 1
            return self.job

        def close():
            counts["closed"] += 1
            client.heartbeat_running = False

        def job_result():
            raise exception

        client.submit, client.close = submit, close
        self.job.done, self.job.result = lambda: True, job_result
        http = FakeHttp(scripts, observer=lambda: self.assertTrue(client.heartbeat_running))
        recover = wan.recover_cancelled_result

        def recover_with_fake(*args, **kwargs):
            return recover(*args, httpx_module=http, **kwargs)

        def download(url, **kwargs):
            counts["downloads"] += 1
            self.assertEqual(url, VIDEO)
            evidence = json.loads((output / "request.json").read_text())
            self.assertEqual(evidence["get_recovery"]["status"], "recovered")
            self.assertEqual(evidence["get_recovery"]["attempts"][-1]["completion"]["event_id"], EVENT)
            return io.BytesIO(b"\x00\x00\x00\x18ftypisomfixture-media")

        with patch.object(wan, "create_pinned_client", lambda factory, *_args: factory()), patch.object(wan, "install_result_reader"), patch.object(wan, "recover_cancelled_result", recover_with_fake), patch.object(wan, "urlopen", download), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            code = wan.generate(record, client_factory, lambda path: path)
        return code, json.loads((output / "request.json").read_text()), counts, http

    def test_cancelled_result_recovers_before_closing_same_client_and_never_resubmits(self):
        code, receipt, counts, http = self.generate_fixture(concurrent.futures.CancelledError(), [[completed()]])
        self.assertEqual(code, 0)
        self.assertEqual(receipt["status"], "completed")
        self.assertEqual(counts, {"clients": 1, "submits": 1, "closed": 1, "downloads": 1})
        self.assertEqual(len(http.calls), 1)

    def test_cancelled_without_result_stays_unknown_and_is_not_attributed_to_user(self):
        code, receipt, counts, http = self.generate_fixture(concurrent.futures.CancelledError(), [[{"msg": "unexpected_error", "message": "Session not found"}]])
        self.assertEqual(code, 2)
        self.assertEqual(receipt["status"], "unknown")
        self.assertEqual(receipt["error_type"], "CancelledError")
        self.assertNotIn("Interrupted by user", receipt["error"])
        self.assertEqual(counts["submits"], 1)
        self.assertEqual(counts["downloads"], 0)

    def test_keyboard_interrupt_never_reconnects(self):
        code, receipt, counts, http = self.generate_fixture(KeyboardInterrupt(), [])
        self.assertEqual(code, 2)
        self.assertEqual(receipt["status"], "unknown")
        self.assertEqual(receipt["error"], "Interrupted by user")
        self.assertEqual(http.calls, [])
        self.assertEqual(counts["submits"], 1)


class DeferredReaderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="wan-deferred-test-")
        self.addCleanup(self.temp.cleanup)
        self.receipt = Path(self.temp.name) / "request.json"
        self.record = {"session_hash": SESSION, "event_id": EVENT}
        self.client = SimpleNamespace(config={"space_id": wan.SPACE, "version": "6.1.0", "protocol": "sse_v3", "connect_heartbeat": False,
            "dependencies": [{"api_name": "generate_video", "queue": True, "types": {"generator": False}, "connection": "sse"}]},
            session_hash=SESSION, sse_url=wan.APP_URL + "/gradio_api/queue/data", ssl_verify=True,
            httpx_kwargs={}, headers={}, cookies={"fixture-routing": "same-replica"},
            pending_lock=threading.Lock(), pending_event_ids={EVENT}, pending_messages_per_event={EVENT: deque()})
        self.waited, self.calls = [], []
        self.client._kill_heartbeat = SimpleNamespace(wait=lambda seconds: self.waited.append(seconds) or False, is_set=lambda: False)

    def install(self, messages, *, failure=None, observer=lambda: None):
        owner = self

        class Response:
            status_code = 200
            headers = {"content-type": "text/event-stream", "x-proxied-replica": owner.record.get("observed_replica", "")}

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def iter_lines(self):
                observer()
                for message in messages:
                    yield "data: " + json.dumps(message)
                    yield ""
                if failure:
                    raise failure

        class Transport:
            def __init__(self, **options):
                owner.assertIs(options["verify"], True)
                owner.assertIs(options["follow_redirects"], False)

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def stream(self, method, url, **kwargs):
                owner.assertEqual(owner.waited, [120])
                owner.assertEqual(method, "GET")
                owner.assertEqual(url, owner.client.sse_url)
                owner.assertEqual(kwargs["params"], {"session_hash": SESSION})
                owner.assertEqual(kwargs["cookies"], {"fixture-routing": "same-replica"})
                owner.assertEqual(kwargs["headers"]["Accept-Encoding"], "identity")
                owner.calls.append((method, url))
                return Response()

        http = SimpleNamespace(Client=Transport, Timeout=lambda *args, **kwargs: (args, kwargs))
        wan.install_result_reader(self.client, self.record, self.receipt, httpx_module=http)

    def journal(self):
        return json.loads((self.receipt.parent / "result-stream.json").read_text(encoding="utf-8"))

    def test_waits_before_only_original_get_and_persists_completion_before_delivery(self):
        owner = self

        class ObservedQueue(deque):
            def append(self, message):
                if message["msg"] == "process_completed":
                    owner.assertEqual(owner.journal()["completion"], message)
                super().append(message)

        self.client.pending_messages_per_event[EVENT] = ObservedQueue()
        self.install([{"msg": "heartbeat"}, completed("other-event"), completed()])
        self.client.stream_messages("sse_v3", SESSION)
        self.assertEqual(self.calls, [("GET", self.client.sse_url)])
        self.assertEqual(list(self.client.pending_messages_per_event[EVENT]), [completed()])
        self.assertEqual(wan.persisted_stream_result(self.record, self.receipt), RESULT)
        self.assertFalse(self.journal()["remote_resubmitted"])

    def test_changed_service_is_rejected_before_submission(self):
        for key, value in [("version", "6.2.0"), ("protocol", "sse_v2"), ("connect_heartbeat", True)]:
            original = self.client.config[key]
            self.client.config[key] = value
            with self.assertRaisesRegex(RuntimeError, "before submission"):
                self.install([])
            self.client.config[key] = original
        self.assertEqual(self.calls, [])
        self.assertEqual(self.waited, [])

    def test_verified_pinned_route_is_used_for_original_event_and_download(self):
        self.record.update(observed_replica="observed-replica", app_url=wan.APP_URL + "/--replicas/observed-replica")
        self.client.sse_url = self.record["app_url"] + "/gradio_api/queue/data"
        self.install([completed()])
        self.client.stream_messages("sse_v3", SESSION)
        self.assertEqual(self.calls, [("GET", self.client.sse_url)])
        self.assertEqual(wan.persisted_stream_result(self.record, self.receipt), RESULT)
        self.assertEqual(wan.video_url(RESULT, self.record), VIDEO.replace(wan.APP_URL, self.record["app_url"], 1))

    def test_local_close_during_delay_makes_no_get_or_resubmission(self):
        self.client._kill_heartbeat.wait = lambda seconds: True
        self.install([])
        with self.assertRaises(concurrent.futures.CancelledError):
            self.client.stream_messages("sse_v3", SESSION)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.journal()["error_type"], "CancelledError")

    def test_transport_cause_is_preserved_without_resubmission(self):
        self.install([{"msg": "progress", "event_id": EVENT}], failure=ConnectionError("peer closed original stream"))
        with self.assertRaises(ConnectionError):
            self.client.stream_messages("sse_v3", SESSION)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.journal()["error_type"], "ConnectionError")
        self.assertIn("peer closed", self.journal()["error"])
        self.assertIsNone(wan.persisted_stream_result(self.record, self.receipt))

    def test_failed_or_foreign_terminal_message_cannot_be_used_as_a_video(self):
        self.install([completed(success=False)])
        self.client.stream_messages("sse_v3", SESSION)
        self.assertIsNone(wan.persisted_stream_result(self.record, self.receipt))
        journal = self.journal()
        journal["completion"] = completed()
        journal["session_hash"] = "foreign-session"
        wan.save_receipt(self.receipt.parent / "result-stream.json", journal)
        self.assertIsNone(wan.persisted_stream_result(self.record, self.receipt))


class ReplicaRoutingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="wan-pin-test-")
        self.addCleanup(self.temp.cleanup)
        self.receipt = Path(self.temp.name) / "request.json"
        self.replica = "observed-replica"
        self.route = wan.APP_URL + "/--replicas/" + self.replica
        self.record = {}
        self.calls, self.clients = [], []

    def connect(self, observed="observed-replica", verified="observed-replica"):
        owner = self
        responses = [observed, verified]

        def get(url, **options):
            owner.assertIs(options["verify"], True)
            owner.assertIs(options["follow_redirects"], False)
            owner.calls.append(url)
            replica = responses.pop(0)
            return SimpleNamespace(status_code=200, headers={"x-proxied-replica": replica},
                json=lambda: {"space_id": wan.SPACE, "version": "6.1.0", "protocol": "sse_v3"})

        def client(url, **options):
            owner.clients.append((url, options))
            return SimpleNamespace(src=url)

        return wan.create_pinned_client(client, self.record, self.receipt, httpx_module=SimpleNamespace(get=get))

    def test_only_current_observed_replica_is_verified_and_used(self):
        client = self.connect()
        self.assertEqual(self.calls, [wan.APP_URL + "/config", self.route + "/config"])
        self.assertEqual(client.src, self.route)
        self.assertEqual(self.clients, [(self.route, {"token": False, "analytics_enabled": False, "download_files": False})])
        self.assertEqual(self.record["observed_replica"], self.replica)
        self.assertEqual(self.record["app_url"], self.route)

    def test_missing_unsafe_or_mismatched_replica_fails_without_a_client_or_fallback(self):
        for observed, verified in [(None, None), ("../other", "../other"), (self.replica, "different-replica")]:
            self.calls.clear()
            with self.assertRaises(RuntimeError):
                self.connect(observed, verified)
            self.assertEqual(self.clients, [])
            self.assertLessEqual(len(self.calls), 2)

    def test_file_uses_only_verified_replica_without_rewriting_returned_metadata(self):
        self.connect()
        before = json.dumps(RESULT)
        expected = VIDEO.replace(wan.APP_URL, self.route, 1)
        self.assertEqual(wan.video_url(RESULT, self.record), expected)
        self.assertEqual(json.dumps(RESULT), before)
        pinned = [{**RESULT[0], "url": expected}, RESULT[1]]
        self.assertEqual(wan.video_url(pinned, self.record), expected)
        for record, value in [({}, pinned), (self.record, [{**RESULT[0], "url": VIDEO.replace(wan.APP_URL, wan.APP_URL + "/--replicas/foreign", 1)}]),
            ({**self.record, "app_url": "https://other.example"}, RESULT),
            (self.record, [{**RESULT[0], "path": "/tmp/gradio/" + "b" * 64 + "/video.mp4"}])]:
            with self.assertRaises(ValueError):
                wan.video_url(value, record)
        self.assertEqual(wan.video_url(RESULT), VIDEO)


if __name__ == "__main__":
    unittest.main()
