"""
app.py — Flask dashboard for the Tempest  weather station.
"""
import air_db
import os
import glob
import datetime
from flask import Flask, render_template, jsonify, send_file, request
from pathlib import Path
from db import (
    get_latest_observation,
    get_observations_last_24h,
    get_daily_totals,
    get_pressure_last_3h,
    DB_PATH,
    get_connection,
)
from functools import wraps
from analytics.pressure import pressure_change_rate, zambretti_forecast, storm_predictor
from analytics.wind import beaufort_scale, gust_factor, wind_direction_compass
from analytics.solar import clear_sky_index, uv_dose_accumulator
from analytics.temperature import absolute_humidity, frost_risk, thermal_comfort, thermal_stress
from analytics.rain import rain_intensity, spell_tracker, antecedent_rainfall_index
from analytics.lightning import lightning_safety
from analytics.records import get_all_time_records, get_daily_records, get_station_info
from analytics.microclimate import fetch_open_meteo, compare_microclimate
from analytics.evapotranspiration import penman_monteith_et
from analytics.ml import NaiveBayesRainPredictor, build_training_dataframe, predict_from_observation
from analytics.heatwave import heatwave_status



app = Flask(__name__)
air_db.init_db()
LATITUDE = float(os.getenv("STATION_LATITUDE", "51.5"))
LONGITUDE = float(os.getenv("STATION_LONGITUDE", "-0.1"))
STATION_NAME = "Selhurst"
CAMERA_PATH = os.getenv("CAMERA_PATH", "/camera/latest.jpg")
TIMELAPSE_DIR = Path(os.getenv("CAMERA_PATH", "/camera/latest.jpg")).parent / "timelapse"
AIR_INGEST_SECRET = os.getenv("AIR_INGEST_SECRET", "")

