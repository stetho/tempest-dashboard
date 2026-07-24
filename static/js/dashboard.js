// ── Tab switching ──────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(s => s.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    });
});

// –– Fog Warning –––––––––––––––––––––––––––––––––––––––––––––

function populateFog(d) {
    if (!d || d.error) return;
    const card = document.getElementById('fog-card');
    card.className = 'card card--wide';

    const current = d.current;
    const tonight = d.tonight;

    set('cur-fog-current', `Now: ${current.description}`);
    set('cur-fog-tonight', `Tonight: ${tonight.description} (${tonight.probability}% probability)`);
    set('cur-fog-factors', tonight.factors.join(' · '));

    if (current.risk_level === 'High' || tonight.risk_level === 'High') {
        card.classList.add('card--warning');
    }
}

// –– UV Forecast –––––––––––––––––––––––––––––––––––––––––––––

function buildUVForecastChart(data) {
    if (!data || data.error || data.length === 0) return;
    if (charts.uvForecast) { charts.uvForecast.destroy(); delete charts.uvForecast; }

    const labels = data.map(o => o.time.slice(11, 16)); // HH:MM
    const values = data.map(o => o.uv_index);

    charts.uvForecast = new Chart(document.getElementById('chart-uv-forecast'), {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'UV Index Forecast',
                data: values,
                backgroundColor: values.map(v =>
                    v >= 8  ? 'rgba(239,68,68,0.7)'   :
                    v >= 6  ? 'rgba(245,158,11,0.7)'  :
                    v >= 3  ? 'rgba(79,156,249,0.7)'  :
                    'rgba(52,211,153,0.7)'
                ),
                borderColor: values.map(v =>
                    v >= 8  ? '#ef4444' :
                    v >= 6  ? '#f59e0b' :
                    v >= 3  ? '#4f9cf9' :
                    '#34d399'
                ),
                borderWidth: 1,
                borderRadius: 3,
            }]
        },
        options: {
            ...chartDefaults,
            scales: {
                ...chartDefaults.scales,
                y: {
                    ...chartDefaults.scales.y,
                    min: 0,
                    title: { display: true, text: 'UV Index', color: '#64748b' }
                }
            }
        }
    });
}

// –– Wind Rose –––––––––––––––––––––––––––––––––––––––––––––––

