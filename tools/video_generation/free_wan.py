"""Generate one video on the verified public Wan2.2 Space, without login."""

from __future__ import annotations

import argparse
import asyncio
import concurrent.futures
import dataclasses
from datetime import datetime, timezone
import hashlib
import importlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import sys
import time
import types
from collections import deque
from urllib.parse import quote, urlparse
from urllib.request import urlopen


SPACE = "zerogpu-aoti/wan2-2-fp8da-aoti-faster"
APP_URL = "https://zerogpu-aoti-wan2-2-fp8da-aoti-faster.hf.space"
CLIENT_VERSION = "2.7.2"
WAIT_SECONDS = 720
GET_RECOVERY_SECONDS = 60
GET_RECOVERY_ATTEMPTS = 2
RESULT_READ_DELAY_SECONDS = 120
NEGATIVE_PROMPT = (
    "static image, slideshow, camera cuts, extra limbs, detached paws, fused limbs, "
    "morphing faces, identity swap, floating feet, text, subtitles, watermark, phone interface"
)


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def json_value(value):
    if dataclasses.is_dataclass(value):
        return dataclasses.asdict(value)
    if hasattr(value, "model_dump"):
        return value.model_dump()
    return str(value)


def save_receipt(path, record):
    record["updated_at"] = timestamp()
    temporary = path.with_suffix(".json.tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(record, stream, ensure_ascii=False, indent=2, default=json_value)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--image", required=True, type=Path, help="Local JPEG, PNG or WebP first frame")
    prompts = result.add_mutually_exclusive_group(required=True)
    prompts.add_argument("--prompt", help="Motion prompt")
    prompts.add_argument("--prompt-file", type=Path, help="UTF-8 motion prompt file")
    result.add_argument("--out-dir", required=True, type=Path, help="New, non-existing job directory")
    result.add_argument("--duration", type=float, default=3.5, help="Seconds, 0.5-5 (default: 3.5)")
    result.add_argument("--seed", type=int, default=42, help="Seed, 0-2147483647 (default: 42)")
    result.add_argument("--deps-dir", type=Path, help="Fallback directory for missing dependency modules")
    result.add_argument("--dry-run", action="store_true", help="Offline input validation; no imports, files or API calls")
    return result


def validated_request(args):
    image = args.image.expanduser().resolve(strict=True)
    if not image.is_file():
        raise ValueError("--image must be a local file")
    with image.open("rb") as stream:
        header = stream.read(12)
    supported = (
        header.startswith(b"\xff\xd8\xff")
        or header.startswith(b"\x89PNG\r\n\x1a\n")
        or (header.startswith(b"RIFF") and header[8:12] == b"WEBP")
    )
    if not supported:
        raise ValueError("--image must have a JPEG, PNG or WebP header")
    if not math.isfinite(args.duration) or not 0.5 <= args.duration <= 5:
        raise ValueError("--duration must be between 0.5 and 5 seconds")
    if not 0 <= args.seed <= 2147483647:
        raise ValueError("--seed must be between 0 and 2147483647")
    prompt = args.prompt_file.read_text(encoding="utf-8-sig") if args.prompt_file else args.prompt
    prompt = prompt.strip()
    if not prompt:
        raise ValueError("Motion prompt must not be empty")
    output = args.out_dir.expanduser().resolve()
    if output.exists():
        raise ValueError(
            f"Output directory already exists: {output}. Existing jobs are never resubmitted or overwritten. "
            "Check its receipt before intentionally starting a separate job in a new directory."
        )
    if args.deps_dir and not args.deps_dir.expanduser().is_dir():
        raise ValueError("--deps-dir must be an existing directory")
    return {
        "space": SPACE,
        "space_url": f"https://huggingface.co/spaces/{SPACE}",
        "anonymous": True,
        "paid_subscription_or_trial": False,
        "input_image": str(image),
        "out_dir": str(output),
        "parameters": {
            "prompt": prompt,
            "negative_prompt": NEGATIVE_PROMPT,
            "duration_seconds": args.duration,
            "steps": 6,
            "guidance_scale": 1.0,
            "guidance_scale_2": 1.0,
            "seed": args.seed,
            "randomize_seed": False,
        },
    }