def require_air_secret(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        secret = request.headers.get("X-Air-Secret", "")
        if not AIR_INGEST_SECRET or secret != AIR_INGEST_SECRET:
            return jsonify({"error": "Unauthorised"}), 401
        return f(*args, **kwargs)
    return decorated


def get_utc_offset(timestamp: int) -> float:
    """
    Return the UTC offset in hours for Europe/London at the given timestamp.
    BST (UTC+1) runs from the last Sunday in March to the last Sunday in October.
    """
    import datetime
    dt = datetime.datetime.utcfromtimestamp(timestamp)
    
    # Find last Sunday in March
    march = datetime.datetime(dt.year, 3, 31)
    bst_start = march - datetime.timedelta(days=march.weekday() + 1)
    
    # Find last Sunday in October
    october = datetime.datetime(dt.year, 10, 31)
    bst_end = october - datetime.timedelta(days=october.weekday() + 1)
    
    if bst_start <= dt < bst_end:
        return 1.0  # BST
    return 0.0  # GMT

def get_daily_max_temperatures(days: int = 30) -> list[dict]:
    """Return daily max temperatures for completed days, newest first."""
    with get_connection() as conn:
        rows = conn.execute("""
            SELECT
                date(timestamp, 'unixepoch') as day,
                ROUND(MAX(air_temperature), 1) as max_temp
            FROM observations
            WHERE date(timestamp, 'unixepoch') < date('now')
            GROUP BY day
            ORDER BY day DESC
            LIMIT ?
        """, (days,)).fetchall()
        return [dict(row) for row in rows]


def get_todays_max_temperature() -> float | None:
    """Return the highest temperature recorded so far today."""
    with get_connection() as conn:
        row = conn.execute("""
            SELECT ROUND(MAX(air_temperature), 1) as max_temp
            FROM observations
            WHERE date(timestamp, 'unixepoch') = date('now')
        """).fetchone()
        return row["max_temp"] if row else None

def build_current_conditions(obs: dict, pressure_obs: list[dict]) -> dict:
    """
    Combine a raw observation with analytics to produce a full
    current conditions payload.
    """
    now = datetime.datetime.utcfromtimestamp(obs["timestamp"])
    utc_offset = get_utc_offset(obs["timestamp"])

    # Pressure
    pressure_rate = pressure_change_rate(pressure_obs) if len(pressure_obs) >= 2 else 0.0
    zambretti = zambretti_forecast(
        obs["sea_level_pressure"],
        obs["pressure_trend"],
        month=now.month
    )

    # Wind
    beaufort = beaufort_scale(obs["wind_avg"])
    gusts = gust_factor(obs["wind_avg"], obs["wind_gust"])
    compass = wind_direction_compass(obs["wind_direction"])

    # Solar
    csi = clear_sky_index(
        obs["solar_radiation"],
        obs["timestamp"],
        LATITUDE,
        LONGITUDE,
        utc_offset_hours=utc_offset
    )
    if csi["index"] is not None and csi["index"] > 1.0:
        csi["index"] = 1.0
        csi["description"] = "Clear sky"

    # Temperature
    abs_hum = absolute_humidity(obs["air_temperature"], obs["relative_humidity"])
    frost = frost_risk(
        obs["air_temperature"],
        obs["dew_point"],
        obs["wind_avg"],
        hour=now.hour
    )
    comfort = thermal_comfort(
        obs["air_temperature"],
        obs["relative_humidity"],
        obs["wind_avg"],
        obs["solar_radiation"]
    )

    # Rain
    intensity = rain_intensity(obs["precip"])

    # Lightning
    # The Tempest reports a default distance of 10 miles when there are
    # no recent strikes. Treat zero strike count as no activity.

    if obs["lightning_strike_count"] == 0:
        last_epoch = obs.get("lightning_strike_last_epoch")
        if last_epoch:
            hours_ago = (obs["timestamp"] - last_epoch) / 3600
            if hours_ago < 24:
                hours = int(hours_ago)
                mins = int((hours_ago - hours) * 60)
                time_str = f"{hours}h {mins}m ago" if hours > 0 else f"{mins}m ago"
                advice = f"Last strike {obs['lightning_strike_last_distance']} miles away, {time_str}."
            else:
                advice = "No lightning activity in the last 24 hours."
        else:
            advice = "No lightning activity detected."
        safety = {
            "risk_level": "Very Low",
            "safe_to_be_outside": True,
            "description": "No recent lightning",
            "advice": advice,
        }
    else:
        safety = lightning_safety(
            obs["lightning_strike_last_distance"],
            obs["lightning_strike_count"]
        )

    return {
        "station": STATION_NAME,
        "timestamp": obs["timestamp"],
        "recorded_at": obs["recorded_at"],

        "temperature": {
            "air": obs["air_temperature"],
            "feels_like": obs["feels_like"],
            "dew_point": obs["dew_point"],
            "wet_bulb": obs["wet_bulb_temperature"],
            "absolute_humidity": abs_hum["absolute_humidity_g_m3"],
            "humidity_description": abs_hum["description"],
            "comfort_temp": comfort["comfort_temp"],
            "comfort_category": comfort["category"],
        },

        "humidity": {
            "relative": obs["relative_humidity"],
        },

        "pressure": {
            "sea_level": obs["sea_level_pressure"],
            "station": obs["barometric_pressure"],
            "trend": obs["pressure_trend"],
            "change_rate": pressure_rate,
            "zambretti_letter": zambretti["letter"],
            "zambretti_forecast": zambretti["forecast"],
        },

        "wind": {
            "avg": obs["wind_avg"],
            "gust": obs["wind_gust"],
            "lull": obs["wind_lull"],
            "direction_degrees": obs["wind_direction"],
            "direction_compass": compass["compass"],
            "direction_abbr": compass["abbreviation"],
            "beaufort_force": beaufort["force"],
            "beaufort_description": beaufort["description"],
            "gust_factor": gusts["factor"],
            "turbulent": gusts["turbulent"],
        },

        "solar": {
            "radiation": obs["solar_radiation"],
            "uv": obs["uv"],
            "brightness": obs["brightness"],
            "clear_sky_index": csi["index"],
            "sky_description": csi["description"],
        },

        "rain": {
            "current_rate": obs["precip"],
            "intensity": intensity["intensity"],
            "intensity_description": intensity["description"],
            "today_total": round(obs["precip_accum_local_day"], 2),
            "yesterday_total": round(obs["precip_accum_local_yesterday"], 2),
        },

        "lightning": {
            "last_distance": obs["lightning_strike_last_distance"],
            "count": obs["lightning_strike_count"],
            "risk_level": safety["risk_level"],
            "safe_outside": safety["safe_to_be_outside"],
            "advice": safety["advice"],
        },

        "frost": {
            "risk_level": frost["risk_level"],
            "description": frost["description"],
            "factors": frost["factors"],
        },
    }


@app.route("/")
def index():
    return render_template("index.html", station=STATION_NAME)

@app.route("/api/thermal-stress")
def api_thermal_stress():
    obs = get_latest_observation()
    if not obs:
        return jsonify({"error": "No observations found"}), 404
    wbgt = obs.get("wet_bulb_globe_temperature")
    if wbgt is None:
        return jsonify({"error": "WBGT data not available"}), 404
    result = thermal_stress(wbgt)
    return jsonify(result)

@app.route("/api/heatwave")
def api_heatwave():
    threshold = float(os.getenv("HEATWAVE_THRESHOLD", "28.0"))
    daily = get_daily_max_temperatures(days=30)
    todays_max = get_todays_max_temperature()
    result = heatwave_status(daily, todays_max, threshold)
    return jsonify(result)

@app.route("/api/ingest/air", methods=["POST"])
@require_air_secret
def ingest_air():
    """Receive a batch of air quality readings from tempest-air on the Pi."""
    payload = request.get_json(silent=True)
    if not payload or "readings" not in payload:
        return jsonify({"error": "Invalid payload"}), 400

    readings = payload["readings"]
    if not isinstance(readings, list) or not readings:
        return jsonify({"error": "readings must be a non-empty list"}), 400

    inserted = air_db.insert_readings(readings)
    return jsonify({"inserted": inserted, "received": len(readings)}), 200


@app.route("/api/air/current")
def api_air_current():
    """Latest air quality reading with derived AQI/DAQI."""
    latest = air_db.get_latest()
    if not latest:
        return jsonify({"error": "No air quality data available"}), 404
    return jsonify(latest)


@app.route("/api/air/history/24h")
def api_air_history():
    """24 hours of air quality readings."""
    rows = air_db.get_history_24h()
    return jsonify(rows)

@app.route("/api/ha")
def api_ha():
    """
    Home Assistant compatible endpoint.
    Returns all current readings and derived analytics in a single payload.
    """
    try:
        obs = get_latest_observation()
        if not obs:
            return jsonify({"error": "No observations found"}), 404

        pressure_obs = get_pressure_last_3h()
        now = datetime.datetime.utcnow()

        # Use build_current_conditions to get everything already calculated
        conditions = build_current_conditions(obs, pressure_obs)

        # Storm predictor
        storm = storm_predictor(pressure_obs) if len(pressure_obs) >= 2 else None

        # ML rain prediction
        ml_result = None
        try:
            df = build_training_dataframe(DB_PATH)
            if len(df) >= 50:
                model = NaiveBayesRainPredictor(smoothing=1.0)
                model.fit(df)
                with get_connection() as conn:
                    previous = dict(conn.execute("""
                        SELECT * FROM observations
                        WHERE timestamp <= ? - 3600
                        ORDER BY timestamp DESC LIMIT 1
                    """, (obs["timestamp"],)).fetchone())
                ml_result = predict_from_observation(model, obs, previous)
        except Exception:
            pass

        # Microclimate
        microclimate_result = None
        try:
            open_meteo = fetch_open_meteo(LATITUDE, LONGITUDE)
            mc = compare_microclimate(obs, open_meteo)
            microclimate_result = {
                "temp_delta": mc["deltas"]["temperature"],
                "temp_interpretation": mc["interpretation"]["temperature"],
                "wind_delta": mc["deltas"]["wind"],
                "wind_interpretation": mc["interpretation"]["wind"],
            }
        except Exception:
            pass

        timestamp = datetime.datetime.utcfromtimestamp(obs["timestamp"]).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )

        payload = {
            "timestamp": timestamp,
            "station": STATION_NAME,
            "temperature": conditions["temperature"],
            "humidity": conditions["humidity"],
            "pressure": conditions["pressure"],
            "wind": conditions["wind"],
            "solar": conditions["solar"],
            "rain": conditions["rain"],
            "lightning": conditions["lightning"],
            "analytics": {
                "frost_risk": conditions["frost"]["risk_level"],
                "frost_description": conditions["frost"]["description"],
                "storm_predictor": {
                    "probability": storm["probability"],
                    "category": storm["category"],
                    "description": storm["description"],
                    "advice": storm["advice"],
                } if storm else None,
                "ml_rain": {
                    "probability": ml_result["rain_probability"],
                    "explanation": ml_result["explanation"],
                    "trained_on": ml_result["trained_on"],
                } if ml_result else None,
                "microclimate": microclimate_result,
            },
        }

        return jsonify(payload)

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/ml/rain")
def api_ml_rain():
    """Train Naive Bayes model on historical data and predict rain probability."""
    try:
        # Build training data from the database
        df = build_training_dataframe(DB_PATH)
        
        if len(df) < 50:
            return jsonify({"error": "Not enough data to train model"}), 404

        # Train model
        model = NaiveBayesRainPredictor(smoothing=1.0)
        model.fit(df)

        # Get current and 1 hour ago observations
        with get_connection() as conn:
            current = dict(conn.execute("""
                SELECT * FROM observations 
                ORDER BY timestamp DESC LIMIT 1
            """).fetchone())

            previous = dict(conn.execute("""
                SELECT * FROM observations
                WHERE timestamp <= ? - 3600
                ORDER BY timestamp DESC LIMIT 1
            """, (current['timestamp'],)).fetchone())

        result = predict_from_observation(model, current, previous)
        return jsonify(result)

    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/evapotranspiration")