function buildWindRose(data) {
    if (!data || !data.buckets) return;

    const svg = document.getElementById('wind-rose-svg');
    if (!svg) return;

    // Clear previous render
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const cx = 200, cy = 200;
    const maxRadius = 160;
    const buckets = data.buckets;
    const maxFreq = Math.max(...buckets.map(b => b.frequency));

    // Speed colour scale — matches dashboard palette
    function speedColour(speed) {
        if (speed >= 15) return '#ef4444';      // danger red
        if (speed >= 8)  return '#f59e0b';      // warning amber
        if (speed >= 4)  return '#4f9cf9';      // accent blue
        return '#34d399';                        // calm green
    }

    // Draw concentric reference rings (25%, 50%, 75%, 100%)
    [0.25, 0.5, 0.75, 1.0].forEach(pct => {
        const r = maxRadius * pct;
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', cx);
        circle.setAttribute('cy', cy);
        circle.setAttribute('r', r);
        circle.setAttribute('fill', 'none');
        circle.setAttribute('stroke', '#2a2d3e');
        circle.setAttribute('stroke-width', '1');
        svg.appendChild(circle);

        // Ring label
        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', cx + 4);
        label.setAttribute('y', cy - r + 12);
        label.setAttribute('fill', '#64748b');
        label.setAttribute('font-size', '9');
        label.textContent = `${Math.round(maxFreq * pct)}%`;
        svg.appendChild(label);
    });

    // Draw cardinal direction lines
    [0, 45, 90, 135].forEach(deg => {
        const rad = (deg - 90) * Math.PI / 180;
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', cx + Math.cos(rad) * maxRadius);
        line.setAttribute('y1', cy + Math.sin(rad) * maxRadius);
        line.setAttribute('x2', cx - Math.cos(rad) * maxRadius);
        line.setAttribute('y2', cy - Math.sin(rad) * maxRadius);
        line.setAttribute('stroke', '#2a2d3e');
        line.setAttribute('stroke-width', '1');
        svg.appendChild(line);
    });

    // Draw wedges
    const angleStep = (2 * Math.PI) / 16;
    buckets.forEach((bucket, i) => {
        if (bucket.count === 0) return;

        const r = maxRadius * (bucket.frequency / maxFreq);
        const startAngle = (i * angleStep) - (Math.PI / 2) - (angleStep / 2);
        const endAngle = startAngle + angleStep;

        const x1 = cx + Math.cos(startAngle) * r;
        const y1 = cy + Math.sin(startAngle) * r;
        const x2 = cx + Math.cos(endAngle) * r;
        const y2 = cy + Math.sin(endAngle) * r;

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const d = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2} Z`;
        path.setAttribute('d', d);
        path.setAttribute('fill', speedColour(bucket.avg_speed));
        path.setAttribute('fill-opacity', '0.7');
        path.setAttribute('stroke', speedColour(bucket.avg_speed));
        path.setAttribute('stroke-width', '0.5');

        // Tooltip
        path.setAttribute('title', `${bucket.direction}: ${bucket.frequency}% · avg ${bucket.avg_speed} mph`);
        svg.appendChild(path);
    });

    // Draw compass labels
    const compassLabels = ['N','NE','E','SE','S','SW','W','NW'];
    const compassAngles = [0, 45, 90, 135, 180, 225, 270, 315];
    const labelRadius = maxRadius + 20;

    compassAngles.forEach((deg, i) => {
        const rad = (deg - 90) * Math.PI / 180;
        const x = cx + Math.cos(rad) * labelRadius;
        const y = cy + Math.sin(rad) * labelRadius;

        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', x);
        label.setAttribute('y', y);
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('dominant-baseline', 'middle');
        label.setAttribute('fill', deg === 0 ? '#e2e8f0' : '#94a3b8');
        label.setAttribute('font-size', deg === 0 ? '13' : '11');
        label.setAttribute('font-weight', deg === 0 ? '600' : '400');
        label.textContent = compassLabels[i];
        svg.appendChild(label);
    });

    // Legend
    const legendItems = [
        { colour: '#34d399', label: '< 4 mph' },
        { colour: '#4f9cf9', label: '4-8 mph' },
        { colour: '#f59e0b', label: '8-15 mph' },
        { colour: '#ef4444', label: '> 15 mph' },
    ];
    legendItems.forEach((item, i) => {
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', 10);
        rect.setAttribute('y', 340 + i * 16);
        rect.setAttribute('width', 10);
        rect.setAttribute('height', 10);
        rect.setAttribute('fill', item.colour);
        rect.setAttribute('fill-opacity', '0.7');
        svg.appendChild(rect);

        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', 24);
        text.setAttribute('y', 349 + i * 16);
        text.setAttribute('fill', '#94a3b8');
        text.setAttribute('font-size', '10');
        text.textContent = item.label;
        svg.appendChild(text);
    });

    // Total observations note
    const note = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    note.setAttribute('x', 390);
    note.setAttribute('y', 390);
    note.setAttribute('text-anchor', 'end');
    note.setAttribute('fill', '#64748b');
    note.setAttribute('font-size', '9');
    note.textContent = `${data.total_observations} observations · 24h`;
    svg.appendChild(note);
}

// –– Comfort ––––––––––––––––––––––––––––––––––––––––––––––––––
function populateComfort(d) {
    if (!d || d.error) return;
    const card = document.getElementById('comfort-card');
    set('cur-comfort-score', `${d.label} · ${d.score}/10`);
    set('cur-comfort-desc', d.description);
    set('cur-comfort-factors', d.factors.join(' · '));
    card.className = 'card card--wide';
    if (d.score < 3.0) {
        card.classList.add('card--danger');
    } else if (d.score < 4.5) {
        card.classList.add('card--warning');
    }
}

// –– Solar Energy ––––––––––––––––––––––––––––––––––––––––––––––

function populateSolarEnergy(d) {
    if (!d || d.error) return;
    set('sol-energy-kwh', `${d.kwh_m2_today} kWh/m² · ${d.description}`);
    set('sol-energy-peak', `Peak: ${d.peak_w_m2} W/m²`);
    set('sol-energy-context', d.context);
}

// –– Pollen ––––––––––––––––––––––––––––––––––––––––––––––––––––
function populatePollen(d) {
    if (!d || d.error) return;
    const card = document.getElementById('pollen-card');
    card.className = 'card card--wide';

    // Headline
    set('cur-pollen', `${d.overall_category} pollen risk`);

    // Build detail line from in-season pollens only
    const details = [];
    if (d.grass.in_season)  details.push(`Grass: ${d.grass.category} (${d.grass.current} g/m³)`);
    if (d.birch.in_season)  details.push(`Birch: ${d.birch.category} (${d.birch.current} g/m³)`);
    if (d.alder.in_season)  details.push(`Alder: ${d.alder.category} (${d.alder.current} g/m³)`);
    set('cur-pollen-detail', details.length ? details.join(' · ') : 'No pollen season active');

    // Colour card by risk
    if (d.overall_risk === 'very-high' || d.overall_risk === 'high') {
        card.classList.add('card--danger');
    } else if (d.overall_risk === 'moderate') {
        card.classList.add('card--warning');
    }
}

// –– UV Exposure –––––––––––––––––––––––––––––––––––––––––––––––
function populateUVExposure(d) {
    if (!d || d.error) return;
    set('sol-uv-dose', `${d.sed_today} SED accumulated · Peak UV: ${d.peak_uv}`);
    set('sol-uv-peak', `Current UV index: ${d.current_uv}`);
    d.skin_types.forEach(skin => {
        const k = skin.key;
        set(`sol-uv-pct-${k}`, `${skin.percent_used}%`);
        set(`sol-uv-burn-${k}`,
            skin.minutes_to_burn !== null ? `${skin.minutes_to_burn} min` : 'No burn risk'
        );
        const statusEl = document.getElementById(`sol-uv-status-${k}`);
        if (statusEl) {
            statusEl.textContent = skin.status;
            statusEl.style.color =
                skin.risk === 'danger'   ? 'var(--danger)'  :
                skin.risk === 'warning'  ? 'var(--warning)' :
                skin.risk === 'moderate' ? 'var(--warning)' :
                'var(--success)';
        }
    });
}

function populateThermalStress(d) {
    if (!d || d.error) return;
    const card = document.getElementById('thermal-stress-card');
    set('cur-thermal-stress', `${d.category} · WBGT ${d.wbgt}°C`);
    set('cur-thermal-stress-advice', d.advice);
    card.className = 'card card--wide';
    if (d.risk_level === 'Extreme') {
        card.classList.add('card--danger');
    } else if (d.risk_level === 'Very High' || d.risk_level === 'High') {
        card.classList.add('card--warning');
    }
}

// –– Polution Dispersal ––––––––––––––––––––––––––––––––––––––––

function populateDispersion(d) {
    if (!d || d.error) return;
    const card = document.getElementById('dispersion-card');
    set('air-dispersion', `${d.rating} · Score ${d.score}/10`);
    set('air-dispersion-desc', d.description);
    set('air-dispersion-factors', d.factors.join(' · '));
    card.className = 'card card--wide';
    if (d.rating === 'Very Poor' || d.rating === 'Poor') {
        card.classList.add('card--warning');
    }
}

// –– Heatwave ––––––––––––––––––––––––––––––––––––––––––––––––––

function populateHeatwave(d) {
    if (!d || d.error) return;
    const card = document.getElementById('heatwave-card');
    if (d.status === 'none') {
        set('cur-heatwave', 'No heatwave');
        set('cur-heatwave-advice', d.todays_max !== null ? `Today's high so far: ${d.todays_max}°C` : '—');
        card.className = 'card card--wide';
    } else if (d.status === 'monitoring') {
        set('cur-heatwave', d.description);
        set('cur-heatwave-advice', d.todays_max !== null ? `Today's high so far: ${d.todays_max}°C · ${d.advice}` : d.advice);
        card.className = 'card card--wide card--warning';
    } else {
        set('cur-heatwave', d.description);
        set('cur-heatwave-advice', d.todays_max !== null ? `Today's high so far: ${d.todays_max}°C · ${d.advice}` : d.advice);
        card.className = 'card card--wide card--danger';
    }
}

