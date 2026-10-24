import sqlite3
from pathlib import Path
from typing import Any

BACKEND_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = BACKEND_DIR / "data"
METRICS_DB = DATA_DIR / "observability.db"


def _connect():
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    connection = sqlite3.connect(
        METRICS_DB,
        timeout=10,
    )
    connection.row_factory = sqlite3.Row
    return connection


def init_metrics_db() -> None:
    """Create the observability database and its tables."""
    with _connect() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS http_metrics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL DEFAULT (
                    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                ),
                method TEXT NOT NULL,
                route TEXT NOT NULL,
                status_code INTEGER NOT NULL,
                duration_ms REAL NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_http_metrics_created
            ON http_metrics(created_at);

            CREATE TABLE IF NOT EXISTS workflow_metrics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL DEFAULT (
                    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                ),
                outcome TEXT NOT NULL,
                workflow_status TEXT NOT NULL,
                duration_ms REAL NOT NULL,
                trace_node_count INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_workflow_metrics_created
            ON workflow_metrics(created_at);
            """
        )


def record_http_metric(
    method: str,
    route: str,
    status_code: int,
    duration_ms: float,
) -> None:
    """Persist one HTTP request measurement."""
    with _connect() as connection:
        connection.execute(
            """
            INSERT INTO http_metrics (
                method,
                route,
                status_code,
                duration_ms
            )
            VALUES (?, ?, ?, ?)
            """,
            (method, route, status_code, duration_ms),
        )


def record_workflow_metric(
    outcome: str,
    workflow_status: str,
    duration_ms: float,
    trace_node_count: int,
) -> None:
    """Persist one scheduling workflow measurement."""
    with _connect() as connection:
        connection.execute(
            """
            INSERT INTO workflow_metrics (
                outcome,
                workflow_status,
                duration_ms,
                trace_node_count
            )
            VALUES (?, ?, ?, ?)
            """,
            (
                outcome,
                workflow_status,
                duration_ms,
                trace_node_count,
            ),
        )


def get_metrics_summary() -> dict[str, Any]:
    """Return aggregated counts and latency statistics."""
    with _connect() as connection:
        http = connection.execute(
            """
            SELECT
                COUNT(*) AS total_requests,
                COALESCE(
                    AVG(duration_ms), 0
                ) AS average_latency_ms,
                COALESCE(
                    MAX(duration_ms), 0
                ) AS max_latency_ms,
                COALESCE(
                    SUM(CASE WHEN status_code >= 400
                        THEN 1 ELSE 0 END), 0
                ) AS error_requests,
                COALESCE(
                    SUM(CASE WHEN status_code >= 500
                        THEN 1 ELSE 0 END), 0
                ) AS server_errors
            FROM http_metrics
            """
        ).fetchone()

        workflows = connection.execute(
            """
            SELECT
                COUNT(*) AS total_workflows,
                COALESCE(
                    AVG(duration_ms), 0
                ) AS average_workflow_latency_ms,
                COALESCE(
                    SUM(CASE WHEN outcome = 'booking_completed'
                        THEN 1 ELSE 0 END), 0
                ) AS completed_bookings,
                COALESCE(
                    SUM(CASE WHEN outcome = 'failure'
                        THEN 1 ELSE 0 END), 0
                ) AS failed_workflows,
                COALESCE(
                    SUM(CASE WHEN outcome = 'incomplete_or_other'
                        THEN 1 ELSE 0 END), 0
                ) AS incomplete_workflows
            FROM workflow_metrics
            """
        ).fetchone()

        recent_requests = connection.execute(
            """
            SELECT
                created_at,
                method,
                route,
                status_code,
                duration_ms
            FROM http_metrics
            ORDER BY id DESC
            LIMIT 15
            """
        ).fetchall()

        recent_workflows = connection.execute(
            """
            SELECT
                created_at,
                outcome,
                workflow_status,
                duration_ms,
                trace_node_count
            FROM workflow_metrics
            ORDER BY id DESC
            LIMIT 10
            """
        ).fetchall()

    return {
        "requests": {
            "total": http["total_requests"],
            "average_latency_ms": round(
                http["average_latency_ms"], 2
            ),
            "max_latency_ms": round(
                http["max_latency_ms"], 2
            ),
            "error_count": http["error_requests"],
            "server_error_count": http["server_errors"],
        },
        "workflows": {
            "total": workflows["total_workflows"],
            "average_latency_ms": round(
                workflows["average_workflow_latency_ms"], 2
            ),
            "completed_bookings": workflows["completed_bookings"],
            "failed": workflows["failed_workflows"],
            "incomplete_or_other": workflows["incomplete_workflows"],
        },
        "recent_requests": [
            dict(row) for row in recent_requests
        ],
        "recent_workflows": [
            dict(row) for row in recent_workflows
        ],
    }