def load_client(deps_dir):
    # Never use an HF login cached on the machine or a token from the environment.
    os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["GRADIO_ANALYTICS_ENABLED"] = "False"
    try:
        try:
            module = importlib.import_module("gradio_client")
        except ModuleNotFoundError:
            if not deps_dir:
                raise
            sys.path.append(str(deps_dir.expanduser().resolve()))
            importlib.invalidate_caches()
            module = importlib.import_module("gradio_client")
    except ImportError as error:
        raise RuntimeError(
            "Install requirements-free.txt in your Python environment, or supply --deps-dir. "
            "--dry-run and --help require only Python's standard library."
        ) from error
    if module.__version__ != CLIENT_VERSION:
        raise RuntimeError(f"Expected gradio_client=={CLIENT_VERSION}; found {module.__version__}")
    return module.Client, module.handle_file


def remember_remote(record, client, job=None):
    record["session_hash"] = getattr(client, "session_hash", None)
    communicator = getattr(job, "communicator", None)
    event_id = getattr(communicator, "event_id", None)
    if event_id:
        record["event_id"] = event_id


def verified_app_url(record=None):
    record = record or {}
    replica, app_url = record.get("observed_replica"), record.get("app_url")
    if replica is None and app_url in (None, APP_URL):
        return APP_URL
    if (not isinstance(replica, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,127}", replica)
        or app_url != APP_URL + "/--replicas/" + replica):
        raise ValueError("The saved Wan replica route is invalid")
    return app_url