// ── Air quality ───────────────────────────────────────────────
function daqiLabel(daqi) {
    if (daqi <= 3)  return 'Low';
    if (daqi <= 6)  return 'Moderate';
    if (daqi <= 9)  return 'High';
    return 'Very High';
}

function populateAir(d) {
    if (!d || d.error) return;
    set('air-aqi', d.aqi);
    set('air-aqi-category', d.aqi_category);
    set('air-daqi', d.daqi);
    set('air-daqi-desc', daqiLabel(d.daqi));
    set('air-pm25', d.pm2_5.toFixed(1));
    set('air-pm10', d.pm10.toFixed(1));
    set('air-pm1', d.pm1_0.toFixed(1));
    const ts = new Date(d.timestamp);
    set('air-timestamp', ts.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
    const aqiCard = document.getElementById('air-aqi-card');
    if (aqiCard) {
        aqiCard.className = 'card card--large' + (d.aqi > 100 ? ' card--danger' : '');
    }
}

function buildAirCharts(history) {
    if (!history || history.length === 0) return;
    const labels = history.map(o =>
        new Date(o.timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    );
    ['airPm', 'airParticles'].forEach(k => {
        if (charts[k]) { charts[k].destroy(); delete charts[k]; }
    });
    charts.airPm = new Chart(document.getElementById('chart-air-pm'), {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: 'PM2.5 (µg/m³)', data: history.map(o => o.pm2_5), borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.1)', fill: true, tension: 0.4, pointRadius: 0 },
                { label: 'PM10 (µg/m³)', data: history.map(o => o.pm10), borderColor: '#4f9cf9', backgroundColor: 'rgba(79,156,249,0.1)', fill: true, tension: 0.4, pointRadius: 0 },
                { label: 'PM1.0 (µg/m³)', data: history.map(o => o.pm1_0), borderColor: '#a78bfa', fill: false, tension: 0.4, pointRadius: 0 },
            ]
        },
        options: { ...chartDefaults, scales: { ...chartDefaults.scales, y: { ...chartDefaults.scales.y, title: { display: true, text: 'µg/m³', color: '#64748b' } } } }
    });
    charts.airParticles = new Chart(document.getElementById('chart-air-particles'), {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: '>0.3µm (per 0.1L)', data: history.map(o => o.p03um), borderColor: '#f43f5e', backgroundColor: 'rgba(244,63,94,0.1)', fill: true, tension: 0.4, pointRadius: 0 },
                { label: '>0.5µm (per 0.1L)', data: history.map(o => o.p05um), borderColor: '#fb923c', fill: false, tension: 0.4, pointRadius: 0 },
                { label: '>1.0µm (per 0.1L)', data: history.map(o => o.p10um), borderColor: '#34d399', fill: false, tension: 0.4, pointRadius: 0 },
            ]
        },
        options: { ...chartDefaults, scales: { ...chartDefaults.scales, y: { ...chartDefaults.scales.y, title: { display: true, text: 'particles per 0.1L', color: '#64748b' } } } }
    });
}

