"""
Air quality database layer for tempest-dashboard.
Stores readings received from tempest-air on the Pi.
"""

import sqlite3
import logging
from pathlib import Path
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

AIR_DB_PATH = Path(
    __import__("os").getenv("AIR_DB_PATH", "/data/tempest-air/air.db")
)


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(AIR_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    AIR_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with get_connection() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS readings (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp     TEXT NOT NULL UNIQUE,
                pm1_0         REAL NOT NULL,
                pm2_5         REAL NOT NULL,
                pm10          REAL NOT NULL,
                p03um         INTEGER NOT NULL,
                p05um         INTEGER NOT NULL,
                p10um         INTEGER NOT NULL,
                p25um         INTEGER NOT NULL,
                p50um         INTEGER NOT NULL,
                p100um        INTEGER NOT NULL,
                aqi_pm25      INTEGER,
                aqi_pm10      INTEGER,
                aqi           INTEGER,
                daqi          INTEGER,
                aqi_category  TEXT
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_air_timestamp
            ON readings (timestamp DESC)
        """)
        conn.commit()
    logger.info("Air quality database initialised at %s", AIR_DB_PATH)


# ---------------------------------------------------------------------------
# AQI calculations
# ---------------------------------------------------------------------------

def _aqi_pm25(pm25: float) -> int:
    """US EPA AQI for PM2.5 (24-hour breakpoints applied to instantaneous)."""
    breakpoints = [
        (0.0,   12.0,   0,   50),
        (12.1,  35.4,   51,  100),
        (35.5,  55.4,   101, 150),
        (55.5,  150.4,  151, 200),
        (150.5, 250.4,  201, 300),
        (250.5, 350.4,  301, 400),
        (350.5, 500.4,  401, 500),
    ]
    for c_lo, c_hi, i_lo, i_hi in breakpoints:
        if c_lo <= pm25 <= c_hi:
            return round((i_hi - i_lo) / (c_hi - c_lo) * (pm25 - c_lo) + i_lo)
    return 500


def _aqi_pm10(pm10: float) -> int:
    """US EPA AQI for PM10."""
    breakpoints = [
        (0,    54,    0,   50),
        (55,   154,   51,  100),
        (155,  254,   101, 150),
        (255,  354,   151, 200),
        (355,  424,   201, 300),
        (425,  504,   301, 400),
        (505,  604,   401, 500),
    ]
    for c_lo, c_hi, i_lo, i_hi in breakpoints:
        if c_lo <= pm10 <= c_hi:
            return round((i_hi - i_lo) / (c_hi - c_lo) * (pm10 - c_lo) + i_lo)
    return 500


def _daqi(pm25: float, pm10: float) -> int:
    """UK DEFRA Daily Air Quality Index (1-10)."""
    # PM2.5 µg/m³ bands
    pm25_bands = [
        (0,   11,  1), (12,  23,  2), (24,  35,  3),
        (36,  41,  4), (42,  47,  5), (48,  53,  6),
        (54,  58,  7), (59,  64,  8), (65,  70,  9),
    ]
    # PM10 µg/m³ bands
    pm10_bands = [
        (0,   16,  1), (17,  33,  2), (34,  50,  3),
        (51,  58,  4), (59,  66,  5), (67,  75,  6),
        (76,  83,  7), (84,  91,  8), (92,  99,  9),
    ]
    daqi_25 = 10
    for lo, hi, idx in pm25_bands:
        if lo <= pm25 <= hi:
            daqi_25 = idx
            break

    daqi_10 = 10
    for lo, hi, idx in pm10_bands:
        if lo <= pm10 <= hi:
            daqi_10 = idx
            break

    return max(daqi_25, daqi_10)


def _aqi_category(aqi: int) -> str:
    if aqi <= 50:   return "Good"
    if aqi <= 100:  return "Moderate"
    if aqi <= 150:  return "Unhealthy for Sensitive Groups"
    if aqi <= 200:  return "Unhealthy"
    if aqi <= 300:  return "Very Unhealthy"
    return "Hazardous"


def derive(reading: dict) -> dict:
    """Add derived AQI/DAQI fields to a reading dict."""
    aqi_25 = _aqi_pm25(reading["pm2_5"])
    aqi_10 = _aqi_pm10(reading["pm10"])
    aqi    = max(aqi_25, aqi_10)
    daqi   = _daqi(reading["pm2_5"], reading["pm10"])
    return {
        **reading,
        "aqi_pm25":     aqi_25,
        "aqi_pm10":     aqi_10,
        "aqi":          aqi,
        "daqi":         daqi,
        "aqi_category": _aqi_category(aqi),
    }


# ---------------------------------------------------------------------------
# Write
# ---------------------------------------------------------------------------

def insert_readings(readings: list[dict]) -> int:
    """Insert a batch of readings. Skips duplicates by timestamp. Returns count inserted."""
    inserted = 0
    with get_connection() as conn:
        for r in readings:
            enriched = derive(r)
            try:
                conn.execute("""
                    INSERT OR IGNORE INTO readings (
                        timestamp,
                        pm1_0, pm2_5, pm10,
                        pm1_0_atmos, pm2_5_atmos, pm10_atmos,
                        p03um, p05um, p10um, p25um, p50um, p100um,
                        aqi_pm25, aqi_pm10, aqi, daqi, aqi_category
                    ) VALUES (
                        :timestamp,
                        :pm1_0, :pm2_5, :pm10,
                        :pm1_0_atmos, :pm2_5_atmos, :pm10_atmos,
                        :p03um, :p05um, :p10um, :p25um, :p50um, :p100um,
                        :aqi_pm25, :aqi_pm10, :aqi, :daqi, :aqi_category
                    )
                """, enriched)
                inserted += conn.execute("SELECT changes()").fetchone()[0]
            except Exception as e:
                logger.warning("Skipping reading %s: %s", r.get("timestamp"), e)
        conn.commit()
    return inserted


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------

def get_latest() -> dict | None:
    with get_connection() as conn:
        row = conn.execute("""
            SELECT * FROM readings ORDER BY timestamp DESC LIMIT 1
        """).fetchone()
        return dict(row) if row else None


def get_history_24h() -> list[dict]:
    with get_connection() as conn:
        rows = conn.execute("""
            SELECT * FROM readings
            WHERE timestamp >= datetime('now', '-24 hours')
            ORDER BY timestamp ASC
        """).fetchall()
        return [dict(r) for r in rows]