def api_evapotranspiration():
    """Calculate ET₀ for yesterday using a full day of observations."""
    import datetime
    yesterday = datetime.date.today() - datetime.timedelta(days=1)
    
    with get_connection() as conn:
        rows = conn.execute("""
            SELECT 
                timestamp, air_temperature, relative_humidity,
                wind_avg, solar_radiation, sea_level_pressure
            FROM observations
            WHERE date(timestamp, 'unixepoch') = ?
            ORDER BY timestamp ASC
        """, (yesterday.isoformat(),)).fetchall()
        obs = [dict(row) for row in rows]
    
    if not obs:
        return jsonify({"error": "No observations for yesterday"}), 404
    
    result = penman_monteith_et(obs, LATITUDE, yesterday)
    return jsonify(result)

@app.route("/api/microclimate")
def api_microclimate():
    obs = get_latest_observation()
    if not obs:
        return jsonify({"error": "No observations found"}), 404
    try:
        open_meteo = fetch_open_meteo(LATITUDE, LONGITUDE)
        result = compare_microclimate(obs, open_meteo)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/storm")
def api_storm():
    obs = get_pressure_last_3h()
    if len(obs) < 2:
        return jsonify({"error": "Not enough data"}), 404
    result = storm_predictor(obs)
    return jsonify(result)