// ── Helpers ───────────────────────────────────────────────────
function set(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function populateET(d) {
    if (d.error) return;
    set('et-value', `${d.et0_mm} mm — ${d.date}`);
    set('et-interpretation', d.interpretation);
}

function setClass(id, className) {
    const el = document.getElementById(id);
    if (el) el.className = el.className.replace(/risk-\S+/g, '').trim() + ` ${className}`;
}

function riskClass(level) {
    return `risk-${level.toLowerCase().replace(' ', '-')}`;
}

function formatTimestamp(ts) {
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function trendClass(trend) {
    return `trend-${trend.toLowerCase()}`;
}

function uvRisk(uv) {
    if (uv >= 11) return 'Extreme';
    if (uv >= 8)  return 'Very High';
    if (uv >= 6)  return 'High';
    if (uv >= 3)  return 'Moderate';
    return 'Low';
}
function populateMicroclimate(d) {
    if (d.error) return;

    set('mc-temp-interpretation', d.interpretation.temperature);
    set('mc-temp-delta', `Delta: ${d.deltas.temperature > 0 ? '+' : ''}${d.deltas.temperature}°C`);
    set('mc-wind-interpretation', d.interpretation.wind);
    set('mc-wind-delta', `Delta: ${d.deltas.wind > 0 ? '+' : ''}${d.deltas.wind} mph`);

    set('mc-tempest-temp', d.tempest.temperature);
    set('mc-model-temp', d.open_meteo.temperature);
    set('mc-tempest-humidity', d.tempest.humidity);
    set('mc-model-humidity', d.open_meteo.humidity);
    set('mc-tempest-wind', d.tempest.wind_avg);
    set('mc-model-wind', d.open_meteo.wind_avg);

    if (d.deltas.uv_valid) {
        set('mc-tempest-uv', d.tempest.uv);
        set('mc-model-uv', d.open_meteo.uv);
    } else {
        set('mc-tempest-uv', 'N/A (night)');
        set('mc-model-uv', 'N/A (night)');
    }

    set('mc-model-time', d.open_meteo_time);
}
// ── Timelapse ─────────────────────────────────────────────────
async function loadTimelapse() {
    try {
        const videos = await fetch('/camera/timelapse').then(r => r.json());
        const select = document.getElementById('timelapse-select');
        const empty = document.getElementById('timelapse-empty');
        const video = document.getElementById('timelapse-video');

        if (videos.length === 0) {
            empty.style.display = 'block';
            select.style.display = 'none';
            return;
        }

        empty.style.display = 'none';
        select.style.display = 'block';

        // Populate dropdown
        videos.forEach(date => {
            const option = document.createElement('option');
            option.value = date;
            // Format YYYYMMDD as readable date
            const d = `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`;
            option.textContent = new Date(d).toLocaleDateString('en-GB', {
                weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
            });
            select.appendChild(option);
        });

        // Auto-select most recent
        select.value = videos[0];
        video.src = `/camera/timelapse/${videos[0]}`;
        video.style.display = 'block';

        // Handle selection change
        select.addEventListener('change', () => {
            if (select.value) {
                video.src = `/camera/timelapse/${select.value}`;
                video.style.display = 'block';
            }
        });

    } catch (err) {
        console.error('Failed to load timelapse:', err);
    }
}

// Call once on page load
loadTimelapse();

// ── Populate current conditions ────────────────────────────────
function populateCurrent(d) {
    // Header
    set('last-updated', formatTimestamp(d.timestamp));

    // Current tab
    set('cur-temp', d.temperature.air);
    const feelsFactor = d.temperature.feels_like_factor ? ` (${d.temperature.feels_like_factor})` : '';
    set('cur-feels-like', `Feels like ${d.temperature.feels_like}°C${feelsFactor}`);
    set('cur-humidity', d.humidity.relative);
    set('cur-humidity-desc', d.temperature.humidity_description);
    set('cur-wind', d.wind.avg);
    set('cur-wind-desc', `${d.wind.direction_abbr} · Force ${d.wind.beaufort_force} · ${d.wind.beaufort_description}`);
    set('cur-pressure', d.pressure.sea_level);

    const trendEl = document.getElementById('cur-pressure-trend');
    if (trendEl) {
        trendEl.textContent = d.pressure.trend.charAt(0).toUpperCase() + d.pressure.trend.slice(1);
        trendEl.className = `card-sub ${trendClass(d.pressure.trend)}`;
    }

    set('cur-uv', d.solar.uv);
    set('cur-sky', d.solar.sky_description);
    set('cur-rain', d.rain.today_total.toFixed(1));
    set('cur-rain-intensity', d.rain.intensity_description);
    set('cur-forecast', d.pressure.zambretti_forecast);
    set('cur-comfort', d.temperature.comfort_category);

    // Lightning card
    const lightCard = document.getElementById('lightning-card');
    set('cur-lightning', `${d.lightning.last_distance} miles · ${d.lightning.risk_level} risk`);
    set('cur-lightning-advice', d.lightning.advice);
    if (d.lightning.risk_level === 'High' || d.lightning.risk_level === 'Extreme') {
        lightCard.classList.add('card--danger');
    } else {
        lightCard.classList.remove('card--danger');
    }

    // Temperature tab
    set('temp-air', d.temperature.air);
    set('temp-feels', d.temperature.feels_like);
    set('temp-dew', d.temperature.dew_point);
    set('temp-wetbulb', d.temperature.wet_bulb);
    set('temp-abshum', d.temperature.absolute_humidity);
    set('temp-abshum-desc', d.temperature.humidity_description);
    set('temp-comfort', d.temperature.comfort_temp);
    set('temp-comfort-cat', d.temperature.comfort_category);

    // Frost risk
    const frostCard = document.getElementById('frost-card');
    set('temp-frost', d.frost.description);
    set('temp-frost-factors', d.frost.factors.join(' · ') || 'No contributing factors');
    frostCard.className = 'card card--wide';
    if (d.frost.risk_level === 'High') frostCard.classList.add('card--danger');

    // Wind tab
    set('wind-avg', d.wind.avg);
    set('wind-gust', d.wind.gust);
    set('wind-lull', d.wind.lull);
    set('wind-dir', d.wind.direction_abbr);
    set('wind-dir-full', `${d.wind.direction_degrees}° · ${d.wind.direction_compass}`);
    set('wind-beaufort', `Force ${d.wind.beaufort_force}`);
    set('wind-beaufort-desc', d.wind.beaufort_description);
    set('wind-gust-factor', d.wind.gust_factor ?? '—');
    set('wind-turbulence', d.wind.turbulent ? 'Turbulent conditions' : 'Steady conditions');

    // Pressure tab
    set('pres-sea', d.pressure.sea_level);
    set('pres-station', d.pressure.station);

    const presTrendEl = document.getElementById('pres-trend');
    if (presTrendEl) {
        presTrendEl.textContent = d.pressure.trend.charAt(0).toUpperCase() + d.pressure.trend.slice(1);
        presTrendEl.className = `card-value card-value--text ${trendClass(d.pressure.trend)}`;
    }

    set('pres-rate', d.pressure.change_rate);
    set('pres-zambretti', d.pressure.zambretti_forecast);
    set('pres-zambretti-letter', `Zambretti ${d.pressure.zambretti_letter}`);

    // Solar tab
    set('sol-radiation', d.solar.radiation);
    set('sol-uv', d.solar.uv);
    set('sol-uv-risk', `${uvRisk(d.solar.uv)} risk`);
    set('sol-brightness', d.solar.brightness.toLocaleString());
    set('sol-sky', d.solar.sky_description);
    set('sol-csi', `Clear sky index: ${d.solar.clear_sky_index ?? '—'}`);

    // Lightning tab
    const riskCard = document.getElementById('lightning-risk-card');
    set('light-risk', d.lightning.risk_level);
    set('light-distance', d.lightning.last_distance);
    set('light-count', d.lightning.count);
    set('light-advice', d.lightning.advice);
    riskCard.className = `card card--large`;
    if (d.lightning.risk_level === 'High' || d.lightning.risk_level === 'Extreme') {
        riskCard.classList.add('card--danger');
    }
}


// ── Charts ────────────────────────────────────────────────────
const chartDefaults = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
        legend: {
            labels: { color: '#94a3b8', font: { size: 11 } }
        }
    },
    scales: {
        x: {
            ticks: { color: '#64748b', maxTicksLimit: 8, font: { size: 10 } },
            grid:  { color: '#2a2d3e' }
        },
        y: {
            ticks: { color: '#64748b', font: { size: 10 } },
            grid:  { color: '#2a2d3e' }
        }
    }
};

