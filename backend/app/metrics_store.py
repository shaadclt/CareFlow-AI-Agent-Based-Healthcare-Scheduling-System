
"""Persistent SQLite metrics store for CareFlow AI."""
from __future__ import annotations

import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _db_path() -> Path:
    configured = os.getenv("OBSERVABILITY_DB_PATH")
    if configured:
        path = Path(configured)
    else:
        path = (
            Path(__file__).resolve().parent.parent
            / "data"
            / "observability.db"
        )

    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _connect() -> sqlite3.Connection:
    connection = sqlite3.connect(str(_db_path()), timeout=10)
    connection.row_factory = sqlite3.Row
    return connection


def init_metrics_db() -> None:
    with _connect() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS http_metrics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL DEFAULT
                    (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                method TEXT NOT NULL,
                path TEXT NOT NULL,
                status_code INTEGER NOT NULL,
                duration_ms REAL NOT NULL,
                outcome TEXT NOT NULL
            )
        """)

        conn.execute("""
            CREATE TABLE IF NOT EXISTS workflow_metrics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL DEFAULT
                    (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                workflow_status TEXT NOT NULL,
                outcome TEXT NOT NULL,
                duration_ms REAL NOT NULL,
                trace_node_count INTEGER NOT NULL DEFAULT 0
            )
        """)

        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_http_created
            ON http_metrics(created_at)
        """)

        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_workflow_created
            ON workflow_metrics(created_at)
        """)


def record_http_metric(
    *,
    method: str,
    path: str,
    status_code: int,
    duration_ms: float,
    outcome: str,
) -> None:
    """Record one HTTP request. Does not store query strings or request bodies."""
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO http_metrics
                (method, path, status_code, duration_ms, outcome)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                method,
                path,
                int(status_code),
                float(duration_ms),
                outcome,
            ),
        )


def record_workflow_metric(
    *,
    workflow_status: str,
    outcome: str,
    duration_ms: float,
    trace_node_count: int,
) -> None:
    """Record one scheduling workflow execution."""
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO workflow_metrics
                (workflow_status, outcome, duration_ms, trace_node_count)
            VALUES (?, ?, ?, ?)
            """,
            (
                workflow_status,
                outcome,
                float(duration_ms),
                int(trace_node_count),
            ),
        )


def get_metrics_summary() -> dict[str, Any]:
    """Return aggregate and recent metrics for the admin dashboard."""
    with _connect() as conn:
        http = conn.execute("""
            SELECT
                COUNT(*) AS total_requests,
                SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END)
                    AS failed_requests,
                AVG(duration_ms) AS avg_latency_ms,
                MAX(duration_ms) AS max_latency_ms
            FROM http_metrics
        """).fetchone()

        statuses = conn.execute("""
            SELECT status_code, COUNT(*) AS count
            FROM http_metrics
            GROUP BY status_code
            ORDER BY status_code
        """).fetchall()

        routes = conn.execute("""
            SELECT
                method,
                path,
                COUNT(*) AS requests,
                AVG(duration_ms) AS avg_latency_ms,
                SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END)
                    AS failures
            FROM http_metrics
            GROUP BY method, path
            ORDER BY requests DESC
            LIMIT 20
        """).fetchall()

        workflow = conn.execute("""
            SELECT
                COUNT(*) AS total_workflows,
                SUM(CASE WHEN outcome = 'booking_completed' THEN 1 ELSE 0 END)
                    AS completed,
                SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END)
                    AS failed,
                AVG(duration_ms) AS avg_duration_ms,
                AVG(trace_node_count) AS avg_trace_nodes
            FROM workflow_metrics
        """).fetchone()

        workflow_statuses = conn.execute("""
            SELECT workflow_status, outcome, COUNT(*) AS count
            FROM workflow_metrics
            GROUP BY workflow_status, outcome
            ORDER BY count DESC
        """).fetchall()

        recent_http = conn.execute("""
            SELECT created_at, method, path, status_code,
                   duration_ms, outcome
            FROM http_metrics
            ORDER BY id DESC
            LIMIT 20
        """).fetchall()

        recent_workflows = conn.execute("""
            SELECT created_at, workflow_status, outcome,
                   duration_ms, trace_node_count
            FROM workflow_metrics
            ORDER BY id DESC
            LIMIT 20
        """).fetchall()

    def rows(items):
        return [dict(item) for item in items]

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "http": {
            "total_requests": int(http["total_requests"] or 0),
            "failed_requests": int(http["failed_requests"] or 0),
            "avg_latency_ms": round(
                float(http["avg_latency_ms"] or 0), 2
            ),
            "max_latency_ms": round(
                float(http["max_latency_ms"] or 0), 2
            ),
            "status_breakdown": rows(statuses),
            "routes": rows(routes),
            "recent": rows(recent_http),
        },
        "workflows": {
            "total": int(workflow["total_workflows"] or 0),
            "completed": int(workflow["completed"] or 0),
            "failed": int(workflow["failed"] or 0),
            "avg_duration_ms": round(
                float(workflow["avg_duration_ms"] or 0), 2
            ),
            "avg_trace_nodes": round(
                float(workflow["avg_trace_nodes"] or 0), 2
            ),
            "status_breakdown": rows(workflow_statuses),
            "recent": rows(recent_workflows),
        },
    }