def create_pinned_client(Client, record, receipt, *, httpx_module=None):
    """Observe one service replica and keep every request on that same route."""
    httpx_module = httpx_module or importlib.import_module("httpx")
    initial = httpx_module.get(APP_URL + "/config", timeout=20, verify=True, follow_redirects=False)
    if initial.status_code != 200:
        raise RuntimeError("Wan replica discovery did not return a successful configuration")
    config = initial.json()
    replica = initial.headers.get("x-proxied-replica")
    if (config.get("space_id") != SPACE or config.get("version") != "6.1.0"
        or not isinstance(replica, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,127}", replica)):
        raise RuntimeError("Wan did not provide a verifiable current replica; no task submitted")
    app_url = APP_URL + "/--replicas/" + replica
    record.update(observed_replica=replica, app_url=app_url, route_observed_at=timestamp())
    save_receipt(receipt, record)
    pinned = httpx_module.get(app_url + "/config", timeout=20, verify=True, follow_redirects=False)
    if pinned.status_code != 200 or pinned.headers.get("x-proxied-replica") != replica:
        raise RuntimeError("The observed Wan replica could not be verified; no alternate replica or task was tried")
    verified = pinned.json()
    if (verified.get("space_id") != SPACE or verified.get("version") != "6.1.0"
        or verified.get("protocol") != "sse_v3"):
        raise RuntimeError("The observed Wan replica has changed configuration; no task submitted")
    record["route_verified_at"] = timestamp()
    save_receipt(receipt, record)
    # A fixed observed replica also avoids a separate Hub name-resolution GET.
    # Anonymous identity, configured proxy and certificate verification remain.
    return Client(app_url, token=False, analytics_enabled=False, download_files=False)


def video_url(result, record=None):
    app_url = verified_app_url(record)
    video = result[0] if isinstance(result, (tuple, list)) else result
    if hasattr(video, "model_dump"):
        video = video.model_dump()
    if dataclasses.is_dataclass(video):
        video = dataclasses.asdict(video)
    if isinstance(video, dict) and "video" in video:
        video = video["video"]
    if isinstance(video, dict):
        url = video.get("url")
        if not url and video.get("path"):
            url = app_url + "/gradio_api/file=" + quote(str(video["path"]), safe="/")
    else:
        url = video
    if not isinstance(url, str):
        raise ValueError("Server did not return a video URL; inspect result in request.json")
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.netloc != urlparse(APP_URL).netloc or parsed.query or parsed.fragment:
        raise ValueError("Unexpected download origin; inspect the saved server result manually")
    prefixes = {APP_URL + "/gradio_api/file=", app_url + "/gradio_api/file="}
    prefix = next((value for value in prefixes if url.startswith(value)), None)
    path = url[len(prefix):] if prefix else ""
    if not re.fullmatch(r"/tmp/gradio/[a-f0-9]{64}/[A-Za-z0-9_.-]+\.mp4", path) or ".." in path:
        raise ValueError("Unexpected returned Wan file or replica route")
    if isinstance(video, dict) and video.get("path") != path:
        raise ValueError("Returned Wan URL does not match its original file path")
    # Preserve result.FileData exactly as returned, but route its download to
    # the observed replica as well. The canonical URL may otherwise hit another.
    return app_url + "/gradio_api/file=" + path


def install_result_reader(client, record, receipt, *, httpx_module=None, delay_seconds=RESULT_READ_DELAY_SECONDS):
    """Delay the first GET on the verified queue implementation, never its POST.

    Gradio 6.1.0 starts queued non-streaming functions without a result reader and
    retains their messages in a bounded session cache. Opening SSE too early can
    lose that queue when a proxy disconnect makes the server clean the event.
    This reduces exposure to a long connection; it cannot guarantee retention.
    """
    config = getattr(client, "config", {})
    app_url = verified_app_url(record)
    endpoints = [entry for entry in config.get("dependencies", []) if entry.get("api_name") == "generate_video"]
    if (config.get("space_id") != SPACE or config.get("version") != "6.1.0" or config.get("protocol") != "sse_v3"
        or config.get("connect_heartbeat") is not False
        or len(endpoints) != 1 or endpoints[0].get("queue") is not True
        or endpoints[0].get("types", {}).get("generator") is not False
        or endpoints[0].get("connection") != "sse"
        or getattr(client, "sse_url", None) != app_url + "/gradio_api/queue/data"
        or getattr(client, "ssl_verify", True) is not True):
        raise RuntimeError("Wan result-reader strategy requires the verified Gradio 6.1.0/sse_v3 service; inspect changed service configuration before submission")
    journal_path = receipt.parent / "result-stream.json"
    record["result_stream_receipt"] = str(journal_path)
    save_receipt(receipt, record)
    stop = getattr(client, "_kill_heartbeat", None)
    if stop is None:
        raise RuntimeError("Verified Gradio client is missing its close signal")
    httpx_module = httpx_module or importlib.import_module("httpx")
    delay_seconds = max(0, min(RESULT_READ_DELAY_SECONDS, delay_seconds))
    journal = {"version": 1, "strategy": "deferred-original-event-get", "method": "GET", "remote_resubmitted": False,
        "session_hash": client.session_hash, "server_version": config["version"], "protocol": config["protocol"],
        "app_url": app_url, "observed_replica": record.get("observed_replica"),
        "delay_seconds": delay_seconds, "status": "prepared", "observations": []}
    save_receipt(journal_path, journal)

    def stream_messages(self, protocol, session_hash):
        try:
            with self.pending_lock:
                event_ids = list(self.pending_event_ids)
            if protocol != "sse_v3" or session_hash != journal["session_hash"] or len(event_ids) != 1:
                raise ValueError("Original result-reader event/session identity changed")
            event_id = event_ids[0]
            if not isinstance(event_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", event_id):
                raise ValueError("Invalid original result event identifier")
            journal.update(event_id=event_id, status="deferred", started_at=timestamp())
            save_receipt(journal_path, journal)
            if stop.wait(delay_seconds):
                raise concurrent.futures.CancelledError("Local client closed before reading the original event")
            journal.update(status="reading", first_get_at=timestamp())
            save_receipt(journal_path, journal)
            options = dict(self.httpx_kwargs or {})
            options.pop("timeout", None)
            options.pop("follow_redirects", None)
            options.pop("verify", None)
            # No new Gradio client, session or job. The same configured route,
            # cookies and credentials are kept entirely inside this client.
            with httpx_module.Client(verify=True, follow_redirects=False,
                timeout=httpx_module.Timeout(90, connect=30), **options) as transport:
                headers = {**self.headers, "Accept": "text/event-stream", "Accept-Encoding": "identity"}
                with transport.stream("GET", self.sse_url, params={"session_hash": session_hash},
                    headers=headers, cookies=self.cookies) as response:
                    journal.update(http_status=response.status_code,
                        content_type=response.headers.get("content-type", ""),
                        replica=response.headers.get("x-proxied-replica", "")[:100])
                    save_receipt(journal_path, journal)
                    if response.status_code != 200 or not journal["content_type"].lower().startswith("text/event-stream"):
                        raise ValueError("Original event reader returned a non-success or non-SSE response")
                    if record.get("observed_replica") and journal["replica"] != record["observed_replica"]:
                        raise ValueError("Original event reader was not served by the verified replica")
                    data_lines, total_bytes = [], 0
                    for line in response.iter_lines():
                        if stop.is_set():
                            raise concurrent.futures.CancelledError("Local client closed while reading the original event")
                        total_bytes += len(line.encode("utf-8"))
                        if total_bytes > 4 * 1024 * 1024 or len(line) > 65536:
                            raise ValueError("Original result stream exceeded its read limit")
                        if line.startswith("data:"):
                            data_lines.append(line[5:].lstrip())
                            if sum(map(len, data_lines)) > 65536:
                                raise ValueError("Original result message exceeded its read limit")
                            continue
                        if line or not data_lines:
                            continue
                        message = json.loads("\n".join(data_lines))
                        data_lines.clear()
                        if not isinstance(message, dict):
                            raise ValueError("Original result stream message was not an object")
                        kind, matches = message.get("msg"), message.get("event_id") == event_id
                        journal["observations"] = (journal["observations"] + [{"at": timestamp(), "message": str(kind)[:100],
                            "matches_event": matches}])[-50:]
                        if kind in ("unexpected_error", "server_stopped"):
                            journal.update(status="remote_error", remote_error=message)
                            save_receipt(journal_path, journal)
                            raise RuntimeError(str(message.get("message") or kind)[:500])
                        if kind == "heartbeat":
                            save_receipt(journal_path, journal)
                            continue
                        if kind == "close_stream":
                            journal["status"] = "closed_without_completion"
                            save_receipt(journal_path, journal)
                            return
                        if not matches:
                            save_receipt(journal_path, journal)
                            continue
                        if kind == "process_completed":
                            journal.update(status="completed_message", completion=message)
                        # Commit the raw terminal message before the worker can
                        # consume it or any download begins.
                        save_receipt(journal_path, journal)
                        with self.pending_lock:
                            self.pending_messages_per_event.setdefault(event_id, deque()).append(message)
                            if kind == "process_completed":
                                self.pending_event_ids.discard(event_id)
                        if kind == "process_completed":
                            return
                    journal["status"] = "ended_without_completion"
                    save_receipt(journal_path, journal)
        except BaseException as error:
            journal.update(status="interrupted", error_type=type(error).__name__,
                error=(str(error) or type(error).__name__)[:500], finished_at=timestamp())
            save_receipt(journal_path, journal)
            raise

    client.stream_messages = types.MethodType(stream_messages, client)


def persisted_stream_result(record, receipt):
    """A received, durable successful terminal message survives reader teardown."""
    try:
        journal = json.loads((receipt.parent / "result-stream.json").read_text(encoding="utf-8"))
        completion = journal.get("completion", {})
        if (journal.get("session_hash") != record.get("session_hash") or not record.get("event_id")
            or journal.get("event_id") != record["event_id"] or completion.get("event_id") != record["event_id"]
            or completion.get("msg") != "process_completed" or completion.get("success") is not True):
            return None
        result = completion["output"]["data"]
        if not isinstance(result, list) or not result:
            return None
        video_url(result, record)
        return result
    except (OSError, ValueError, TypeError, KeyError, IndexError):
        return None


def recover_cancelled_result(record, client, job, receipt, *, httpx_module=None, timeout_seconds=GET_RECOVERY_SECONDS):
    """Read the original event only; never create a Gradio client or resubmit."""
    session = record.get("session_hash")
    event_id = record.get("event_id")
    url = getattr(client, "sse_url", "")
    helper = getattr(job, "communicator", None)
    app_url = verified_app_url(record)
    recovery = {"method": "GET", "started_at": timestamp(), "status": "checking", "attempts": [], "remote_resubmitted": False}
    record["get_recovery"] = recovery
    save_receipt(receipt, record)
    if (not isinstance(session, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", session)
        or not isinstance(event_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", event_id)
        or getattr(client, "session_hash", None) != session or getattr(helper, "event_id", None) != event_id
        or getattr(helper, "should_cancel", False)
        or url not in (app_url + "/gradio_api/queue/data", app_url + "/queue/data")
        or getattr(client, "ssl_verify", True) is not True):
        recovery.update(status="unavailable", reason="Original event/session or fixed HTTPS event stream could not be verified")
        save_receipt(receipt, record)
        return None
    streaming = getattr(client, "streaming_future", None)
    if streaming is not None and not streaming.done():
        recovery.update(status="unavailable", reason="The original event reader is still active")
        save_receipt(receipt, record)
        return None
    httpx_module = httpx_module or importlib.import_module("httpx")
    recovery.update(status="reading", url=url, event_id=event_id)
    save_receipt(receipt, record)

    async def read_original():
        # A transport is needed for the read, but the existing Gradio client,
        # heartbeat, session and event remain unchanged. No prediction endpoint.
        options = dict(getattr(client, "httpx_kwargs", {}) or {})
        options.pop("timeout", None)
        options.pop("follow_redirects", None)
        options.pop("verify", None)
        async with httpx_module.AsyncClient(verify=True, follow_redirects=False, timeout=15, **options) as transport:
            for index in range(GET_RECOVERY_ATTEMPTS):
                attempt = {"number": index + 1, "method": "GET", "started_at": timestamp(), "status": "connecting", "observations": []}
                recovery["attempts"].append(attempt)
                save_receipt(receipt, record)
                try:
                    async with transport.stream("GET", url, params={"session_hash": session},
                        headers=getattr(client, "headers", {}), cookies=getattr(client, "cookies", None)) as response:
                        attempt["http_status"] = response.status_code
                        if response.status_code != 200 or not response.headers.get("content-type", "").lower().startswith("text/event-stream"):
                            raise ValueError("Original event stream returned a non-SSE or non-success response")
                        if record.get("observed_replica") and response.headers.get("x-proxied-replica") != record["observed_replica"]:
                            raise ValueError("Original event recovery did not reach the verified replica")
                        attempt["status"] = "reading"
                        save_receipt(receipt, record)
                        data_lines = []
                        total_bytes = 0
                        async for line in response.aiter_lines():
                            total_bytes += len(line.encode("utf-8"))
                            if total_bytes > 1024 * 1024 or len(line) > 65536:
                                raise ValueError("Original event stream exceeded the read limit")
                            if line.startswith("data:"):
                                data_lines.append(line[5:].lstrip())
                                if sum(map(len, data_lines)) > 65536:
                                    raise ValueError("Original event message exceeded the read limit")
                                continue
                            if line or not data_lines:
                                continue
                            message = json.loads("\n".join(data_lines))
                            data_lines.clear()
                            if not isinstance(message, dict):
                                raise ValueError("Original event stream message was not an object")
                            matches = message.get("event_id") == event_id
                            observation = {"at": timestamp(), "message": str(message.get("msg", ""))[:100], "matches_event": matches,
                                "success": message.get("success") if isinstance(message.get("success"), bool) else None}
                            attempt["observations"] = (attempt["observations"] + [observation])[-50:]
                            # Persist the terminal observation before accepting its FileData.
                            if message.get("msg") in ("unexpected_error", "server_stopped"):
                                attempt.update(status="unresolved", error=str(message.get("message") or message.get("error") or message["msg"])[:500])
                                recovery["status"] = "unresolved"
                                save_receipt(receipt, record)
                                return None
                            if matches and message.get("msg") == "process_completed":
                                attempt["completion"] = message
                                save_receipt(receipt, record)
                                output = message.get("output")
                                result = output.get("data") if isinstance(output, dict) else None
                                if message.get("success") is not True or not isinstance(result, list) or not result:
                                    attempt["status"] = recovery["status"] = "unresolved"
                                    save_receipt(receipt, record)
                                    return None
                                try:
                                    video_url(result, record)
                                except (ValueError, TypeError, IndexError) as error:
                                    attempt.update(status="unresolved", error=str(error)[:500])
                                    recovery["status"] = "unresolved"
                                    save_receipt(receipt, record)
                                    return None
                                attempt["status"] = recovery["status"] = "recovered"
                                save_receipt(receipt, record)
                                return result
                            save_receipt(receipt, record)
                        attempt["status"] = "ended_without_result"
                except Exception as error:
                    attempt.update(status="read_failed", error_type=type(error).__name__, error=(str(error) or type(error).__name__)[:500])
                save_receipt(receipt, record)
        return None

    try:
        result = asyncio.run(asyncio.wait_for(read_original(), timeout=min(GET_RECOVERY_SECONDS, max(0.01, timeout_seconds))))
    except Exception as error:
        recovery.update(status="unresolved", error_type=type(error).__name__, error=(str(error) or "Original event GET recovery timed out")[:500])
        result = None
    recovery.update(status="recovered" if result is not None else "unresolved", finished_at=timestamp())
    save_receipt(receipt, record)
    return result


def generate(record, Client, handle_file):
    output = Path(record["out_dir"])
    output.parent.mkdir(parents=True, exist_ok=True)
    # mkdir is the persistent lock. Even an empty directory after a crash blocks resubmission.
    output.mkdir(exist_ok=False)
    receipt = output / "request.json"
    record.update(status="preparing", created_at=timestamp(), video_produced=False)
    save_receipt(receipt, record)
    submission_started = False
    client = job = None
    try:
        source = Path(record["input_image"])
        snapshot = output / ("input" + source.suffix.lower())
        shutil.copyfile(source, snapshot)
        record["input_snapshot"] = str(snapshot)
        record["input_sha256"] = hashlib.sha256(snapshot.read_bytes()).hexdigest()
        save_receipt(receipt, record)
        # Keep server FileData first, so a failed download cannot lose the result URL.
        client = create_pinned_client(Client, record, receipt)
        api = client.view_api(return_format="dict", print_info=False)
        if "/generate_video" not in api.get("named_endpoints", {}):
            raise RuntimeError("The public Space no longer exposes /generate_video")
        install_result_reader(client, record, receipt)
        remember_remote(record, client)
        record["status"] = "submitting"
        save_receipt(receipt, record)
        submission_started = True
        job = client.submit(
            input_image=handle_file(str(snapshot)),
            api_name="/generate_video",
            **record["parameters"],
        )
        record["status"] = "submitted"
        remember_remote(record, client, job)
        save_receipt(receipt, record)
        started = time.monotonic()
        while not job.done():
            remember_remote(record, client, job)
            status = job.status()
            record.update(status="running", remote_status=status)
            save_receipt(receipt, record)
            elapsed = round(time.monotonic() - started)
            print(json.dumps({"status": str(status), "elapsed_seconds": elapsed}), flush=True)
            if elapsed >= WAIT_SECONDS:
                raise TimeoutError("Stopped waiting after 720 seconds; remote work may still be running")
            time.sleep(5)
        try:
            result = job.result()
        except concurrent.futures.CancelledError:
            remember_remote(record, client, job)
            result = persisted_stream_result(record, receipt)
            if result is None:
                result = recover_cancelled_result(record, client, job, receipt)
            if result is None:
                raise
        remember_remote(record, client, job)
        record.update(status="downloading", result=result)
        save_receipt(receipt, record)
        url = video_url(result, record)
        part = output / "video.mp4.part"
        destination = output / "video.mp4"
        record.update(download_url=url, partial_file=str(part), output_file=str(destination))
        save_receipt(receipt, record)
        with urlopen(url, timeout=60) as response, part.open("xb") as stream:
            shutil.copyfileobj(response, stream)
        with part.open("rb") as stream:
            header = stream.read(12)
        if len(header) < 12 or header[4:8] != b"ftyp":
            raise ValueError("Downloaded file does not have an MP4 header")
        if destination.exists():
            raise FileExistsError(f"Refusing to overwrite {destination}")
        part.rename(destination)
        record.update(status="completed", video_produced=True, bytes=destination.stat().st_size)
        save_receipt(receipt, record)
        print(json.dumps({"status": "completed", "file": str(destination)}, ensure_ascii=False), flush=True)
        return 0
    except (Exception, KeyboardInterrupt) as error:
        if client is not None:
            remember_remote(record, client, job)
        record.update(
            status="unknown" if submission_started else "failed_before_submit",
            error_type=type(error).__name__,
            error=str(error) or ("Interrupted by user" if isinstance(error, KeyboardInterrupt)
                else "Client result wait was cancelled; cause not confirmed and remote outcome is unknown" if isinstance(error, concurrent.futures.CancelledError)
                else f"{type(error).__name__} without an error message"),
        )
        try:
            save_receipt(receipt, record)
        except OSError as save_error:
            print(f"Receipt update failed: {save_error}. The existing job directory still blocks reuse.", file=sys.stderr)
        print(json.dumps(record, ensure_ascii=False, default=json_value), file=sys.stderr, flush=True)
        return 2 if submission_started else 1
    finally:
        if client is not None:
            try:
                client.close()
            except Exception as close_error:
                print(f"Could not close the local client: {close_error}", file=sys.stderr)


def main(argv=None):
    arguments = parser().parse_args(argv)
    try:
        record = validated_request(arguments)
        if arguments.dry_run:
            print(json.dumps({"status": "validated_offline", **record}, ensure_ascii=False, indent=2))
            return 0
        Client, handle_file = load_client(arguments.deps_dir)
        return generate(record, Client, handle_file)
    except (OSError, ValueError, RuntimeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    code = main()
    if code == 2:
        # Gradio worker threads can still be waiting. Stop only this local CLI after
        # persisting unknown; do not cancel or resubmit the potentially active remote job.
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(code)
    raise SystemExit(code)