let charts = {};

function buildCharts(history) {
    const labels = history.map(o =>
        new Date(o.timestamp * 1000).toLocaleTimeString('en-GB', {
            hour: '2-digit', minute: '2-digit'
        })
    );

    // Destroy existing charts before rebuilding
    Object.values(charts).forEach(c => c.destroy());
    charts = {};

    // Temperature chart
    charts.temperature = new Chart(
        document.getElementById('chart-temperature'),
        {
            type: 'line',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Air Temp (°C)',
                        data: history.map(o => o.air_temperature),
                        borderColor: '#f59e0b',
                        backgroundColor: 'rgba(245,158,11,0.1)',
                        fill: true,
                        tension: 0.4,
                        pointRadius: 0,
                    },
                    {
                        label: 'Humidity (%)',
                        data: history.map(o => o.relative_humidity),
                        borderColor: '#4f9cf9',
                        backgroundColor: 'rgba(79,156,249,0.05)',
                        fill: false,
                        tension: 0.4,
                        pointRadius: 0,
                        yAxisID: 'y1',
                    }
                ]
            },
            options: {
                ...chartDefaults,
                scales: {
                    ...chartDefaults.scales,
                    y:  { ...chartDefaults.scales.y, title: { display: true, text: '°C', color: '#64748b' } },
                    y1: {
                        position: 'right',
                        ticks: { color: '#64748b', font: { size: 10 } },
                        grid: { drawOnChartArea: false },
                        title: { display: true, text: '%', color: '#64748b' }
                    }
                }
            }
        }
    );

    // Wind chart
    charts.wind = new Chart(
        document.getElementById('chart-wind'),
        {
            type: 'line',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Gust (mph)',
                        data: history.map(o => o.wind_gust),
                        borderColor: '#ef4444',
                        backgroundColor: 'rgba(239,68,68,0.1)',
                        fill: true,
                        tension: 0.3,
                        pointRadius: 0,
                    },
                    {
                        label: 'Avg (mph)',
                        data: history.map(o => o.wind_avg),
                        borderColor: '#4f9cf9',
                        backgroundColor: 'rgba(79,156,249,0.1)',
                        fill: true,
                        tension: 0.3,
                        pointRadius: 0,
                    }
                ]
            },
            options: {
                ...chartDefaults,
                scales: {
                    ...chartDefaults.scales,
                    y: { ...chartDefaults.scales.y, title: { display: true, text: 'mph', color: '#64748b' } }
                }
            }
        }
    );

    // Pressure chart
    charts.pressure = new Chart(
        document.getElementById('chart-pressure'),
        {
            type: 'line',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Sea Level Pressure (mb)',
                        data: history.map(o => o.sea_level_pressure),
                        borderColor: '#a78bfa',
                        backgroundColor: 'rgba(167,139,250,0.1)',
                        fill: true,
                        tension: 0.4,
                        pointRadius: 0,
                    }
                ]
            },
            options: {
                ...chartDefaults,
                scales: {
                    ...chartDefaults.scales,
                    y: { ...chartDefaults.scales.y, title: { display: true, text: 'mb', color: '#64748b' } }
                }
            }
        }
    );

    // Solar chart
    charts.solar = new Chart(
        document.getElementById('chart-solar'),
        {
            type: 'line',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Solar Radiation (W/m²)',
                        data: history.map(o => o.solar_radiation),
                        borderColor: '#f59e0b',
                        backgroundColor: 'rgba(245,158,11,0.15)',
                        fill: true,
                        tension: 0.4,
                        pointRadius: 0,
                    },
                    {
                        label: 'UV Index',
                        data: history.map(o => o.uv),
                        borderColor: '#f43f5e',
                        fill: false,
                        tension: 0.4,
                        pointRadius: 0,
                        yAxisID: 'y1',
                    }
                ]
            },
            options: {
                ...chartDefaults,
                scales: {
                    ...chartDefaults.scales,
                    y:  { ...chartDefaults.scales.y, title: { display: true, text: 'W/m²', color: '#64748b' } },
                    y1: {
                        position: 'right',
                        ticks: { color: '#64748b', font: { size: 10 } },
                        grid: { drawOnChartArea: false },
                        title: { display: true, text: 'UV', color: '#64748b' }
                    }
                }
            }
        }
    );
}

