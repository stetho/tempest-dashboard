"""
app.py — Flask dashboard for the Tempest weather station.
"""
import os
import glob
import datetime
from flask import Flask, render_template, jsonify, send_file
from pathlib import Path
from db import (
    get_latest_observation,
    get_observations_last_24h,
    get_daily_totals,
    get_pressure_last_3h,
)
from analytics.pressure import pressure_change_rate, zambretti_forecast
from analytics.wind import beaufort_scale, gust_factor, wind_direction_compass
from analytics.solar import clear_sky_index, uv_dose_accumulator
from analytics.temperature import absolute_humidity, frost_risk, thermal_comfort
from analytics.rain import rain_intensity, spell_tracker, antecedent_rainfall_index
from analytics.lightning import lightning_safety
from analytics.records import get_all_time_records, get_daily_records, get_station_info

from db import (
    get_latest_observation,
    get_observations_last_24h,
    get_daily_totals,
    get_pressure_last_3h,
    DB_PATH,
)

app = Flask(__name__)

LATITUDE = 51.38909
LONGITUDE = -0.08738
STATION_NAME = "Selhurst"
CAMERA_PATH = os.getenv("CAMERA_PATH", "/camera/latest.jpg")
TIMELAPSE_DIR = Path(os.getenv("CAMERA_PATH", "/camera/latest.jpg")).parent / "timelapse"

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
        safety = {
            "risk_level": "Very Low",
            "safe_to_be_outside": True,
            "description": "No recent lightning detected",
            "advice": "No lightning activity detected in the last observation.",
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
            "today_total": obs["precip_accum_local_day"],
            "yesterday_total": obs["precip_accum_local_yesterday"],
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