@app.route("/camera/latest")
def camera_latest():
    path = Path(CAMERA_PATH)
    if not path.exists():
        return jsonify({"error": "No camera image available"}), 404
    return send_file(str(path), mimetype="image/jpeg")

@app.route("/camera/timelapse")
def camera_timelapse_list():
    """Return a list of available timelapse videos."""
    if not TIMELAPSE_DIR.exists():
        return jsonify([])
    videos = sorted([
        f.stem for f in TIMELAPSE_DIR.iterdir()
        if f.suffix == ".mp4"
    ], reverse=True)
    return jsonify(videos)


@app.route("/camera/timelapse/<date>")
def camera_timelapse_video(date: str):
    """Serve a timelapse video by date (YYYYMMDD)."""
    video_path = TIMELAPSE_DIR / f"{date}.mp4"
    if not video_path.exists():
        return jsonify({"error": "Video not found"}), 404
    return send_file(str(video_path), mimetype="video/mp4")

@app.route("/api/records")
def api_records():
    db_path = DB_PATH
    return jsonify({
        "all_time": get_all_time_records(db_path),
        "daily": get_daily_records(db_path),
        "station": get_station_info(db_path),
    })

@app.route("/api/current")
def api_current():
    obs = get_latest_observation()
    if not obs:
        return jsonify({"error": "No observations found"}), 404

    pressure_obs = get_pressure_last_3h()
    conditions = build_current_conditions(obs, pressure_obs)
    return jsonify(conditions)


@app.route("/api/history/24h")
def api_history_24h():
    obs = get_observations_last_24h()
    return jsonify([{
        "timestamp": o["timestamp"],
        "air_temperature": o["air_temperature"],
        "sea_level_pressure": o["sea_level_pressure"],
        "wind_avg": o["wind_avg"],
        "wind_gust": o["wind_gust"],
        "solar_radiation": o["solar_radiation"],
        "uv": o["uv"],
        "precip": o["precip"],
        "relative_humidity": o["relative_humidity"],
    } for o in obs])


@app.route("/api/rain/summary")
def api_rain_summary():
    daily = get_daily_totals(days=30)
    if not daily:
        return jsonify({"error": "No rain data found"}), 404

    spells = spell_tracker(daily)
    ari = antecedent_rainfall_index(daily)

    return jsonify({
        "spell": spells,
        "antecedent_rainfall_index": ari,
        "daily_totals": daily,
    })


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0")