function populateStorm(d) {
    if (d.error) return;
    
    const card = document.getElementById('storm-card');
    set('storm-probability', `${d.probability}% — ${d.category}`);
    set('storm-description', d.description);
    set('storm-advice', d.advice);
    
    card.className = 'card card--wide';
    if (d.probability >= 75) {
        card.classList.add('card--danger');
    }
}

// ── Rain summary ───────────────────────────────────────────────
function populateRain(d) {
    set('rain-spell',
        `${d.spell.current_spell_days} day ${d.spell.current_spell} spell`
    );
    set('rain-ari', d.antecedent_rainfall_index.saturation_risk);
    set('rain-ari-desc', d.antecedent_rainfall_index.description);
}

function populateMLRain(d) {
    if (d.error) return;
    set('ml-rain-probability', `${Math.round(d.rain_probability * 100)}%`);
    set('ml-rain-explanation', d.explanation);
    set('ml-rain-trained', `Trained on ${d.trained_on} observations`);
}

function populateRecords(d) {
    const a = d.all_time;
    const day = d.daily;
    const station = d.station;

    set('rec-station-info',
        `Recording since ${station.first_observation} · ` +
        `${station.total_observations.toLocaleString()} observations · ` +
        `${station.days_of_data} days of data`
    );

    set('rec-hottest', a.hottest.value);
    set('rec-hottest-date', a.hottest.datetime);
    set('rec-coldest', a.coldest.value);
    set('rec-coldest-date', a.coldest.datetime);
    set('rec-gust', a.strongest_gust.value);
    set('rec-gust-date', a.strongest_gust.datetime);
    set('rec-wind', a.highest_wind_avg.value);
    set('rec-wind-date', a.highest_wind_avg.datetime);
    set('rec-pressure-high', a.highest_pressure.value);
    set('rec-pressure-high-date', a.highest_pressure.datetime);
    set('rec-pressure-low', a.lowest_pressure.value);
    set('rec-pressure-low-date', a.lowest_pressure.datetime);
    set('rec-uv', a.highest_uv.value);
    set('rec-uv-date', a.highest_uv.datetime);
    set('rec-solar', a.highest_solar.value);
    set('rec-solar-date', a.highest_solar.datetime);

    set('rec-wettest-day', day.wettest_day.value);
    set('rec-wettest-day-date', day.wettest_day.date);
    set('rec-hottest-day', day.hottest_day.value);
    set('rec-hottest-day-date', day.hottest_day.date);
    set('rec-coldest-night', day.coldest_night.value);
    set('rec-coldest-night-date', day.coldest_night.date);
    set('rec-windiest-day', day.windiest_day.value);
    set('rec-windiest-day-date', day.windiest_day.date);

    const dry = d.dry_spell;
    set('rec-dry-spell', dry.value);
    set('rec-dry-spell-date', dry.start_date ? `${dry.start_date} to ${dry.end_date}` : '—');
    set('rec-dry-spell-status',
        dry.is_ongoing_record
            ? `Ongoing, started ${dry.current_streak_start}`
            : dry.current_streak_days > 0
                ? `Current streak: ${dry.current_streak_days} days`
                : 'No dry spell in progress'
    );
}

