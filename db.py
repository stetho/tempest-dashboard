"""
db.py — Database query functions for the Tempest dashboard.

All functions return plain dicts or lists of dicts, keeping
database logic completely separate from Flask routes.
"""

import sqlite3
import os
from pathlib import Path

# Path to the logger's database
DB_PATH = Path(os.getenv("DB_PATH", str(Path(__file__).parent.parent / "tempest-logger" / "data" / "tempest.db")))



def get_connection():
    """Return a SQLite connection with row factory set to return dicts."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def get_latest_observation() -> dict | None:
    """Return the most recent observation from the database."""
    with get_connection() as conn:
        row = conn.execute("""
            SELECT * FROM observations
            ORDER BY timestamp DESC
            LIMIT 1
        """).fetchone()
        return dict(row) if row else None


def get_observations_last_24h() -> list[dict]:
    """Return all observations from the last 24 hours, oldest first."""
    with get_connection() as conn:
        rows = conn.execute("""
            SELECT * FROM observations
            WHERE timestamp >= strftime('%s', 'now') - 86400
            ORDER BY timestamp ASC
        """).fetchall()
        return [dict(row) for row in rows]


def get_observations_last_7d() -> list[dict]:
    """Return hourly observations from the last 7 days, oldest first."""
    with get_connection() as conn:
        rows = conn.execute("""
            SELECT * FROM observations
            WHERE timestamp >= strftime('%s', 'now') - 604800
            ORDER BY timestamp ASC
        """).fetchall()
        return [dict(row) for row in rows]


def get_daily_totals(days: int = 30) -> list[dict]:
    """
    Return daily rainfall totals for the last N days.
    Used by the rain module for spell tracking and ARI calculation.
    """
    with get_connection() as conn:
        rows = conn.execute("""
            SELECT
                date(timestamp, 'unixepoch') as date,
                MAX(precip_accum_local_day) as precip_total
            FROM observations
            WHERE timestamp >= strftime('%s', 'now') - :seconds
            GROUP BY date(timestamp, 'unixepoch')
            ORDER BY date ASC
        """, {"seconds": days * 86400}).fetchall()
        return [dict(row) for row in rows]


def get_pressure_last_3h() -> list[dict]:
    """
    Return observations from the last 3 hours for pressure trend calculation.
    """
    with get_connection() as conn:
        rows = conn.execute("""
            SELECT timestamp, sea_level_pressure
            FROM observations
            WHERE timestamp >= strftime('%s', 'now') - 10800
            ORDER BY timestamp ASC
        """).fetchall()
        return [dict(row) for row in rows]
