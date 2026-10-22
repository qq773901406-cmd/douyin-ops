"""Generate one video on the verified public Wan2.2 Space, without login."""

from __future__ import annotations

import argparse
import dataclasses
from datetime import datetime, timezone
import hashlib
import importlib
import json
import math
import os
from pathlib import Path
import shutil
import sys
import time
from urllib.parse import quote, urlparse
from urllib.request import urlopen


SPACE = "zerogpu-aoti/wan2-2-fp8da-aoti-faster"
APP_URL = "https://zerogpu-aoti-wan2-2-fp8da-aoti-faster.hf.space"
CLIENT_VERSION = "2.7.2"
WAIT_SECONDS = 720
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


def video_url(result):
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
            url = APP_URL + "/gradio_api/file=" + quote(str(video["path"]), safe="/")
    else:
        url = video
    if not isinstance(url, str):
        raise ValueError("Server did not return a video URL; inspect result in request.json")
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.netloc != urlparse(APP_URL).netloc:
        raise ValueError("Unexpected download origin; inspect the saved server result manually")
    return url


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
        client = Client(SPACE, token=False, analytics_enabled=False, download_files=False)
        api = client.view_api(return_format="dict", print_info=False)
        if "/generate_video" not in api.get("named_endpoints", {}):
            raise RuntimeError("The public Space no longer exposes /generate_video")
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
        result = job.result()
        remember_remote(record, client, job)
        record.update(status="downloading", result=result)
        save_receipt(receipt, record)
        url = video_url(result)
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
            error=str(error) or "Interrupted by user",
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