// ── Fetch and refresh ──────────────────────────────────────────

async function refresh() {
    try {
        const [current, history, heatwave, rain, records, storm, microclimate, et, mlRain, airCurrent, airHistory, thermalStress, dispersion, uvExposure, pollen, solarEnergy, comfort, windRose, uvForecast, fog] = await Promise.all([
            fetch('/api/current').then(r => r.json()),
            fetch('/api/history/24h').then(r => r.json()),
            fetch('/api/heatwave').then(r => r.ok ? r.json() : null),
            fetch('/api/rain/summary').then(r => r.json()),
            fetch('/api/records').then(r => r.json()),
            fetch('/api/storm').then(r => r.json()),
            fetch('/api/microclimate').then(r => r.json()),
            fetch('/api/evapotranspiration').then(r => r.json()),
            fetch('/api/ml/rain').then(r => r.json()),
            fetch('/api/air/current').then(r => r.ok ? r.json() : null),
            fetch('/api/air/history/24h').then(r => r.ok ? r.json() : []),
            fetch('/api/thermal-stress').then(r => r.ok ? r.json() : null),
            fetch('/api/dispersion').then(r => r.ok ? r.json() : null),
            fetch('/api/uv-exposure').then(r => r.ok ? r.json() : null),
            fetch('/api/pollen').then(r => r.ok ? r.json() : null),
            fetch('/api/solar-energy').then(r => r.ok ? r.json() : null),
            fetch('/api/comfort').then(r => r.ok ? r.json() : null),
            fetch('/api/wind/rose').then(r => r.ok ? r.json() : null),
            fetch('/api/uv-forecast').then(r => r.ok ? r.json() : null),
            fetch('/api/fog').then(r => r.ok ? r.json() : null),
        ]);

        populateStorm(storm);
        populateMicroclimate(microclimate);
        populateCurrent(current);
        buildCharts(history);
        populateRain(rain);
        populateRecords(records);
        populateET(et);
        populateMLRain(mlRain);
        populateAir(airCurrent);
        populateHeatwave(heatwave);
        buildAirCharts(airHistory);
        populateThermalStress(thermalStress);
        populateDispersion(dispersion);
        populateUVExposure(uvExposure);
        populatePollen(pollen);
        populateSolarEnergy(solarEnergy);
        populateComfort(comfort);
        buildWindRose(windRose);
        buildUVForecastChart(uvForecast);
        populateFog(fog);

        set('rain-rate', current.rain.current_rate.toFixed(1));
        set('rain-intensity', current.rain.intensity_description);
        set('rain-today', current.rain.today_total.toFixed(1));
        set('rain-yesterday', current.rain.yesterday_total.toFixed(3));
        set('rain-duration', current.rain.precip_minutes_today ?? '0');
        set('rain-last-1hr', current.rain.last_1hr.toFixed(1));
        set('rain-duration-desc', current.rain.precip_minutes_today > 0 
            ? `${current.rain.today_total.toFixed(1)}mm over ${current.rain.precip_minutes_today} minutes`
            : 'No rain recorded today');

        const cameraImg = document.getElementById('camera-image');
        if (cameraImg) {
            cameraImg.src = `/camera/latest?t=${Date.now()}`;
            set('camera-updated', new Date().toLocaleTimeString('en-GB'));
        }

    } catch (err) {
        console.error('Failed to fetch data:', err);
    }
}

// Initial load then refresh every 5 minutes
refresh();
setInterval(refresh, 5 * 60 * 1000);
