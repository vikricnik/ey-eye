"""Log output: human-readable lines by default, or with LOG_FORMAT=json one
JSON object per line — what log search tools ingest."""

import json
import logging
import os
import subprocess
import sys

from llm_pipeline.logging_context import JsonLogFormatter


def test_a_json_log_line_carries_the_request_id_and_any_traceback() -> None:
    try:
        raise ValueError("boom")
    except ValueError:
        record = logging.getLogger("llm_pipeline").makeRecord(
            "llm_pipeline",
            logging.ERROR,
            __file__,
            1,
            "run %s failed — %s",
            ("r1", "é"),
            sys.exc_info(),
        )
    record.request_id = "abc123"  # set by RequestIdLogFilter on the handler
    entry = json.loads(JsonLogFormatter().format(record))
    assert entry["level"] == "ERROR"
    assert entry["logger"] == "llm_pipeline"
    assert entry["request_id"] == "abc123"
    assert entry["message"] == "run r1 failed — é"
    assert "ValueError: boom" in entry["exception"]
    assert entry["time"].endswith("+00:00")


def test_with_log_format_json_every_line_is_json_uvicorns_included() -> None:
    """uvicorn gives its own loggers text handlers before it loads the app;
    left alone, its startup and access lines would break a JSON log stream.
    A fresh interpreter does what uvicorn does, then imports the app."""
    probe = (
        "import logging, logging.config, uvicorn.config\n"
        "logging.config.dictConfig(uvicorn.config.LOGGING_CONFIG)\n"
        "import warnings\n"
        "import llm_pipeline.main\n"
        "logging.getLogger('llm_pipeline').info('pipeline says hi')\n"
        "warnings.warn('careful')\n"
        "logging.getLogger('uvicorn.error').info('Started server process [1]')\n"
        "logging.getLogger('uvicorn.access').info(\n"
        "    '%s - \"%s %s HTTP/%s\" %d', '127.0.0.1:5', 'GET', '/health', '1.1', 200\n"
        ")\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", probe],
        capture_output=True,
        text=True,
        check=True,
        env={**os.environ, "LOG_FORMAT": "json", "VALIDATE_PIPELINES_ON_STARTUP": "false"},
    )
    assert result.stdout == ""  # uvicorn's access handler writes to stdout
    # Every line — including any warning a library printed while loading.
    entries = [json.loads(line) for line in result.stderr.splitlines()]
    assert any(
        e["logger"] == "py.warnings" and "UserWarning: careful" in e["message"] for e in entries
    )
    assert [(e["logger"], e["message"]) for e in entries if e["logger"] != "py.warnings"] == [
        ("llm_pipeline", "pipeline says hi"),
        ("uvicorn.error", "Started server process [1]"),
        ("uvicorn.access", '127.0.0.1:5 - "GET /health HTTP/1.1" 200'),
    ]
