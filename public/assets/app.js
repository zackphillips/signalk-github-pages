const vesselUtils = window.vesselUtils;
if (!vesselUtils) {
  throw new Error('vesselUtils must be loaded before app.js');
}
if (!window.VESSEL_CONSTANTS) {
  throw new Error('constants.js must be loaded before app.js');
}
const C = window.VESSEL_CONSTANTS;
const { haversine, getAnchorDistanceColor, getWindDirection } = vesselUtils;

Chart.defaults.font.family = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
Chart.defaults.font.size = 12;
Chart.defaults.events = ['mousemove', 'mouseout', 'click', 'touchstart', 'touchmove', 'touchend'];

// Hide tooltips when the cursor/finger leaves the chart area
Chart.register({
  id: 'tooltipHideOnLeave',
  afterEvent(chart, args) {
    const type = args.event.type;
    if (type === 'mouseout' || type === 'touchend') {
      chart.tooltip.setActiveElements([], { x: 0, y: 0 });
      chart.update('none');
    }
  }
});

let map, marker, trackLine, trackMarkers;
let anchorLayer = null;    // Leaflet circle for anchor swing radius
let anchorMarker = null;   // ⚓ icon at anchor drop position
let anchorLine = null;     // dashed line from anchor to vessel
let trackLegend = null;    // Leaflet control for day-colour legend
let recentTrackCount = C.DEFAULT_RECENT_TRACK_COUNT; // Number of most-recent tracks to colour (rest shown pale white)
let trackByDay = new Map();    // Cached track data keyed by YYYY-MM-DD (local)
let tracksIndex = [];          // Metadata from tracks_index.json (all sailing days ever)
let olderTrackLayer = null;    // Leaflet layer for older tracks shown in white
let lat, lon; // Global variables for coordinates
let vesselState = ''; // 'underway' | 'at anchor' | ''
let vesselData = null; // Global vessel information

// ---------------------------------------------------------------------------
// localStorage forecast cache  —  TTL-based, silently degrades if unavailable
// ---------------------------------------------------------------------------
function getCached(key, ttlMs) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > ttlMs) { localStorage.removeItem(key); return null; }
    return data;
  } catch { return null; }
}
function setCached(key, data) {
  try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch { /* quota */ }
}
let tideStations = null; // Global tide stations data
const DEFAULT_TIDE_LOCATION = {
  lat:   C.DEFAULT_TIDE_LAT,
  lon:   C.DEFAULT_TIDE_LON,
  label: C.DEFAULT_TIDE_LABEL,
};

const PANEL_SKELETONS = {
  'navigation-grid': 6,
  'wind-grid': 7,
  'power-grid': 11,
  'vessel-grid': 4,
  'sensors-grid': 6,
  'internet-grid': 4,
  'system-grid': 5,
  'propulsion-grid': 2,
  'tanks-grid': 6,
};


function classifyBatteryStatus(percent) {
  if (!Number.isFinite(percent)) return null;
  if (percent >= C.BATTERY_OK_PCT)   return { level: 'ok',    label: 'Charged' };
  if (percent >= C.BATTERY_WARN_PCT) return { level: 'warn',  label: 'Low' };
  return { level: 'alert', label: 'Critical' };
}

function classifyBatteryTime(hours) {
  if (!Number.isFinite(hours)) return null;
  if (hours >= C.BATTERY_TIME_OK_H)   return { level: 'ok',   label: 'Plenty' };
  if (hours >= C.BATTERY_TIME_WARN_H) return { level: 'warn', label: 'Soon' };
  return { level: 'alert', label: 'Short' };
}

function classifyAnchorStatus(current, max) {
  if (!Number.isFinite(current) || !Number.isFinite(max) || max <= 0) return null;
  if (current <= max * C.ANCHOR_WARN_RATIO) return { level: 'ok',   label: 'Safe' };
  if (current <= max * C.ANCHOR_EDGE_RATIO) return { level: 'warn', label: 'Edge' };
  return { level: 'alert', label: 'Drifting' };
}

function classifyPacketLoss(loss) {
  if (!Number.isFinite(loss)) return null;
  const percentage = loss <= 1 ? loss * 100 : loss;
  if (percentage < C.PACKET_LOSS_OK_PCT)   return { level: 'ok',   label: 'Clean' };
  if (percentage < C.PACKET_LOSS_WARN_PCT) return { level: 'warn', label: 'Lossy' };
  return { level: 'alert', label: 'Dropping' };
}

function classifyTankLevel(level) {
  if (!Number.isFinite(level)) return null;
  if (level >= C.TANK_OK_RATIO)   return { level: 'ok',   label: 'Healthy' };
  if (level >= C.TANK_WARN_RATIO) return { level: 'warn', label: 'Low' };
  return { level: 'alert', label: 'Refill' };
}

function classifyWasteTank(level) {
  if (!Number.isFinite(level)) return null;
  if (level <= C.WASTE_WARN_RATIO)  return { level: 'ok',   label: 'Clear' };
  if (level <= C.WASTE_ALERT_RATIO) return { level: 'warn', label: 'Rising' };
  return { level: 'alert', label: 'Full' };
}

// Classify a value using SignalK meta.zones if available, otherwise return null.
// SignalK zone states: nominal/normal → ok, warn/caution → warn, alert/alarm/emergency → alert.
function classifyByZones(value, zones) {
  if (!Array.isArray(zones) || !Number.isFinite(value)) return null;
  for (const zone of zones) {
    const above = zone.lower == null || value >= zone.lower;
    const below = zone.upper == null || value <= zone.upper;
    if (above && below) {
      const s = zone.state;
      if (s === 'nominal' || s === 'normal') return { level: 'ok' };
      if (s === 'warn'    || s === 'caution') return { level: 'warn' };
      if (s === 'alert'   || s === 'alarm' || s === 'emergency') return { level: 'alert' };
    }
  }
  return null;
}

// Render a value div whose text is colored by status level (ok/warn/alert).
function colorValue(display, status) {
  if (display === 'N/A') return `<div class="value"><span class="value-na">N/A</span></div>`;
  const cls = status?.level ? ` value-${status.level}` : '';
  return `<div class="value${cls}">${display}</div>`;
}

function renderAlertSummary() {
  const el = document.getElementById('alert-summary');
  if (!el) return;
  const items = [];
  document.querySelectorAll('.info-item').forEach(item => {
    if (item.closest('#alert-summary')) return; // avoid self-reference on re-render
    const valueEl = item.querySelector('.value-alert, .value-warn');
    if (!valueEl) return;
    const labelEl = item.querySelector('.label');
    if (!labelEl) return;
    const level = valueEl.classList.contains('value-alert') ? 'alert' : 'warn';
    items.push({
      label: labelEl.textContent.trim(),
      valueHtml: valueEl.innerHTML,
      level,
      unitGroup: item.dataset.unitGroup || '',
      raw: item.dataset.raw || '',
      path: item.dataset.path || '',
      dataLevel: item.dataset.level || '',
    });
  });
  items.sort((a, b) => (a.level === 'alert' ? -1 : 1));
  if (!items.length) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.innerHTML = `
    <div class="panel-title">System Alerts</div>
    <div class="data-grid">
      ${items.map(i => {
        const attrs = [
          i.unitGroup ? `data-unit-group="${i.unitGroup}"` : '',
          i.raw !== '' ? `data-raw="${i.raw}"` : '',
          i.path ? `data-path="${i.path}"` : '',
          i.dataLevel ? `data-level="${i.dataLevel}"` : '',
        ].filter(Boolean).join(' ');
        return `
          <div class="info-item" ${attrs}>
            <div class="label">${i.label}</div>
            <div class="value value-${i.level}">${i.valueHtml}</div>
          </div>`;
      }).join('')}
    </div>`;
}

function renderSkeletonGrid(containerId, count = 6) {
  const container = document.getElementById(containerId);
  if (!container) return;
  let html = '';
  for (let i = 0; i < count; i++) {
    html += `
      <div class="info-item skeleton-card">
        <div class="skeleton-bar skeleton-label"></div>
        <div class="skeleton-bar skeleton-value"></div>
      </div>`;
  }
  container.innerHTML = html;
}

function renderForecastSkeleton(containerId, count = 4) {
  const container = document.getElementById(containerId);
  if (!container) return;
  let html = '';
  for (let i = 0; i < count; i++) {
    html += `
      <div class="skeleton-card" style="height: 110px;">
        <div class="skeleton-bar skeleton-label" style="width: 50%;"></div>
        <div class="skeleton-bar skeleton-value" style="margin-top: 12px;"></div>
        <div class="skeleton-bar skeleton-label" style="width: 70%; margin-top: 12px;"></div>
      </div>`;
  }
  container.innerHTML = html;
}

function primeSkeletons() {
  Object.entries(PANEL_SKELETONS).forEach(([id, count]) => renderSkeletonGrid(id, count));
}

function renderEmptyState(containerId, title, subtitle = '') {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = `
    <div class="empty-state">
      <strong>${title}</strong>
      <span>${subtitle}</span>
    </div>`;
}

// Pretty-print an already-fetched object into the Data tab's raw-data <pre>
// blocks. No new network calls — callers pass data this app already fetched.
function setRawDataPre(id, obj) {
  const el = document.getElementById(id);
  if (!el) return;
  try {
    el.textContent = JSON.stringify(obj, null, 2);
  } catch (e) {
    el.textContent = 'Unable to render raw data.';
  }
}

async function updateMapLocation(lat, lon) {
  try {
    // If inside a privacy zone, snap the geocoding lookup to the zone center
    // so we get a proper landmark name rather than an open-water coordinate.
    const zone = getPrivacyZoneCenter(lat, lon);
    const lookupLat = zone ? zone.lat : lat;
    const lookupLon = zone ? zone.lon : lon;
    const response = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lookupLat}&lon=${lookupLon}&format=json&zoom=10&addressdetails=1`);
    const data = await response.json();

    let locationName = "Unknown Location";

    if (data.display_name) {
      // Parse the display name to get a more concise location
      const parts = data.display_name.split(', ');
      if (parts.length >= 2) {
        // Try to get city and state/country
        const city = parts[0];
        const state = parts[1];
        locationName = `${city}, ${state}`;
      } else {
        locationName = data.display_name;
      }
    }

    setStatusSentence(locationName);
  } catch (error) {
    console.error('Error fetching location:', error);
    setStatusSentence('unknown location');
  }
}

function setStatusSentence(locationName) {
  const el = document.getElementById('status-sentence');
  if (!el) return;
  const isStale = document.getElementById('status-hero')?.classList.contains('stale');
  if (vesselState === 'underway') {
    el.textContent = isStale
      ? `Last seen underway near ${locationName}`
      : `Underway near ${locationName}`;
  } else if (vesselState === 'at anchor') {
    el.textContent = isStale
      ? `Last seen at anchor in ${locationName}`
      : `At anchor in ${locationName}`;
  } else {
    el.textContent = isStale
      ? `Last seen in ${locationName}`
      : `In ${locationName}`;
  }
}

// 24 distinct colors for per-day track segments (cycles if more than 24 days).
const DAY_TRACK_COLORS = [
  '#e74c3c', '#e67e22', '#f39c12', '#2ecc71', '#1abc9c', '#3498db',
  '#9b59b6', '#e91e63', '#ff5722', '#8bc34a', '#00bcd4', '#673ab7',
  '#ff9800', '#4caf50', '#03a9f4', '#9c27b0', '#f44336', '#cddc39',
  '#009688', '#2196f3', '#ff4081', '#76ff03', '#40c4ff', '#ea80fc',
];

// Privacy zones — populated from vesselData.privacy_zones after YAML loads.
// Falls back to the South Beach Harbor constant when vesselData is unavailable.
function getPrivacyZones() {
  const zones = vesselData?.privacy_zones;
  if (Array.isArray(zones) && zones.length) return zones;
  return [{
    lat:      C.FALLBACK_PRIVACY_ZONE_LAT,
    lon:      C.FALLBACK_PRIVACY_ZONE_LON,
    radius_m: C.FALLBACK_PRIVACY_ZONE_RADIUS_M,
  }];
}

function isInPrivacyZone(lat, lon) {
  return getPrivacyZones().some(
    (z) => haversineMeters(lat, lon, z.lat, z.lon) <= z.radius_m
  );
}

// Return the center of the first zone containing (lat, lon), or null.
function getPrivacyZoneCenter(lat, lon) {
  return getPrivacyZones().find(
    (z) => haversineMeters(lat, lon, z.lat, z.lon) <= z.radius_m
  ) ?? null;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Normalise a positions_index entry to {latitude, longitude, timestamp,
 * speedOverGround, courseOverGroundTrue}, handling both:
 *   - Legacy format: flat keys (latitude, longitude, speedOverGround, …)
 *   - New SignalK format: values array [{path, value}, …]
 */
function parsePositionPoint(point) {
  if (!point || typeof point !== 'object') return null;

  if (Array.isArray(point.values)) {
    // New SignalK-style format
    const find = (path) => point.values.find((v) => v.path === path)?.value;
    const pos = find('navigation.position');
    const sog = find('navigation.speedOverGround');
    const cog = find('navigation.courseOverGroundTrue');
    return {
      latitude: Number(pos?.latitude),
      longitude: Number(pos?.longitude),
      timestamp: point.timestamp ?? null,
      speedOverGround: sog != null ? Number(sog) : NaN,
      courseOverGroundTrue: cog != null ? Number(cog) : NaN,
    };
  }

  // Legacy flat format
  return {
    latitude: Number(point.latitude),
    longitude: Number(point.longitude),
    timestamp: point.timestamp ?? null,
    speedOverGround: point.speedOverGround != null ? Number(point.speedOverGround) : NaN,
    courseOverGroundTrue: point.courseOverGroundTrue != null ? Number(point.courseOverGroundTrue) : NaN,
  };
}

// YYYY-MM-DD in the viewer's local timezone — the key format trackByDay uses.
function localDayKey(dateish) {
  const d = dateish instanceof Date ? dateish : new Date(dateish);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Base map tiles. Shared by the main map, the theme switcher, and the
// per-voyage mini maps so they never drift apart.
//
// We used to swap in CARTO's free "dark_all" tiles for dark themes, but
// CARTO now requires an API key for that endpoint — it doesn't fail, it
// just serves a tile watermarked "API KEY REQUIRED" instead of the map.
// Rather than take on a key to manage, we stick to the always-free OSM
// tiles for every theme and fake the dark look with a CSS filter on the
// tile pane (see the `.leaflet-tile-pane` rule in styles.css).
function tileLayerForTheme() {
  return L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
  });
}

function _gpxLinkForDay(localDay) {
  // Find the tracks_index entry whose start timestamp maps to this local day.
  for (const track of tracksIndex) {
    if (!track.file) continue;
    const startLocal = track.start
      ? (() => { const d = new Date(track.start); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })()
      : null;
    if (track.date === localDay || startLocal === localDay) {
      const vesselSlug = (vesselData?.name || 'vessel').replace(/[^a-z0-9]/gi, '-');
      return {
        url: `data/telemetry/${track.file}`,
        filename: `${vesselSlug}-${track.date}.gpx`,
      };
    }
  }
  return null;
}

function renderTracks() {
  if (!map || !trackByDay.size) return;

  // Clear previous track layers.
  if (!trackMarkers) {
    trackMarkers = L.layerGroup().addTo(map);
  } else {
    trackMarkers.clearLayers();
  }
  if (trackLine) {
    const lines = Array.isArray(trackLine) ? trackLine : [trackLine];
    lines.forEach((l) => map.removeLayer(l));
    trackLine = null;
  }
  if (olderTrackLayer) {
    map.removeLayer(olderTrackLayer);
    olderTrackLayer = null;
  }

  // Sort newest-first; recent = first recentTrackCount coloured, older = all remainder.
  const days = [...trackByDay.keys()].sort().reverse();
  const recentDays = days.slice(0, recentTrackCount);
  const olderDays = days.slice(recentTrackCount);

  // Draw older tracks first (pale white) so coloured recent tracks appear on top.
  if (olderDays.length) {
    const segments = olderDays.map((day) =>
      trackByDay.get(day).map((p) => [p.latitude, p.longitude])
    );
    olderTrackLayer = L.polyline(segments, { color: '#ffffff', weight: 2, opacity: 0.35 }).addTo(map);
  }

  // Draw recent tracks with per-day colours, oldest-to-newest so newest is on top.
  const lines = [];
  [...recentDays].reverse().forEach((day) => {
    const idx = recentDays.indexOf(day);
    const color = DAY_TRACK_COLORS[idx % DAY_TRACK_COLORS.length];
    const pts = trackByDay.get(day);
    const latlngs = pts.map((p) => [p.latitude, p.longitude]);
    lines.push(L.polyline(latlngs, { color, weight: 3, opacity: 0.8 }).addTo(map));
    pts.forEach((point) => {
      const timeLabel = point.timestamp ? new Date(point.timestamp).toLocaleString() : 'N/A';
      const speedLabel = Number.isFinite(point.speedOverGround)
        ? `${(point.speedOverGround * 1.94384).toFixed(1)} kts` : 'N/A';
      const courseLabel = Number.isFinite(point.courseOverGroundTrue)
        ? `${(point.courseOverGroundTrue * 180 / Math.PI).toFixed(0)}°` : 'N/A';
      const tooltipHtml = `<strong>Time:</strong> ${timeLabel}<br/><strong>Speed:</strong> ${speedLabel}<br/><strong>Course:</strong> ${courseLabel}`;
      L.circleMarker([point.latitude, point.longitude], {
        radius: 3,
        color,
        fillColor: color,
        fillOpacity: 0.7,
        weight: 1,
      }).bindTooltip(tooltipHtml, { direction: 'top', opacity: 0.9 }).addTo(trackMarkers);
    });
  });
  trackLine = lines;

  // Build / rebuild the day-colour legend.
  if (trackLegend) { trackLegend.remove(); trackLegend = null; }
  if (!days.length || !map) return;

  trackLegend = L.control({ position: 'bottomright' });
  trackLegend.onAdd = () => {
    const div = L.DomUtil.create('div', 'track-legend');
    const legendItems = recentDays.map((day, idx) => {
      const color = DAY_TRACK_COLORS[idx % DAY_TRACK_COLORS.length];
      const label = new Date(`${day}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
      const gpxLink = _gpxLinkForDay(day);
      const dlBtn = gpxLink
        ? `<a class="track-gpx-dl" href="${gpxLink.url}" download="${gpxLink.filename}" title="Download GPX">↓</a>`
        : '';
      return `<div class="track-legend-item">
        <span class="track-legend-swatch" style="background:${color}"></span>
        <span>${label}</span>${dlBtn}
      </div>`;
    }).join('');

    let olderSwatchHtml = '';
    if (olderDays.length > 0) {
      olderSwatchHtml = `<div class="track-legend-item track-legend-item--muted">
        <span class="track-legend-swatch track-legend-swatch--past"></span>
        <span>Older (${olderDays.length} day${olderDays.length === 1 ? '' : 's'})</span>
        <button class="track-gpx-dl track-older-dl" title="Download an older track">↓</button>
      </div>`;
    }

    const trackCounts = [3, 5, 10].filter((count) => count <= days.length);
    const btns = trackCounts.map((count) =>
      `<button class="track-hist-btn${recentTrackCount === count ? ' active' : ''}" data-count="${count}">${count} Tracks</button>`
    ).join('');
    const historyHtml = trackCounts.length
      ? `<div class="track-hist-row"><span class="track-hist-label">Show</span>${btns}</div>`
      : '';

    div.innerHTML = legendItems + olderSwatchHtml + historyHtml;

    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);

    div.querySelectorAll('.track-hist-btn').forEach((btn) => {
      L.DomEvent.on(btn, 'click', () => {
        recentTrackCount = parseInt(btn.dataset.count, 10);
        renderTracks();
      });
    });

    const olderDlBtn = div.querySelector('.track-older-dl');
    if (olderDlBtn) {
      L.DomEvent.on(olderDlBtn, 'click', () => {
        showOlderTracksDialog(olderDays);
      });
    }

    return div;
  };
  trackLegend.addTo(map);
}

function showOlderTracksDialog(olderDays) {
  const existing = document.getElementById('older-tracks-dialog');
  if (existing) { existing.remove(); return; }

  const dialog = document.createElement('div');
  dialog.id = 'older-tracks-dialog';
  dialog.className = 'older-tracks-dialog';

  const rows = olderDays.map((day) => {
    const label = new Date(`${day}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    const gpxLink = _gpxLinkForDay(day);
    const dlBtn = gpxLink
      ? `<a class="older-tracks-dialog-dl" href="${gpxLink.url}" download="${gpxLink.filename}" title="Download GPX">↓ GPX</a>`
      : `<span class="older-tracks-no-gpx">No file</span>`;
    return `<div class="older-tracks-dialog-row"><span class="older-tracks-dialog-date">${label}</span>${dlBtn}</div>`;
  }).join('');

  dialog.innerHTML = `
    <div class="older-tracks-dialog-header">
      <span>Download Older Tracks</span>
      <button class="older-tracks-dialog-close" title="Close">✕</button>
    </div>
    <div class="older-tracks-dialog-list">${rows}</div>
  `;

  document.body.appendChild(dialog);
  dialog.querySelector('.older-tracks-dialog-close').addEventListener('click', () => dialog.remove());
}

async function loadTrack() {
  try {
    const response = await fetch(`data/telemetry/positions_index.json?ts=${Date.now()}`);
    if (!response.ok) {
      throw new Error(`Positions index not found: ${response.status}`);
    }
    const payload = await response.json();
    const rawPositions = Array.isArray(payload) ? payload : payload.positions;
    if (!Array.isArray(rawPositions) || !map) return;

    const positions = rawPositions
      .map(parsePositionPoint)
      .filter((p) => p
        && Number.isFinite(p.latitude)
        && Number.isFinite(p.longitude)
        && !isInPrivacyZone(p.latitude, p.longitude));

    // Group by LOCAL calendar day (YYYY-MM-DD) so one day's track is one color.
    const byDay = new Map();
    for (const p of positions) {
      let dayKey = 'unknown';
      if (p.timestamp) {
        const dt = new Date(p.timestamp);
        dayKey = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      }
      if (!byDay.has(dayKey)) byDay.set(dayKey, []);
      byDay.get(dayKey).push(p);
    }

    trackByDay = byDay;
    if (positions.length) renderTracks();
    // Load historical tracks (GPX files) without blocking the initial render.
    // Always runs even when all recent positions are in a privacy zone.
    loadHistoricalTracks();
  } catch (error) {
    console.warn('Unable to load track data:', error);
  }
}

function parseGpxText(gpxText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(gpxText, 'application/xml');
  if (doc.querySelector('parsererror')) return [];
  const points = [];
  doc.querySelectorAll('trkpt').forEach((trkpt) => {
    const lat = parseFloat(trkpt.getAttribute('lat'));
    const lon = parseFloat(trkpt.getAttribute('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const timeEl = trkpt.querySelector('time');
    const timestamp = timeEl ? timeEl.textContent.trim() : null;
    const speedEl = trkpt.querySelector('speed');
    const courseEl = trkpt.querySelector('course');
    const speedMs = speedEl ? parseFloat(speedEl.textContent) : NaN;
    const courseDeg = courseEl ? parseFloat(courseEl.textContent) : NaN;
    points.push({
      latitude: lat,
      longitude: lon,
      timestamp,
      speedOverGround: Number.isFinite(speedMs) ? speedMs : NaN,
      // Convert degrees → radians to match positions_index format
      courseOverGroundTrue: Number.isFinite(courseDeg) ? courseDeg * Math.PI / 180 : NaN,
    });
  });
  return points;
}

async function loadHistoricalTracks() {
  try {
    const resp = await fetch(`data/telemetry/tracks_index.json?ts=${Date.now()}`);
    if (!resp.ok) return;
    const data = await resp.json();
    tracksIndex = Array.isArray(data) ? data : (data.tracks ?? []);
  } catch (e) {
    console.warn('Unable to load tracks index:', e);
    renderVoyageList();
    return;
  }

  // Fetch all GPX files in parallel, skip days already covered by positions_index.
  const covered = new Set(trackByDay.keys());
  const toFetch = tracksIndex.filter((track) => {
    // A track's UTC date might map to a different local day. Check both.
    const utcDate = track.date;
    const localDate = track.start
      ? (() => { const d = new Date(track.start); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })()
      : null;
    return !covered.has(utcDate) && !(localDate && covered.has(localDate));
  });

  if (!toFetch.length) { renderVoyageList(); return; }

  const results = await Promise.all(toFetch.map(async (track) => {
    try {
      const r = await fetch(`data/telemetry/${track.file}?ts=${Date.now()}`);
      if (!r.ok) return null;
      return { track, text: await r.text() };
    } catch {
      return null;
    }
  }));

  let added = false;
  for (const result of results) {
    if (!result) continue;
    const points = parseGpxText(result.text);
    if (!points.length) continue;
    // Group by local calendar day (same logic as loadTrack)
    for (const p of points) {
      if (!p.timestamp) continue;
      const dt = new Date(p.timestamp);
      const dayKey = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
      if (!trackByDay.has(dayKey)) {
        trackByDay.set(dayKey, []);
        added = true;
      }
      trackByDay.get(dayKey).push(p);
    }
  }
  if (added) renderTracks();
  renderVoyageList();
}

const fmtVoyageDate = (d) => d ? new Date(`${d}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const fmtVoyageNum = (v, digits, suffix) => Number.isFinite(v) ? `${v.toFixed(digits)} ${suffix}` : '—';

// Build the Voyages-tab log list from tracks_index.json metadata (already
// fetched above into `tracksIndex`) — no additional network calls.
function renderVoyageList() {
  const container = document.getElementById('voyage-list');
  if (!container) return;

  if (!tracksIndex.length) {
    container.innerHTML = '<div class="voyage-list-empty">No voyages recorded yet.</div>';
    return;
  }

  const rows = [...tracksIndex].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  container.innerHTML = rows.map((t) => `
    <div class="voyage-item" data-date="${t.date}">
      <button class="voyage-row" type="button" aria-expanded="false" title="Show voyage details">
        <span class="voyage-row-date">${fmtVoyageDate(t.date)}</span>
        <span class="voyage-row-stat">${fmtVoyageNum(t.distance_nm, 1, 'nm')}</span>
        <span class="voyage-row-stat">${fmtVoyageNum(t.duration_hours, 1, 'hr')}</span>
        <span class="voyage-row-stat">${fmtVoyageNum(t.max_speed_kts, 1, 'kts')}</span>
        <span class="voyage-row-chevron" aria-hidden="true"></span>
      </button>
      <div class="voyage-detail" hidden></div>
    </div>`).join('');

  bindVoyageListOnce(container);
}

// One delegated listener on the list survives every renderVoyageList() rerender.
let voyageListBound = false;
function bindVoyageListOnce(container) {
  if (voyageListBound) return;
  voyageListBound = true;

  container.addEventListener('click', (e) => {
    const item = e.target.closest('.voyage-item');
    if (!item) return;

    if (e.target.closest('.voyage-show-on-map')) {
      const date = item.dataset.date;
      if (typeof window.mermugActivateTab === 'function') window.mermugActivateTab('map');
      focusTrackDay(date);
      return;
    }

    if (e.target.closest('.voyage-row')) toggleVoyageDetail(item);
  });
}

// tracks_index keys on the track's UTC date, trackByDay on the viewer's local
// calendar day — an evening sail lands under tomorrow's UTC date, so try both.
function trackDayKeyFor(date) {
  const entry = tracksIndex.find((t) => t.date === date);
  const keys = [date];
  if (entry?.start) keys.push(localDayKey(entry.start));
  for (const key of keys) {
    const pts = key && trackByDay.get(key);
    if (pts && pts.length) return key;
  }
  return null;
}

function trackPointsForDate(date) {
  const key = trackDayKeyFor(date);
  return key ? trackByDay.get(key) : null;
}

function closeVoyageDetail(item) {
  const detail = item.querySelector('.voyage-detail');
  if (!detail || detail.hidden) return;
  // Leaflet leaks handlers if the container is torn out from under it.
  if (item._voyageMap) {
    item._voyageMap.remove();
    item._voyageMap = null;
  }
  detail.hidden = true;
  detail.innerHTML = '';
  item.classList.remove('is-open');
  item.querySelector('.voyage-row')?.setAttribute('aria-expanded', 'false');
}

// Accordion: at most one voyage open, so at most one mini map is ever alive.
function toggleVoyageDetail(item) {
  const wasOpen = item.classList.contains('is-open');
  item.parentElement.querySelectorAll('.voyage-item.is-open').forEach(closeVoyageDetail);
  if (wasOpen) return;

  const entry = tracksIndex.find((t) => t.date === item.dataset.date);
  if (!entry) return;

  const detail = item.querySelector('.voyage-detail');
  detail.innerHTML = voyageDetailHtml(entry);
  detail.hidden = false;
  item.classList.add('is-open');
  item.querySelector('.voyage-row')?.setAttribute('aria-expanded', 'true');

  renderVoyageMiniMap(item, entry);
}

function voyageDetailHtml(entry) {
  const fmtTime = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };
  const avgKts = Number.isFinite(entry.distance_nm) && entry.duration_hours > 0
    ? entry.distance_nm / entry.duration_hours
    : NaN;

  const stats = [
    ['Start',     fmtTime(entry.start)],
    ['End',       fmtTime(entry.end)],
    ['Distance',  fmtVoyageNum(entry.distance_nm, 2, 'nm')],
    ['Duration',  fmtVoyageNum(entry.duration_hours, 2, 'hr')],
    ['Max speed', fmtVoyageNum(entry.max_speed_kts, 1, 'kts')],
    ['Avg speed', fmtVoyageNum(avgKts, 1, 'kts')],
    ['Fixes',     Number.isFinite(entry.points) ? String(entry.points) : '—'],
  ];

  const gpx = _gpxLinkForDay(entry.date)
    || (entry.file ? { url: `data/telemetry/${entry.file}`, filename: `${entry.date}.gpx` } : null);

  return `
    <div class="voyage-detail-map"></div>
    <div class="voyage-detail-stats">
      ${stats.map(([label, value]) => `
        <div class="voyage-detail-stat">
          <span class="voyage-detail-stat-label">${label}</span>
          <span class="voyage-detail-stat-value">${value}</span>
        </div>`).join('')}
    </div>
    <div class="voyage-detail-actions">
      <button type="button" class="voyage-detail-btn voyage-show-on-map">Show on main map</button>
      ${gpx ? `<a class="voyage-detail-btn voyage-detail-btn--ghost" href="${gpx.url}" download="${gpx.filename}">Download GPX</a>` : ''}
      <a class="voyage-detail-btn voyage-detail-btn--ghost" target="_blank" rel="noopener noreferrer"
         href="https://github.com/${C.GITHUB_REPO}/edit/${C.GITHUB_DEFAULT_BRANCH}/${C.CAPTAINS_LOG_PATH}"
         title="Opens the Captain's Log in the GitHub editor — add crew, conditions and notes for this trip">Log this voyage</a>
    </div>`;
}

function renderVoyageMiniMap(item, entry) {
  const el = item.querySelector('.voyage-detail-map');
  if (!el || typeof L === 'undefined') return;

  const pts = trackPointsForDate(entry.date);
  const latlngs = (pts || [])
    .map((p) => [p.latitude, p.longitude])
    .filter(([la, lo]) => Number.isFinite(la) && Number.isFinite(lo));

  if (!latlngs.length) {
    el.classList.add('voyage-detail-map--empty');
    el.textContent = 'Track for this day is still loading.';
    return;
  }

  const mini = L.map(el, {
    attributionControl: false,
    // The card sits in a scrolling list; wheel-zoom would hijack the scroll.
    scrollWheelZoom: false,
  });
  tileLayerForTheme().addTo(mini);
  L.polyline(latlngs, { color: DAY_TRACK_COLORS[0], weight: 3, opacity: 0.9 }).addTo(mini);
  L.circleMarker(latlngs[0], { radius: 5, color: '#22c55e', fillColor: '#22c55e', fillOpacity: 1, weight: 1 })
    .bindTooltip('Start', { direction: 'top' }).addTo(mini);
  L.circleMarker(latlngs[latlngs.length - 1], { radius: 5, color: '#ef4444', fillColor: '#ef4444', fillOpacity: 1, weight: 1 })
    .bindTooltip('End', { direction: 'top' }).addTo(mini);
  mini.fitBounds(latlngs, { padding: [18, 18], maxZoom: 15 });

  item._voyageMap = mini;
  // The card was `hidden` a tick ago; Leaflet needs a laid-out container.
  requestAnimationFrame(() => mini.invalidateSize());
}

// Zoom the map to a single day's track and bring it into the "recent"
// coloured set (rather than the pale "older" styling) — called from the
// Voyages tab list via tabs.js. Reuses renderTracks()'s existing per-day
// colouring instead of drawing a separate highlight layer.
function focusTrackDay(date) {
  if (!map || !date) return;
  const pts = trackPointsForDate(date);
  if (!pts || !pts.length) {
    console.warn('Track points for', date, 'are not loaded yet.');
    return;
  }
  const latlngs = pts
    .map((p) => [p.latitude, p.longitude])
    .filter(([la, lo]) => Number.isFinite(la) && Number.isFinite(lo));
  if (!latlngs.length) return;

  const days = [...trackByDay.keys()].sort().reverse();
  const idx = days.indexOf(trackDayKeyFor(date));
  if (idx >= 0 && idx >= recentTrackCount) {
    recentTrackCount = idx + 1;
    renderTracks();
  }

  requestAnimationFrame(() => map.fitBounds(latlngs, { padding: [30, 30], maxZoom: 15 }));
}
window.focusTrackDay = focusTrackDay;

// Get all tide stations from loaded JSON data
function getAllStations() {
  if (!tideStations) return [];

  // New format: tideStations.stations is a flat array
  return tideStations.stations || [];
}

let tideChartInstance = null;
let polarChartInstance = null;
let polarData = null;
let currentEnv = null; // Global environment data
let currentNav = null; // Global navigation data
let currentPropulsion = null; // Global propulsion data
let isDrawingPolarChart = false; // Flag to prevent multiple simultaneous chart draws
let lastPolarChartUpdate = 0; // Timestamp of last chart update
const SPARKLINE_POINTS = C.SPARKLINE_POINTS;
let seriesByPath = null;
let seriesPromise = null;
let refreshSparklines = null; // set once initInlineSparklines is ready
let bannerState = 'ok'; // 'ok' | 'error' — persists across theme switches

// ── Theme cycling ──────────────────────────────────────────────────────────
// The lists live in constants.js so docs.html gets the same cycle without
// pulling in this whole file.
const THEMES = C.THEMES;
const DARK_THEMES = new Set(C.DARK_THEMES);
function isDarkTheme(theme) { return DARK_THEMES.has(theme); }

// ── Unit-toggle configuration ──────────────────────────────────────────────
// Each group lists unit options in cycle order. Clicking/tapping any info-item
// with a matching data-unit-group cycles to the next unit in the list.
const UNIT_GROUPS = {
  speed: [
    { unit: 'kts',  transform: v => v * 1.94384,  digits: 1 },
    { unit: 'mph',  transform: v => v * 2.23694,   digits: 1 },
    { unit: 'km/h', transform: v => v * 3.6,       digits: 1 },
  ],
  temperature: [
    { unit: '°F', transform: v => (v - 273.15) * 9 / 5 + 32, digits: 1 },
    { unit: '°C', transform: v => v - 273.15,                 digits: 1 },
  ],
  pressure: [
    { unit: 'mbar', transform: v => v / 100,       digits: 1 },
    { unit: 'inHg', transform: v => v * 0.0002953, digits: 2 },
  ],
  distance: [
    { unit: 'nm', transform: v => v / 1852,    digits: 1 },
    { unit: 'km', transform: v => v / 1000,    digits: 2 },
    { unit: 'mi', transform: v => v / 1609.34, digits: 1 },
  ],
  length: [
    { unit: 'ft', transform: v => v * 3.28084, digits: 1 },
    { unit: 'm',  transform: v => v,            digits: 1 },
  ],
  angle: [
    { unit: '°',   transform: v => v * 180 / Math.PI, digits: 1 },
    { unit: 'rad', transform: v => v,                  digits: 3 },
  ],
  rotation: [
    { unit: 'RPM', transform: v => v * 60, digits: 0 },
    { unit: 'Hz',  transform: v => v,      digits: 2 },
  ],
  volume: [
    { unit: 'gal', transform: v => v * 264.172, digits: 1 },
    { unit: 'L',   transform: v => v * 1000,    digits: 0 },
  ],
};

// Maps SignalK paths to a UNIT_GROUPS key for sparkline display config.
const PATH_TO_UNIT_GROUP = {
  'navigation.speedOverGround':      'speed',
  'navigation.speedThroughWater':    'speed',
  'environment.wind.speedTrue':      'speed',
  'environment.wind.speedApparent':  'speed',
  'navigation.trip.log':             'distance',
  'navigation.log':                  'distance',
  'environment.water.temperature':   'temperature',
  'environment.inside.temperature':  'temperature',
  'environment.inside.pressure':     'pressure',
  'navigation.anchor.currentRadius': 'length',
  'navigation.attitude.roll':        'angle',
  'navigation.attitude.pitch':       'angle',
  'navigation.courseOverGroundTrue': 'angle',
  'navigation.headingMagnetic':      'angle',
  'navigation.magneticVariation':    'angle',
  'steering.rudderAngle':            'angle',
  'environment.wind.angleTrue':      'angle',
  'environment.wind.angleApparent':     'angle',
  'propulsion.port.revolutions':        'rotation',
  'environment.wind.oneMinute.gustTrue':   'speed',
  'environment.wind.fiveMinutes.gustTrue': 'speed',
  'environment.wind.oneHour.gustTrue':     'speed',
  'environment.rpi.gpu.temperature':       'temperature',
  'environment.rpi.cpu.temperature':       'temperature',
};

// Persisted unit preferences: { groupName: cycleIndex }
const UNIT_PREFS_KEY = 'unitPrefs_v2'; // bump when UNIT_GROUPS defaults change
const unitPrefs = (() => {
  try { return JSON.parse(localStorage.getItem(UNIT_PREFS_KEY) || '{}'); }
  catch { return {}; }
})();

const getUnitCfg = (group) =>
  UNIT_GROUPS[group][(unitPrefs[group] || 0) % UNIT_GROUPS[group].length];

// Format a raw SI value using the active unit preference for a group.
const fmtUnit = (group, rawSI) => {
  if (rawSI == null || !Number.isFinite(rawSI)) return 'N/A';
  const { transform, unit, digits } = getUnitCfg(group);
  return `${transform(rawSI).toFixed(digits)}\u00a0${unit}`;
};

const hasValidCoordinates = (latitude, longitude) =>
  Number.isFinite(latitude) && Number.isFinite(longitude);

function resolveTidePosition(currentLat, currentLon) {
  if (hasValidCoordinates(currentLat, currentLon)) {
    return {
      lat: currentLat,
      lon: currentLon,
      usingFallback: false,
      label: 'current position',
    };
  }

  const fallbackFromVessel = vesselData?.default_location;
  if (
    fallbackFromVessel &&
    hasValidCoordinates(fallbackFromVessel.lat, fallbackFromVessel.lon)
  ) {
    return {
      lat: fallbackFromVessel.lat,
      lon: fallbackFromVessel.lon,
      usingFallback: true,
      label: fallbackFromVessel.label || 'default vessel location',
    };
  }

  return {
    ...DEFAULT_TIDE_LOCATION,
    usingFallback: true,
    label: DEFAULT_TIDE_LOCATION.label,
  };
}

// ── Voyage statistics ────────────────────────────────────────────────────────

async function loadVoyageStats() {
  const panel = document.getElementById('voyage-stats-panel');
  if (!panel) return;

  try {
    const resp = await fetch(`${C.TRACKS_INDEX_URL}?ts=${Date.now()}`);
    if (!resp.ok) { panel.style.display = 'none'; return; }
    const data = await resp.json();
    const tracks = Array.isArray(data) ? data : (data.tracks ?? []);
    if (!tracks.length) { panel.style.display = 'none'; return; }

    const totalDays     = tracks.length;
    const totalNm       = tracks.reduce((s, t) => s + (t.distance_nm  ?? 0), 0);
    const totalHours    = tracks.reduce((s, t) => s + (t.duration_hours ?? 0), 0);
    const maxSpeed      = tracks.reduce((m, t) => Math.max(m, t.max_speed_kts ?? 0), 0);
    const firstDate     = tracks[0]?.date ?? '';
    const lastDate      = tracks[tracks.length - 1]?.date ?? '';

    const fmt = (d) => d ? new Date(`${d}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

    const grid = document.getElementById('voyage-stats-grid');
    if (!grid) return;

    grid.innerHTML = [
      { label: 'Sailing Days',   value: totalDays },
      { label: 'Total Distance', value: `${totalNm.toFixed(1)} nm` },
      { label: 'Total Underway', value: `${totalHours.toFixed(1)} hr` },
      { label: 'Top Speed',      value: `${maxSpeed.toFixed(1)} kts` },
      { label: 'First Sail',     value: fmt(firstDate) },
      { label: 'Last Sail',      value: fmt(lastDate) },
    ].map(({ label, value }) => `
      <div class="info-item">
        <div class="label">${label}</div>
        <div class="value">${value}</div>
      </div>`).join('');

    panel.style.display = '';
  } catch (e) {
    console.warn('Voyage stats unavailable:', e);
    panel.style.display = 'none';
  }
}

// Load vessel information from YAML file
async function loadVesselData() {
  try {
    const response = await fetch('data/vessel/info.yaml');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const yamlText = await response.text();

    // Parse YAML using js-yaml library
    if (typeof jsyaml === 'undefined') {
      throw new Error('js-yaml library not loaded');
    }
    vesselData = jsyaml.load(yamlText);

    // Add default_location if not present
    if (!vesselData.default_location) {
      vesselData.default_location = {
        lat:   C.DEFAULT_TIDE_LAT,
        lon:   C.DEFAULT_TIDE_LON,
        label: C.DEFAULT_TIDE_LABEL,
      };
    }

    console.log('Vessel data loaded:', vesselData);
    updateVesselLinks();
  } catch (error) {
    console.error('Error loading vessel data:', error);
    // Set default values if loading fails
    vesselData = {
      name: "S.V.Mermug",
      mmsi: "338543654",
      uscg_number: "1024168",
      hull_number: "BEY57004E494",
      default_location: {
        lat:   C.DEFAULT_TIDE_LAT,
        lon:   C.DEFAULT_TIDE_LON,
        label: C.DEFAULT_TIDE_LABEL,
      },
    };
    updateVesselLinks();
  }
}

// Load tide stations information from JSON file
async function loadTideStations() {
  try {
    const response = await fetch('data/tide_stations.json');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    tideStations = await response.json();
    console.log('Tide stations data loaded:', tideStations);
  } catch (error) {
    console.error('Error loading tide stations data:', error);
    // Set default values if loading fails
    tideStations = {
      stations: [
        { id: "9414290", name: "San Francisco", lat: 37.806, lon: -122.465 }
      ]
    };
  }
}

// Update vessel links with data from JSON
function updateVesselLinks() {
  if (!vesselData) return;

  // Update page title and dynamic references
  if (vesselData.name) {
    const pageTitle = document.getElementById('page-title');
    if (pageTitle) {
      pageTitle.textContent = `${vesselData.name} Tracker`;
    }

    const statusVessel = document.getElementById('status-vessel');
    if (statusVessel) {
      statusVessel.textContent = vesselData.name;
    }

    // Update document title
    document.title = `${vesselData.name} Tracker`;

    // Update logo alt text
    const logoImg = document.querySelector('img[src="data/vessel/logo.png"]');
    if (logoImg) {
      logoImg.alt = `${vesselData.name} Logo`;
    }

  }

  // Render passage banner if a current passage is configured
  const passage = vesselData.passage;
  const passageBanner = document.getElementById('passage-banner');
  if (passageBanner) {
    if (passage?.from && passage?.to) {
      let text = `${passage.from} → ${passage.to}`;
      if (passage.departed) {
        const d = new Date(`${passage.departed}T12:00:00`);
        text += ` · Departed ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
      }
      passageBanner.textContent = text;
      passageBanner.style.display = 'block';
    } else {
      passageBanner.style.display = 'none';
    }
  }

  // Construct SignalK URLs from base configuration
  const signalk = vesselData.signalk;
  if (signalk?.host && signalk?.port && signalk?.protocol) {
    const baseUrl = `${signalk.protocol}://${signalk.host}:${signalk.port}`;
    const wsUrl = `wss://${signalk.host}:${signalk.port}`;

    // Store constructed URLs for use in other functions
    vesselData.signalk.base_url = baseUrl;
    vesselData.signalk.admin_url = `${baseUrl}/admin/#/webapps`;
    vesselData.signalk.freeboard_url = `${baseUrl}/@signalk/freeboard-sk`;
    vesselData.signalk.api_url = `${baseUrl}/signalk/v1/api/vessels/self`;
    vesselData.signalk.websocket_url = `${wsUrl}/signalk/v1/stream`;
  }

  // Construct external tracking links
  vesselData.links = vesselData.links || {};
  if (vesselData.marinetraffic_ship_id) {
    vesselData.links.marinetraffic = `https://www.marinetraffic.com/en/ais/details/ships/shipid:${vesselData.marinetraffic_ship_id}`;
  }
  if (vesselData.postgsail_logs_url) {
    vesselData.links.postgsail = vesselData.postgsail_logs_url;
  }

  // Update the link cluster in the tab bar
  const marinetrafficLink = document.getElementById('marinetraffic-link');
  if (marinetrafficLink && vesselData.links?.marinetraffic) {
    marinetrafficLink.href = vesselData.links.marinetraffic;
  }

  const postgsailLink = document.getElementById('postgsail-link');
  if (postgsailLink && vesselData.links?.postgsail) {
    postgsailLink.href = vesselData.links.postgsail;
    postgsailLink.style.display = '';
  }
}
let themeChangeTimeout = null; // Timeout for theme change debouncing
let isThemeChanging = false; // Flag to prevent multiple theme changes

// Find nearest NOAA tide station from lat/lon
// Uses local lookup table (fast and reliable)
// Prioritizes known-working stations for certain areas
async function findNearestNOAAStation(lat, lon) {
  const stations = getAllStations();
  if (!stations || stations.length === 0) {
    throw new Error('No tide stations available in lookup table');
  }

  // For San Francisco Bay area, prefer San Francisco station (9414290) which reliably supports predictions
  // South Beach Harbor and most SF locations should use SF station
  const isSFBayArea = lat >= 37.7 && lat <= 37.9 && lon >= -122.5 && lon <= -122.3;
  if (isSFBayArea) {
    const sfStation = stations.find(s => s.id === '9414290');
    if (sfStation) {
      console.debug('SF Bay area detected, preferring San Francisco station');
      return sfStation;
    }
  }

  // For other areas, find nearest station using haversine distance
  const nearest = stations.reduce((a, b) =>
    haversine(lat, lon, a.lat, a.lon) < haversine(lat, lon, b.lat, b.lon) ? a : b
  );

  return nearest;
}

async function drawTideGraph(lat, lon, tidePositionMeta = {}) {
  const {
    usingFallback = false,
    label: fallbackLabel = 'default location',
  } = tidePositionMeta;

  // Find nearest station using NOAA Metadata API
  let nearest;
  try {
    nearest = await findNearestNOAAStation(lat, lon);
  } catch (error) {
    console.error('Error finding nearest station:', error);
    const tideHeader = document.getElementById("tideHeader");
    if (tideHeader) tideHeader.textContent = "Tides unavailable (error finding station)";
    return;
  }

  // Calculate distance in nautical miles
  const distKm = haversine(lat, lon, nearest.lat, nearest.lon);
  const distNm = (distKm / 1.852).toFixed(1);

  // Update title element above the chart
  const locationDescriptor = usingFallback ? fallbackLabel : 'current position';
  const fallbackSuffix = usingFallback ? ' — waiting for live GPS data' : '';
  document.getElementById("tideHeader").textContent =
    `Tides near ${nearest.name} (Station #${nearest.id} - ${distNm} NM from ${locationDescriptor})${fallbackSuffix}`;


  const now = new Date();
  // NOAA predictions are future-only, so start from current time
  const startTime = new Date(now.getTime());
  const endTime = new Date(now.getTime() + 30 * 60 * 60 * 1000); // 30 hours forward


  // NOAA expects YYYYMMDD for begin_date/end_date
  function fmtYYYYMMDD(d) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const da = String(d.getUTCDate()).padStart(2, '0');
    return `${y}${m}${da}`;
  }
  const begin = fmtYYYYMMDD(startTime);
  const end = fmtYYYYMMDD(endTime);

  // Build NOAA API URL according to official documentation
  // https://api.tidesandcurrents.noaa.gov/api/prod/
  const buildUrl = (stationId) => {
    const params = new URLSearchParams({
      product: 'predictions',
      application: 'vessel-tracker',
      begin_date: begin,
      end_date: end,
      datum: 'MLLW',
      station: stationId,
      time_zone: 'gmt',
      units: 'english',
      interval: 'h',
      format: 'json'
    });
    return `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?${params.toString()}`;
  };

  let targetStation = nearest;
  let url = buildUrl(targetStation.id);
  const fallbackStation = { id: '9414290', name: 'San Francisco', lat: 37.806, lon: -122.465 };
  let attemptedFallback = false;
  const tideCacheKey = `tide_${targetStation.id}_${begin}`;

  try {
    let res;
    // Serve from cache if fresh — tide predictions don't change within a day
    let json = (() => { const c = getCached(tideCacheKey, C.TIDE_CACHE_TTL_MS); return c ? { predictions: c } : null; })();

    // Try primary station (skipped when cache hit)
    if (!json) console.debug('Tide fetch: attempting station', {
      id: targetStation.id, name: targetStation.name,
      lat: targetStation.lat, lon: targetStation.lon,
      url, begin_date: begin, end_date: end
    });
    if (!json) try {
      res = await fetch(url);
      if (res.ok) {
        json = await res.json();
        // Check for NOAA API error in response (they sometimes return 200 with error object)
        if (json.error) {
          throw new Error(json.error.message || JSON.stringify(json.error));
        }
      } else {
        // Try to get error details from response body
        let errorDetails = res.statusText;
        try {
          const errorBody = await res.text();
          if (errorBody) {
            try {
              const errorJson = JSON.parse(errorBody);
              errorDetails = errorJson.error?.message || errorJson.message || errorBody;
            } catch {
              errorDetails = errorBody;
            }
          }
        } catch {
          // Ignore errors parsing error response
        }
        throw new Error(`HTTP ${res.status}: ${errorDetails}`);
      }
    } catch (error) {
      // If primary station fails, try fallback (San Francisco is known to work)
      if (!attemptedFallback && targetStation.id !== fallbackStation.id) {
        console.warn('Primary station failed, retrying with fallback 9414290 (San Francisco)', error);
        attemptedFallback = true;
        targetStation = fallbackStation;
        url = buildUrl(fallbackStation.id);
        console.debug('Tide fetch: attempting fallback station', {
          id: targetStation.id,
          name: targetStation.name,
          url
        });

        try {
          res = await fetch(url);
          if (res.ok) {
            json = await res.json();
            // Check for NOAA API error in response
            if (json.error) {
              throw new Error(json.error.message || JSON.stringify(json.error));
            }
          } else {
            // Try to get error details from response body
            let errorDetails = res.statusText;
            try {
              const errorBody = await res.text();
              if (errorBody) {
                try {
                  const errorJson = JSON.parse(errorBody);
                  errorDetails = errorJson.error?.message || errorJson.message || errorBody;
                } catch {
                  errorDetails = errorBody;
                }
              }
            } catch {
              // Ignore errors parsing error response
            }
            throw new Error(`NOAA API ${res.status}: ${errorDetails}`);
          }
        } catch (retryError) {
          throw new Error(`Failed to fetch tide data: ${retryError.message || 'Network error'}`);
        }
      } else {
        // Already tried fallback or it was the fallback, re-throw
        throw error;
      }
    }
    const rawData = Array.isArray(json?.predictions) ? json.predictions : [];
    if (rawData.length > 0) setCached(tideCacheKey, rawData);
    if (rawData.length === 0) {
      console.warn('No tide predictions returned from NOAA for station', {
        id: targetStation.id,
        name: targetStation.name,
        lat: targetStation.lat,
        lon: targetStation.lon,
        url
      });
      const tideHeader = document.getElementById("tideHeader");
      if (tideHeader) tideHeader.textContent = `Tides in ${targetStation.name} (no predictions available)`;
      return;
    }

    const data = rawData
      .map(d => ({ t: new Date(d.t), v: parseFloat(d.v) }))
      .filter(d => d.t >= startTime && d.t <= endTime);


    const labels = data.map(d =>
    new Date(d.t.getTime() - d.t.getTimezoneOffset() * 60000)
      .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  );
    const heights = data.map(d => d.v);

    const peaks = [];
    for (let i = 1; i < heights.length - 1; i++) {
      if ((heights[i] > heights[i - 1] && heights[i] > heights[i + 1]) ||
          (heights[i] < heights[i - 1] && heights[i] < heights[i + 1])) {
        peaks.push({ i, value: heights[i], time: labels[i] });
      }
    }

    // Find the current tide height (closest time to now)
    const nowUTC = new Date(Date.now() + new Date().getTimezoneOffset() * 60000);

    let currentIndex = 0;
    let minDiff = Infinity;
    data.forEach((d, i) => {
      const diff = Math.abs(d.t - nowUTC);
      if (diff < minDiff) {
        minDiff = diff;
        currentIndex = i;
      }
    });

    const canvas = document.getElementById('tideChart');
    canvas.height = 250;
    const ctx = canvas.getContext('2d');

    if (tideChartInstance) {
      tideChartInstance.destroy();
    }

    const isDark = isDarkTheme(document.documentElement.getAttribute('data-theme'));

    tideChartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: `Tide Height (${targetStation.name})`,
            data: heights,
            borderColor: isDark ? '#60a5fa' : '#2563eb',
            backgroundColor: isDark ? 'rgba(96,165,250,0.12)' : 'rgba(37,99,235,0.1)',
            fill: true,
            tension: 0.4,
            pointRadius: 0
          },
          {
            label: 'Now',
            data: heights.map((v, i) => (i === currentIndex ? v : null)),
            borderColor: 'transparent',
            backgroundColor: '#e74c3c',
            pointRadius: 5,
            pointHoverRadius: 6,
            type: 'line',
            fill: false
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { left: 10 } },
        plugins: {
          tooltip: {
            mode: 'index',
            intersect: false,
            callbacks: {
              title: ctx => `Time: ${ctx[0].label}`,
              label: ctx => `Height: ${ctx.raw} ft`
            }
          },
          legend: { display: false },
          annotation: {
            annotations: peaks.map(p => ({
              type: 'label',
              xValue: labels[p.i],
              yValue: p.value,
              content: `${p.value.toFixed(1)} ft @ ${p.time}`,
              backgroundColor: isDark ? 'rgba(96,165,250,0.9)' : 'rgba(37,99,235,0.85)',
              color: '#ffffff',
              yAdjust: -20,
              position: 'center',
              borderColor: isDark ? '#60a5fa' : '#2563eb',
              borderWidth: 1
            }))
          }
        },
        scales: {
          x: {
            grid: {
              color: isDark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.08)'
            },
            ticks: {
              color: isDark ? '#ffffff' : '#2c3e50'
            },
            title: {
              display: true,
              text: `Tides as of ${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`,
              color: isDark ? '#ffffff' : '#2c3e50'
            }
          },
          y: {
            grid: {
              color: isDark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.08)'
            },
            ticks: {
              color: isDark ? '#ffffff' : '#2c3e50'
            },
            title: {
              display: true,
              text: "Tide Height (ft)",
              color: isDark ? '#ffffff' : '#2c3e50'
            },
            // 2 ft of headroom either side so the peak/trough annotation
            // labels have somewhere to sit without clipping.
            min: Math.min(...heights) - 2,
            max: Math.max(...heights) + 2
          }
        }
      },
      plugins: [Chart.registry.getPlugin('annotation')]
    });
  } catch (err) {
    console.error("Tide data fetch error:", err);
  }
}

async function loadData() {

  function findLatestTimestamp(obj) {
    let latest = null;

    function search(o) {
      if (o && typeof o === "object") {
        for (const key in o) {
          if (key === "timestamp" && typeof o[key] === "string") {
            const t = new Date(o[key]);
            if (!isNaN(t.getTime()) && (!latest || t > latest)) {
              latest = t;
            }
          } else if (typeof o[key] === "object") {
            search(o[key]);
          }
        }
      }
    }

    search(obj);
    return latest;
  }
  const formatTimestamp = (value) => {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleString();
  };

  const withUpdated = (description, node) => {
    const formatted = formatTimestamp(node?.timestamp);
    return formatted ? `${description}\nLast updated: ${formatted}` : description;
  };

  const withUpdatedNodes = (description, ...nodes) => {
    for (const node of nodes) {
      const formatted = formatTimestamp(node?.timestamp);
      if (formatted) {
        return `${description}\nLast updated: ${formatted}`;
      }
    }
    return description;
  };

  // Build a Map<path, [{t, v}]> from instrument_log.json entries.
  // Each entry is {timestamp, values: {path: number}}.
  const buildSeriesFromLog = (entries) => {
    const map = new Map();
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const date = entry.timestamp ? new Date(entry.timestamp) : null;
      if (!date || Number.isNaN(date.getTime())) continue;
      const values = entry.values;
      if (!values || typeof values !== 'object') continue;
      for (const [path, value] of Object.entries(values)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        const list = map.get(path) || [];
        list.push({ t: date, v: value });
        map.set(path, list);
      }
    }
    for (const list of map.values()) list.sort((a, b) => a.t - b.t);
    return map;
  };

  const loadSeries = async () => {
    if (seriesByPath) return seriesByPath;
    if (seriesPromise) return seriesPromise;
    seriesPromise = fetch(`${C.INSTRUMENT_LOG_URL}?ts=${Date.now()}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((payload) => {
        const entries = Array.isArray(payload?.entries) ? payload.entries : [];
        const recent = entries.slice(-SPARKLINE_POINTS);
        seriesByPath = buildSeriesFromLog(recent);
        return seriesByPath;
      })
      .catch(() => {
        seriesByPath = new Map();
        return seriesByPath;
      });
    return seriesPromise;
  };

  // Unit conversion config keyed by SignalK path.
  // transform: converts raw SI value to display value; unit: label shown next to min/max.
  const PATH_DISPLAY_CONFIG = {
    'navigation.speedOverGround':                        { transform: v => v * 1.94384,                    unit: 'kts'   },
    'navigation.speedThroughWater':                      { transform: v => v * 1.94384,                    unit: 'kts'   },
    'navigation.trip.log':                               { transform: v => v / 1852,                       unit: 'nm'    },
    'navigation.log':                                    { transform: v => v / 1852,                       unit: 'nm'    },
    'navigation.attitude.roll':                          { transform: v => v * 180 / Math.PI,              unit: '°'     },
    'navigation.attitude.pitch':                         { transform: v => v * 180 / Math.PI,              unit: '°'     },
    'navigation.courseOverGroundTrue':                   { transform: v => v * 180 / Math.PI,              unit: '°'     },
    'navigation.headingMagnetic':                        { transform: v => v * 180 / Math.PI,              unit: '°'     },
    'navigation.magneticVariation':                      { transform: v => v * 180 / Math.PI,              unit: '°'     },
    'navigation.anchor.currentRadius':                   { transform: v => v * 3.28084,                    unit: 'ft'    },
    'navigation.anchor.bearingTrue':                     { transform: v => v * 180 / Math.PI,              unit: '°'     },
    'steering.rudderAngle':                              { transform: v => v * 180 / Math.PI,              unit: '°'     },
    'environment.wind.speedTrue':                        { transform: v => v * 1.94384,                    unit: 'kts'   },
    'environment.wind.angleTrue':                        { transform: v => v * 180 / Math.PI,              unit: '°'     },
    'environment.wind.angleApparent':                    { transform: v => v * 180 / Math.PI,              unit: '°'     },
    'environment.wind.speedApparent':                    { transform: v => v * 1.94384,                    unit: 'kts'   },
    'electrical.batteries.house.voltage':                { transform: v => v,                              unit: 'V'     },
    'electrical.batteries.house.current':                { transform: v => v,                              unit: 'A'     },
    'electrical.batteries.house.power':                  { transform: v => v,                              unit: 'W'     },
    'electrical.batteries.house.capacity.stateOfCharge': { transform: v => v * 100,                        unit: '%'     },
    'electrical.batteries.house.capacity.timeRemaining': { transform: v => v / 3600,                       unit: 'hrs'   },
    'environment.water.temperature':                     { transform: v => (v - 273.15) * 9/5 + 32,       unit: '°F'    },
    'environment.inside.temperature':                    { transform: v => (v - 273.15) * 9/5 + 32,       unit: '°F'    },
    'environment.inside.humidity':                       { transform: v => v * 100,                        unit: '%'     },
    'environment.inside.pressure':                       { transform: v => v / 100,                        unit: 'mbar'  },
    'environment.inside.airQuality.tvoc':                { transform: v => v,                              unit: 'ppb'   },
    'environment.inside.airQuality.eco2':                { transform: v => v,                              unit: 'ppm'   },
    'internet.speed.download':                           { transform: v => v,                              unit: 'Mbps'  },
    'internet.speed.upload':                             { transform: v => v,                              unit: 'Mbps'  },
    'internet.ping.latency':                             { transform: v => v,                              unit: 'ms'    },
    'internet.ping.jitter':                              { transform: v => v,                              unit: 'ms'    },
    'internet.packetLoss':                               { transform: v => v <= 1 ? v * 100 : v,          unit: '%'     },
    'propulsion.port.revolutions':                       { transform: v => v * 60,                         unit: 'RPM'   },
    'tanks.fuel.0.currentLevel':                         { transform: v => v * 100,                        unit: '%'     },
    'tanks.fuel.reserve.currentLevel':                   { transform: v => v * 100,                        unit: '%'     },
    'tanks.freshWater.0.currentLevel':                   { transform: v => v * 100,                        unit: '%'     },
    'tanks.freshWater.1.currentLevel':                   { transform: v => v * 100,                        unit: '%'     },
    'tanks.propane.a.currentLevel':                      { transform: v => v * 100,                        unit: '%'     },
    'tanks.propane.b.currentLevel':                      { transform: v => v * 100,                        unit: '%'     },
    'tanks.blackwater.bow.currentLevel':                 { transform: v => v * 100,                        unit: '%'     },
    'tanks.liveWell.0.currentLevel':                     { transform: v => v * 100,                        unit: '%'     },
    'electrical.solar.bimini.panelPower':                { transform: v => v,                              unit: 'W'     },
    'electrical.solar.bimini.current':                   { transform: v => v,                              unit: 'A'     },
    'electrical.solar.bimini.voltage':                   { transform: v => v,                              unit: 'V'     },
    'electrical.solar.bimini.yieldToday':                { transform: v => v / 3600,                       unit: 'Wh'    },
    'electrical.batteries.house.capacity.dischargeSinceFull': { transform: v => v / 3600,                  unit: 'Ah'    },
    'environment.wind.oneMinute.gustTrue':               { transform: v => v * 1.94384,                    unit: 'kts'   },
    'environment.wind.fiveMinutes.gustTrue':             { transform: v => v * 1.94384,                    unit: 'kts'   },
    'environment.wind.oneHour.gustTrue':                 { transform: v => v * 1.94384,                    unit: 'kts'   },
    'environment.rpi.gpu.temperature':                   { transform: v => (v - 273.15) * 9/5 + 32,       unit: '°F'    },
    'environment.rpi.cpu.temperature':                   { transform: v => (v - 273.15) * 9/5 + 32,       unit: '°F'    },
    'environment.rpi.cpu.utilisation':                   { transform: v => v * 100,                        unit: '%'     },
    'environment.rpi.memory.utilisation':                { transform: v => v * 100,                        unit: '%'     },
    'environment.rpi.sd.utilisation':                    { transform: v => v * 100,                        unit: '%'     },
  };

  const renderSparkline = (canvas, points, displayConfig = {}, colors = {}) => {
    const { transform = v => v, unit = '' } = displayConfig;
    const {
      line: lineColor     = 'rgba(255, 255, 255, 0.85)',
      axis: axisColor     = 'rgba(255, 255, 255, 0.25)',
      label: labelColor   = 'rgba(255, 255, 255, 0.6)',
      noData: noDataColor = 'rgba(255, 255, 255, 0.5)',
    } = colors;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!points || points.length < 2) {
      ctx.fillStyle = noDataColor;
      ctx.font = '10px system-ui,-apple-system,sans-serif';
      ctx.fillText('No data', 6, canvas.height / 2 + 4);
      return;
    }
    const formatValue = (value) => {
      if (!Number.isFinite(value)) return '';
      const abs = Math.abs(value);
      if (abs >= 1000) return `${(value / 1000).toFixed(1)}k`;
      if (abs >= 100 || abs === 0) return value.toFixed(0);
      if (abs >= 10) return value.toFixed(1);
      return value.toFixed(2);
    };
    const formatTime = (date) =>
      date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

    const rawValues = points.map((p) => p.v);
    const displayValues = rawValues.map(transform);
    const min = Math.min(...displayValues);
    const max = Math.max(...displayValues);
    const rawMin = Math.min(...rawValues);
    const rawMax = Math.max(...rawValues);
    const rawRange = rawMax - rawMin || 1;

    const padding = { top: 8, right: 8, bottom: 20, left: 34 };
    const w = canvas.width - padding.left - padding.right;
    const h = canvas.height - padding.top - padding.bottom;
    const axisX = canvas.height - padding.bottom;
    const axisY = padding.left;

    // Axes
    ctx.strokeStyle = axisColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(axisY, padding.top);
    ctx.lineTo(axisY, axisX);
    ctx.lineTo(canvas.width - padding.right, axisX);
    ctx.stroke();

    // Y-axis labels (right-aligned into left padding, no unit to save space)
    ctx.fillStyle = labelColor;
    ctx.font = '10px system-ui,-apple-system,sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(`${formatValue(max)}${unit}`, axisY - 2, padding.top);
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${formatValue(min)}${unit}`, axisY - 2, axisX);

    // X-axis time ticks (4 labels: start, ⅓, ⅔, end)
    const tFirst = points[0].t.getTime();
    const tLast  = points[points.length - 1].t.getTime();
    const numTicks = 3;
    ctx.font = '10px system-ui,-apple-system,sans-serif';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= numTicks; i++) {
      const ratio = i / numTicks;
      const x = padding.left + ratio * w;
      const tickDate = new Date(tFirst + ratio * (tLast - tFirst));
      ctx.textAlign = i === 0 ? 'left' : i === numTicks ? 'right' : 'center';
      ctx.fillText(formatTime(tickDate), x, axisX + 3);
      // tick mark
      ctx.strokeStyle = axisColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, axisX);
      ctx.lineTo(x, axisX + 3);
      ctx.stroke();
    }

    // Data line
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((point, index) => {
      const x = padding.left + (index / (points.length - 1)) * w;
      const y = padding.top + (1 - (point.v - rawMin) / rawRange) * h;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  };

  /**
   * Render small inline sparkline charts directly inside each .info-item card.
   * Safe to call multiple times — re-renders existing canvases in place.
   * Also exposed as module-level refreshSparklines for the theme toggle.
   */
  const SPARKLINE_HEIGHT = 80;

  // Parse a computed rgb()/rgba() color string and return [r, g, b].
  const parseRgb = (str) => {
    const m = str.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : null;
  };

  const initInlineSparklines = async () => {
    const isDark = isDarkTheme(document.documentElement.getAttribute('data-theme'));
    const baseColors = {
      axis:   isDark ? 'rgba(255, 255, 255, 0.22)' : 'rgba(0, 0, 0, 0.20)',
      label:  isDark ? 'rgba(255, 255, 255, 0.60)' : 'rgba(0, 0, 0, 0.55)',
      noData: isDark ? 'rgba(255, 255, 255, 0.35)' : 'rgba(0, 0, 0, 0.30)',
    };
    // Fallback line color if we can't read the panel accent.
    const fallbackLine = isDark ? 'rgba(96, 165, 250, 0.95)' : 'rgba(37, 99, 235, 0.85)';

    const seriesMap = await loadSeries();
    if (!seriesMap || !seriesMap.size) return;

    // Render a canvas per info-item.
    document.querySelectorAll('.info-item[data-path]').forEach((item) => {
      const path = item.dataset.path;
      const list = seriesMap.get(path);
      if (!list || !list.length) return;

      let canvas = item.querySelector('.sparkline-inline');
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.className = 'sparkline-inline';
        canvas.height = SPARKLINE_HEIGHT;
        canvas.style.display = 'none'; // hidden by default
        item.appendChild(canvas);
      }
      canvas.width = item.clientWidth || 120;
      canvas.height = SPARKLINE_HEIGHT;

      // Derive line color from the parent panel's left-border accent.
      let lineColor = fallbackLine;
      const panel = item.closest('.info-panel');
      if (panel) {
        const rgb = parseRgb(getComputedStyle(panel).borderLeftColor);
        if (rgb) lineColor = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${isDark ? 0.95 : 0.85})`;
      }

      const points = list.slice(-SPARKLINE_POINTS);
      const grp = PATH_TO_UNIT_GROUP[path];
      const displayCfg = grp
        ? { transform: getUnitCfg(grp).transform, unit: getUnitCfg(grp).unit }
        : (PATH_DISPLAY_CONFIG[path] || {});
      renderSparkline(canvas, points, displayCfg, { ...baseColors, line: lineColor });
    });

    // Add a toggle button to each panel that has at least one sparkline canvas.
    document.querySelectorAll('.info-panel').forEach((panel) => {
      const sparklines = panel.querySelectorAll('.sparkline-inline');
      if (!sparklines.length) return;

      // Don't add a second button on re-render.
      if (panel.querySelector('.sparkline-toggle-btn')) return;

      // The header is always the first direct child div of the panel.
      const header = panel.querySelector(':scope > div:first-child');
      if (!header) return;

      const btn = document.createElement('button');
      btn.className = 'sparkline-toggle-btn';
      btn.textContent = 'Show History';
      btn.dataset.open = 'false';

      // Make the header a flex row so the button sits on the right.
      header.style.display = 'flex';
      header.style.justifyContent = 'space-between';
      header.style.alignItems = 'center';
      header.appendChild(btn);

      btn.addEventListener('click', () => {
        const opening = btn.dataset.open === 'false';
        panel.querySelectorAll('.sparkline-inline').forEach((c) => {
          c.style.display = opening ? 'block' : 'none';
        });
        btn.dataset.open = opening ? 'true' : 'false';
        btn.textContent = opening ? 'Hide History' : 'Show History';
      });
    });
  };

  // Expose so theme toggle can re-render sparklines with updated colors.
  refreshSparklines = initInlineSparklines;

  try {
    console.log('Starting to load data...');
    initInlineSparklines(); // kick off async — renders once series data loads

    // Load data from local file
    let res;
    let data;
    let dataSource = 'static';

    try {
      // Local file only
      console.log('Attempting to fetch signalk_latest.json...');
      res = await fetch('data/telemetry/signalk_latest.json');
      console.log('Local file fetch response:', res.status, res.statusText);
      if (res.ok) {
        data = await res.json();
        dataSource = 'static';
        console.log('Local JSON file data loaded successfully');
      } else {
        throw new Error(`Local file not available: ${res.status} ${res.statusText}`);
      }
    } catch (fileError) {
      console.log('Local file fetch error:', fileError);
      console.log('Local file unavailable, creating dummy data...');

      // Create dummy data as fallback
      console.log('Creating dummy data as fallback...');
      data = {
        navigation: {
          position: { value: { latitude: 37.806, longitude: -122.465 } },
          courseOverGroundTrue: { value: 0 },
          speedOverGround: { value: 0 },
          speedThroughWater: { value: 0 }
        },
        environment: {
          wind: {
            speedTrue: { value: 10 },
            angleTrue: { value: 0 }
          },
          water: { temperature: { value: 288.15 } }
        },
        electrical: {
          batteries: {
            house: {
              voltage: { value: 12.5 },
              current: { value: 0 },
              power: { value: 0 },
              capacity: {
                stateOfCharge: { value: 0.8 },
                timeRemaining: { value: 36000 }
              }
            }
          }
        }
      };
      dataSource = 'dummy';
      console.log('Dummy data created successfully');
    }

    console.log('Fetch response status:', res?.status);
    setRawDataPre('raw-signalk-latest', data);
    const nav = data.navigation || {};
    const elec = data.electrical || {};
    const env = data.environment || {};
    const entertainment = data.entertainment || {};
    const internet = data.internet || {};

    const signalkName = data.name;
    const signalkMmsi = data.mmsi;
    if (signalkName || signalkMmsi) {
      vesselData = vesselData || {};
      if (signalkName) vesselData.name = signalkName;
      if (signalkMmsi) vesselData.mmsi = signalkMmsi;
      updateVesselLinks();
    }

    // Store globally for polar performance calculations
    currentNav = nav;
    currentEnv = env;
    currentPropulsion = data.propulsion?.port || {};

    // Compute vessel state from SOG and anchor watch
    const sogKts = (nav?.speedOverGround?.value ?? 0) * 1.94384;
    const anchorSet = !!(nav?.anchor?.position?.value && nav?.anchor?.maxRadius?.value > 0);
    if (sogKts > 0.5) {
      vesselState = 'underway';
    } else if (anchorSet) {
      vesselState = 'at anchor';
    } else {
      vesselState = '';
    }

    // Update status hero age / staleness
    const statusHero = document.getElementById('status-hero');
    const ageEl = document.getElementById('status-age');

    const formatAge = (ms) => {
      const s = Math.floor(ms / 1000);
      if (s < 60)  return 'just now';
      const m = Math.floor(s / 60);
      if (m < 60)  return `${m} min ago`;
      const h = Math.floor(m / 60);
      if (h < 24)  return `${h} hr${h === 1 ? '' : 's'} ago`;
      const d = Math.floor(h / 24);
      return `${d} day${d === 1 ? '' : 's'} ago`;
    };

    // Try specific field first, fall back to recursive scan
    let timestampStr = data.navigation?.position?.timestamp;
    let modifiedDate = timestampStr ? new Date(timestampStr) : findLatestTimestamp(data);

    if (dataSource === 'dummy') {
      bannerState = 'error';
      if (ageEl) ageEl.textContent = 'Demo data';
      if (statusHero) statusHero.classList.add('stale');
    } else if (modifiedDate && !isNaN(modifiedDate.getTime())) {
      const diffMs    = Date.now() - modifiedDate;
      const diffHours = diffMs / (1000 * 60 * 60);
      const ageLabel  = formatAge(diffMs);
      if (ageEl) ageEl.textContent = `Updated ${ageLabel}`;
      if (diffHours > 6) {
        bannerState = 'error';
        if (statusHero) statusHero.classList.add('stale');
      } else {
        bannerState = 'ok';
        if (statusHero) statusHero.classList.remove('stale');
      }
    } else {
      bannerState = 'error';
      if (ageEl) ageEl.textContent = 'Update time unknown';
      if (statusHero) statusHero.classList.add('stale');
    }

    lat = nav.position?.value?.latitude;
    lon = nav.position?.value?.longitude;
    const hasGpsFix = hasValidCoordinates(lat, lon);

    if (hasGpsFix) {
      if (!map) {
        map = L.map('map').setView([lat, lon], 13);
        window.mermugMap = map; // exposed for tabs.js to call invalidateSize() on tab switch
        tileLayerForTheme().addTo(map);
        marker = L.marker([lat, lon]).addTo(map);

        // Privacy exclusion zone indicator — mirrors PRIVACY_EXCLUSION_ZONES in Python.
        // Positions inside this ring are redacted from all stored data.
        L.circle([37.7802069, -122.3858040], {
          radius: 200,
          color: '#e74c3c',
          fillColor: '#e74c3c',
          fillOpacity: 0.05,
          opacity: 0.5,
          weight: 1.5,
          dashArray: '5 5',
          interactive: false,
        }).bindTooltip('📍 Privacy zone — position not recorded inside this area', {
          sticky: true, opacity: 0.85,
        }).addTo(map);
      } else {
        map.setView([lat, lon]);
        marker.setLatLng([lat, lon]);
      }

      // Anchor watch — swing circle, drop marker, and rode line.
      const anchorPos = nav.anchor?.position?.value;
      const anchorRadius = nav.anchor?.maxRadius?.value;
      if (anchorPos?.latitude && anchorPos?.longitude && anchorRadius > 0) {
        const anchorLatLng = [anchorPos.latitude, anchorPos.longitude];
        const vesselLatLng = [lat, lon];
        const radiusFt = (anchorRadius * 3.28084).toFixed(0);
        const currentDist = nav.anchor?.currentRadius?.value;
        const distFt = currentDist != null ? (currentDist * 3.28084).toFixed(0) : '?';
        const tooltipText = `⚓ Swing radius: ${radiusFt} ft · Boat is ${distFt} ft out`;

        // Swing-radius circle
        if (anchorLayer) {
          anchorLayer.setLatLng(anchorLatLng).setRadius(anchorRadius);
          anchorLayer.setTooltipContent(tooltipText);
        } else {
          anchorLayer = L.circle(anchorLatLng, {
            radius: anchorRadius,
            color: '#f39c12',
            fillColor: '#f39c12',
            fillOpacity: 0.08,
            opacity: 0.7,
            weight: 2,
            dashArray: '6 4',
          }).bindTooltip(tooltipText, { sticky: true, opacity: 0.85 }).addTo(map);
        }

        // Anchor drop marker (⚓ emoji icon)
        const anchorIcon = L.divIcon({
          html: '<div style="font-size:18px;line-height:1;text-align:center;">⚓</div>',
          className: '',
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        });
        if (anchorMarker) {
          anchorMarker.setLatLng(anchorLatLng);
          anchorMarker.setTooltipContent(`⚓ Anchor drop · Radius: ${radiusFt} ft`);
        } else {
          anchorMarker = L.marker(anchorLatLng, { icon: anchorIcon })
            .bindTooltip(`⚓ Anchor drop · Radius: ${radiusFt} ft`, { opacity: 0.85 })
            .addTo(map);
        }

        // Rode line from anchor drop to vessel
        if (anchorLine) {
          anchorLine.setLatLngs([anchorLatLng, vesselLatLng]);
        } else {
          anchorLine = L.polyline([anchorLatLng, vesselLatLng], {
            color: '#f39c12',
            weight: 2,
            opacity: 0.55,
            dashArray: '5 5',
          }).addTo(map);
        }
      } else {
        if (anchorLayer)  { anchorLayer.remove();  anchorLayer  = null; }
        if (anchorMarker) { anchorMarker.remove(); anchorMarker = null; }
        if (anchorLine)   { anchorLine.remove();   anchorLine   = null; }
      }

      // Load unified 48-hr conditions forecast
      loadConditionsForecast().catch(err => console.error('Conditions forecast error:', err));
      // Update map location title
      updateMapLocation(lat, lon).catch(err => console.error('Location fetch error:', err));
      // Load track for last 24 hours
      loadTrack().catch(err => console.error('Track load error:', err));
      // Update polar performance
      updatePolarPerformance();
    } else {
      const sentenceEl = document.getElementById('status-sentence');
      if (sentenceEl) sentenceEl.textContent = 'Waiting for GPS position...';
    }

    const tidePosition = resolveTidePosition(lat, lon);
    drawTideGraph(tidePosition.lat, tidePosition.lon, tidePosition);


    // Update navigation data
    const currentTheme = document.documentElement.getAttribute('data-theme');

    const anchorRawSI = nav.anchor?.currentRadius?.value ?? null;
    const anchorStatus = classifyAnchorStatus(anchorRawSI, nav.anchor?.maxRadius?.value);
    const anchorValueHtml = colorValue(fmtUnit('length', anchorRawSI), anchorStatus);

    const socRaw = elec.batteries?.house?.capacity?.stateOfCharge?.value;
    const socZones = elec.batteries?.house?.capacity?.stateOfCharge?.meta?.zones;
    const socPercent = socRaw != null ? socRaw * 100 : null;
    const socDisplay = socPercent != null ? `${socPercent.toFixed(0)}%` : 'N/A';
    const socValueHtml = colorValue(socDisplay, classifyByZones(socRaw, socZones) || classifyBatteryStatus(socPercent));

    const timeRemainingRaw = elec.batteries?.house?.capacity?.timeRemaining?.value;
    const timeRemainingZones = elec.batteries?.house?.capacity?.timeRemaining?.meta?.zones;
    const timeRemainingHours = timeRemainingRaw != null ? timeRemainingRaw / 3600 : null;
    const timeRemainingDisplay = timeRemainingHours != null ? `${timeRemainingHours.toFixed(1)} hrs` : 'N/A';
    const timeRemainingHtml = colorValue(timeRemainingDisplay, classifyByZones(timeRemainingRaw, timeRemainingZones) || classifyBatteryTime(timeRemainingHours));

    const packetLossValueRaw = internet.packetLoss?.value;
    const packetLossZones = internet.packetLoss?.meta?.zones;
    const packetLossPercent = packetLossValueRaw != null ? (packetLossValueRaw <= 1 ? packetLossValueRaw * 100 : packetLossValueRaw) : null;
    const packetLossDisplay = packetLossPercent != null ? `${packetLossPercent.toFixed(1)}%` : 'N/A';
    const packetLossHtml = colorValue(packetLossDisplay, classifyByZones(packetLossValueRaw, packetLossZones) || classifyPacketLoss(packetLossValueRaw));

    const tankValueWithBadge = (level, valueDisplay, waste = false, zones = null) =>
      colorValue(valueDisplay, classifyByZones(level, zones) || (waste ? classifyWasteTank(level) : classifyTankLevel(level)));

    document.getElementById('navigation-grid').innerHTML = `
      <div class="info-item" title="${withUpdated('Current vessel latitude position', nav.position)}"><div class="label">Latitude</div><div class="value">${lat?.toFixed(6) ?? 'N/A'}</div></div>
      <div class="info-item" title="${withUpdated('Current vessel longitude position', nav.position)}"><div class="label">Longitude</div><div class="value">${lon?.toFixed(6) ?? 'N/A'}</div></div>
      <div class="info-item" data-path="navigation.speedOverGround" data-label="SOG" data-unit-group="speed" data-raw="${nav.speedOverGround?.value ?? ''}" title="${withUpdated('Speed Over Ground - actual speed relative to the seabed', nav.speedOverGround)}"><div class="label">SOG</div><div class="value">${fmtUnit('speed', nav.speedOverGround?.value)}</div></div>
      <div class="info-item" data-path="navigation.speedThroughWater" data-label="STW" data-unit-group="speed" data-raw="${nav.speedThroughWater?.value ?? ''}" title="${withUpdated('Speed Through Water - speed relative to the water', nav.speedThroughWater)}"><div class="label">STW</div><div class="value">${fmtUnit('speed', nav.speedThroughWater?.value)}</div></div>
      <div class="info-item" data-path="navigation.trip.log" data-label="Trip" data-unit-group="distance" data-raw="${nav.trip?.log?.value ?? ''}" title="${withUpdated('Trip distance - distance traveled on current trip', nav.trip?.log)}"><div class="label">Trip</div><div class="value">${fmtUnit('distance', nav.trip?.log?.value)}</div></div>
      <div class="info-item" data-path="navigation.log" data-label="Log" data-unit-group="distance" data-raw="${nav.log?.value ?? ''}" title="${withUpdated('Total log distance - cumulative distance traveled', nav.log)}"><div class="label">Log</div><div class="value">${fmtUnit('distance', nav.log?.value)}</div></div>
      <div class="info-item" data-path="navigation.attitude.roll" data-label="Roll" data-unit-group="angle" data-raw="${data.navigation?.attitude?.value?.roll ?? ''}" title="${withUpdated('Vessel roll angle from BNO055 IMU', data.navigation?.attitude)}"><div class="label">Roll</div><div class="value">${fmtUnit('angle', data.navigation?.attitude?.value?.roll)}</div></div>
      <div class="info-item" data-path="navigation.attitude.pitch" data-label="Pitch" data-unit-group="angle" data-raw="${data.navigation?.attitude?.value?.pitch ?? ''}" title="${withUpdated('Vessel pitch angle from BNO055 IMU', data.navigation?.attitude)}"><div class="label">Pitch</div><div class="value">${fmtUnit('angle', data.navigation?.attitude?.value?.pitch)}</div></div>
      <div class="info-item" data-path="navigation.courseOverGroundTrue" data-label="COG" data-unit-group="angle" data-raw="${nav.courseOverGroundTrue?.value ?? ''}" title="${withUpdated('Course Over Ground - true direction the vessel is moving', nav.courseOverGroundTrue)}"><div class="label">COG</div><div class="value">${fmtUnit('angle', nav.courseOverGroundTrue?.value)}</div></div>
      <div class="info-item" data-path="navigation.headingMagnetic" data-label="Mag Heading" data-unit-group="angle" data-raw="${data.navigation?.headingMagnetic?.value ?? ''}" title="${withUpdated('Magnetic heading from MMC5603 magnetometer', data.navigation?.headingMagnetic)}"><div class="label">Mag Heading</div><div class="value">${fmtUnit('angle', data.navigation?.headingMagnetic?.value)}</div></div>
      <div class="info-item" data-path="steering.rudderAngle" data-label="Rudder Angle" data-unit-group="angle" data-raw="${data.steering?.rudderAngle?.value ?? ''}" title="${withUpdated('Current rudder angle - positive is starboard, negative is port', data.steering?.rudderAngle)}"><div class="label">Rudder Angle</div><div class="value">${fmtUnit('angle', data.steering?.rudderAngle?.value)}</div></div>
      <div class="info-item" data-path="navigation.anchor.currentRadius" data-label="Anchor Distance" data-unit-group="length" data-raw="${nav.anchor?.currentRadius?.value ?? ''}" title="${withUpdated('Distance from anchor position - red if outside safe radius', nav.anchor?.currentRadius)}"><div class="label">Anchor Distance</div>${anchorValueHtml}</div>
      <div class="info-item" data-path="navigation.anchor.bearingTrue" data-label="Anchor Bearing" title="${withUpdated('Bearing to anchor position from current location', nav.anchor?.bearingTrue)}"><div class="label">Anchor Bearing</div><div class="value">${nav.anchor?.bearingTrue?.value ? (nav.anchor.bearingTrue.value * 180 / Math.PI).toFixed(0) + '°' : 'N/A'}</div></div>
    `;

    // Update wind data
    document.getElementById('wind-grid').innerHTML = `
      <div class="info-item" data-path="environment.wind.speedTrue" data-label="Wind Speed" data-unit-group="speed" data-raw="${env.wind?.speedTrue?.value ?? ''}" title="${withUpdated('True wind speed - actual wind speed in the atmosphere', env.wind?.speedTrue)}"><div class="label">True Wind Speed</div><div class="value">${fmtUnit('speed', env.wind?.speedTrue?.value)}</div></div>
      <div class="info-item" data-path="environment.wind.angleTrue" data-label="Wind Dir" data-unit-group="angle" data-raw="${env.wind?.angleTrue?.value ?? ''}" title="${withUpdated('True wind direction - actual wind direction relative to true north', env.wind?.angleTrue)}"><div class="label">True Wind Dir</div><div class="value">${fmtUnit('angle', env.wind?.angleTrue?.value)}</div></div>
      <div class="info-item" data-path="environment.wind.angleApparent" data-label="Apparent Wind Angle" data-unit-group="angle" data-raw="${data.environment?.wind?.angleApparent?.value ?? ''}" title="${withUpdated('Apparent wind angle - wind direction relative to vessel heading', data.environment?.wind?.angleApparent)}"><div class="label">Apparent Angle</div><div class="value">${fmtUnit('angle', data.environment?.wind?.angleApparent?.value)}</div></div>
      <div class="info-item" data-path="environment.wind.speedApparent" data-label="Apparent Wind Speed" data-unit-group="speed" data-raw="${data.environment?.wind?.speedApparent?.value ?? ''}" title="${withUpdated('Apparent wind speed - wind speed as felt on the vessel', data.environment?.wind?.speedApparent)}"><div class="label">Apparent Speed</div><div class="value">${fmtUnit('speed', data.environment?.wind?.speedApparent?.value)}</div></div>
      <div class="info-item" data-path="environment.wind.oneMinute.gustTrue" data-label="1-Min Gust" data-unit-group="speed" data-raw="${env.wind?.oneMinute?.gustTrue?.value ?? ''}" title="${withUpdated('Maximum true wind gust over the past 1 minute', env.wind?.oneMinute?.gustTrue)}"><div class="label">1-Min Gust</div><div class="value">${fmtUnit('speed', env.wind?.oneMinute?.gustTrue?.value)}</div></div>
      <div class="info-item" data-path="environment.wind.fiveMinutes.gustTrue" data-label="5-Min Gust" data-unit-group="speed" data-raw="${env.wind?.fiveMinutes?.gustTrue?.value ?? ''}" title="${withUpdated('Maximum true wind gust over the past 5 minutes', env.wind?.fiveMinutes?.gustTrue)}"><div class="label">5-Min Gust</div><div class="value">${fmtUnit('speed', env.wind?.fiveMinutes?.gustTrue?.value)}</div></div>
      <div class="info-item" data-path="environment.wind.oneHour.gustTrue" data-label="1-Hour Gust" data-unit-group="speed" data-raw="${env.wind?.oneHour?.gustTrue?.value ?? ''}" title="${withUpdated('Maximum true wind gust over the past 1 hour', env.wind?.oneHour?.gustTrue)}"><div class="label">1-Hour Gust</div><div class="value">${fmtUnit('speed', env.wind?.oneHour?.gustTrue?.value)}</div></div>
    `;

    // Update power data
    document.getElementById('power-grid').innerHTML = `
      <div class="info-item" data-path="electrical.batteries.house.voltage" data-label="Battery Voltage" title="${withUpdated('House battery bank voltage', elec.batteries?.house?.voltage)}"><div class="label">Battery Voltage</div><div class="value">${elec.batteries?.house?.voltage?.value?.toFixed(2) ?? 'N/A'} V</div></div>
      <div class="info-item" data-path="electrical.batteries.house.current" data-label="Battery Current" title="${withUpdated('House battery bank current - positive is charging, negative is discharging', elec.batteries?.house?.current)}"><div class="label">Battery Current</div><div class="value">${elec.batteries?.house?.current?.value?.toFixed(1) ?? 'N/A'} A</div></div>
      <div class="info-item" data-path="electrical.batteries.house.power" data-label="Battery Power" title="${withUpdated('House battery bank power consumption or generation', elec.batteries?.house?.power)}"><div class="label">Battery Power</div><div class="value">${elec.batteries?.house?.power?.value?.toFixed(1) ?? 'N/A'} W</div></div>
      <div class="info-item" data-path="electrical.batteries.house.capacity.stateOfCharge" data-label="SOC" title="${withUpdated('State of Charge - percentage of battery capacity remaining', elec.batteries?.house?.capacity?.stateOfCharge)}"><div class="label">SOC</div>${socValueHtml}</div>
      <div class="info-item" data-path="electrical.batteries.house.capacity.timeRemaining" data-label="Battery Time Remaining" title="${withUpdated('Estimated time remaining until battery depletion', elec.batteries?.house?.capacity?.timeRemaining)}"><div class="label">Battery Time Remaining</div>${timeRemainingHtml}</div>
      <div class="info-item" data-path="electrical.solar.bimini.panelPower" data-label="Solar Power" title="${withUpdated('Solar panel output power from bimini array (Victron MPPT)', elec.solar?.bimini?.panelPower)}"><div class="label">Solar Power</div><div class="value">${elec.solar?.bimini?.panelPower?.value?.toFixed(1) ?? 'N/A'} W</div></div>
      <div class="info-item" data-path="electrical.solar.bimini.current" data-label="Solar Current" title="${withUpdated('Solar charging current from bimini array', elec.solar?.bimini?.current)}"><div class="label">Solar Current</div><div class="value">${elec.solar?.bimini?.current?.value?.toFixed(2) ?? 'N/A'} A</div></div>
      <div class="info-item" data-path="electrical.solar.bimini.voltage" data-label="Solar Voltage" title="${withUpdated('Solar panel voltage from bimini array', elec.solar?.bimini?.voltage)}"><div class="label">Solar Voltage</div><div class="value">${elec.solar?.bimini?.voltage?.value?.toFixed(2) ?? 'N/A'} V</div></div>
      <div class="info-item" data-path="electrical.solar.bimini.yieldToday" data-label="Solar Yield Today" title="${withUpdated('Total solar energy generated today from bimini array', elec.solar?.bimini?.yieldToday)}"><div class="label">Solar Yield Today</div><div class="value">${elec.solar?.bimini?.yieldToday?.value != null ? (elec.solar.bimini.yieldToday.value / 3600).toFixed(0) + ' Wh' : 'N/A'}</div></div>
      <div class="info-item" data-path="electrical.batteries.house.capacity.dischargeSinceFull" data-label="Discharge Since Full" title="${withUpdated('Amp-hours drawn from the house bank since last full charge', elec.batteries?.house?.capacity?.dischargeSinceFull)}"><div class="label">Discharge Since Full</div><div class="value">${elec.batteries?.house?.capacity?.dischargeSinceFull?.value != null ? (elec.batteries.house.capacity.dischargeSinceFull.value / 3600).toFixed(1) + ' Ah' : 'N/A'}</div></div>
      <div class="info-item" title="${withUpdated('Solar charge controller mode (off / bulk / absorption / float)', elec.solar?.bimini?.chargingMode)}"><div class="label">Solar Mode</div><div class="value value-text">${elec.solar?.bimini?.chargingMode?.value ?? 'N/A'}</div></div>
    `;

    // Update the vessel information with static vessel data
    document.getElementById('vessel-grid').innerHTML = `
      <div class="info-item" data-unit-group="length" data-raw="${data.design?.length?.value?.overall ?? ''}" title="${withUpdated('Overall vessel length from bow to stern', data.design?.length)}"><div class="label">Vessel Length</div><div class="value">${fmtUnit('length', data.design?.length?.value?.overall)}</div></div>
      <div class="info-item" data-unit-group="length" data-raw="${data.design?.beam?.value ?? ''}" title="${withUpdated('Vessel beam - maximum width of the vessel', data.design?.beam)}"><div class="label">Vessel Beam</div><div class="value">${fmtUnit('length', data.design?.beam?.value)}</div></div>
      <div class="info-item" data-unit-group="length" data-raw="${data.design?.draft?.value?.maximum ?? ''}" title="${withUpdated('Maximum vessel draft - depth below waterline', data.design?.draft)}"><div class="label">Vessel Draft</div><div class="value">${fmtUnit('length', data.design?.draft?.value?.maximum)}</div></div>
      <div class="info-item" data-unit-group="length" data-raw="${data.design?.airHeight?.value ?? ''}" title="${withUpdated('Vessel air height - height above waterline', data.design?.airHeight)}"><div class="label">Air Height</div><div class="value">${fmtUnit('length', data.design?.airHeight?.value)}</div></div>
      <div class="info-item" title="${withUpdated('Vessel name from SignalK', data)}"><div class="label">Vessel Name</div><div class="value value-text">${data.name || 'N/A'}</div></div>
      <div class="info-item" title="${withUpdated('Maritime Mobile Service Identity - unique vessel identifier', data)}"><div class="label">MMSI</div><div class="value value-text">${data.mmsi || vesselData?.mmsi || 'N/A'}</div></div>
      <div class="info-item" title="${withUpdated('VHF radio callsign', data.communication)}"><div class="label">Callsign</div><div class="value value-text">${data.communication?.callsignVhf || 'N/A'}</div></div>
      <div class="info-item" title="${withUpdated('Hull Number (Assigned by Beneteau)', vesselData)}"><div class="label">Hull #</div><div class="value value-text">${vesselData?.hull_number || 'N/A'}</div></div>
      <div class="info-item" title="${withUpdated('US Coast Guard vessel registration number', vesselData)}"><div class="label">USCG #</div><div class="value value-text">${vesselData?.uscg_number || 'N/A'}</div></div>
    `;

    const isNumericValue = (val) => typeof val === 'number' && Number.isFinite(val);
    const toPercent = (val, digits = 0) =>
      isNumericValue(val) ? `${(val * 100).toFixed(digits)}%` : 'N/A';
    const formatTankDisplay = (level, volume) => {
      const levelDisplay = toPercent(level);
      const volumeDisplay = isNumericValue(volume) ? fmtUnit('volume', volume) : null;
      if (levelDisplay !== 'N/A' && volumeDisplay) {
        return `<span>${levelDisplay}</span><span class="value-sub">${volumeDisplay}</span>`;
      }
      return levelDisplay !== 'N/A' ? levelDisplay : (volumeDisplay || 'N/A');
    };
    // Update onboard sensor readings (water/inside temp, humidity, air quality, sun times)
    document.getElementById('sensors-grid').innerHTML = `
      <div class="info-item" data-path="environment.water.temperature" data-label="Water Temp" data-unit-group="temperature" data-raw="${env.water?.temperature?.value ?? ''}" title="${withUpdated('Water temperature at the surface', env.water?.temperature)}"><div class="label">Water Temp</div><div class="value">${fmtUnit('temperature', env.water?.temperature?.value)}</div></div>
      <div class="info-item" data-path="environment.inside.temperature" data-label="Inside Temp" data-unit-group="temperature" data-raw="${data.environment?.inside?.temperature?.value ?? ''}" title="${withUpdated('Inside air temperature from BME280 sensor', data.environment?.inside?.temperature)}"><div class="label">Inside Temp</div><div class="value">${fmtUnit('temperature', data.environment?.inside?.temperature?.value)}</div></div>
      <div class="info-item" data-path="environment.inside.humidity" data-label="Inside Humidity" title="${withUpdated('Inside humidity from BME280 sensor', data.environment?.inside?.humidity)}"><div class="label">Inside Humidity</div><div class="value">${data.environment?.inside?.humidity?.value ? (data.environment.inside.humidity.value * 100).toFixed(1) + '%' : 'N/A'}</div></div>
      <div class="info-item" data-path="environment.inside.pressure" data-label="Barometric Pressure" data-unit-group="pressure" data-raw="${data.environment?.inside?.pressure?.value ?? ''}" title="${withUpdated('Inside barometric pressure from BME280 sensor', data.environment?.inside?.pressure)}"><div class="label">Barometric Pressure</div><div class="value">${fmtUnit('pressure', data.environment?.inside?.pressure?.value)}</div></div>
      <div class="info-item" data-path="environment.inside.airQuality.tvoc" data-label="TVOC" title="${withUpdated('Indoor air quality - Total Volatile Organic Compounds', data.environment?.inside?.airQuality?.tvoc)}"><div class="label">TVOC</div><div class="value">${data.environment?.inside?.airQuality?.tvoc?.value ? data.environment.inside.airQuality.tvoc.value.toFixed(0) + ' ppb' : 'N/A'}</div></div>
      <div class="info-item" data-path="environment.inside.airQuality.eco2" data-label="CO₂" title="${withUpdated('Indoor air quality - Carbon Dioxide equivalent', data.environment?.inside?.airQuality?.eco2)}"><div class="label">CO₂</div><div class="value">${data.environment?.inside?.airQuality?.eco2?.value ? data.environment.inside.airQuality.eco2.value.toFixed(0) + ' ppm' : 'N/A'}</div></div>
      <div class="info-item" data-path="navigation.magneticVariation" data-label="Magnetic Variation" title="${withUpdated('Magnetic variation at current position - difference between true and magnetic north', data.navigation?.magneticVariation)}"><div class="label">Magnetic Variation</div><div class="value">${data.navigation?.magneticVariation?.value ? (data.navigation.magneticVariation.value * 180 / Math.PI).toFixed(1) + '°' : 'N/A'}</div></div>
      <div class="info-item" title="${withUpdated('Sunrise time today', data.environment?.sunlight?.times?.sunrise)}"><div class="label">Sunrise</div><div class="value">${data.environment?.sunlight?.times?.sunrise?.value ? new Date(data.environment.sunlight.times.sunrise.value).toLocaleTimeString() : 'N/A'}</div></div>
      <div class="info-item" title="${withUpdated('Sunset time today', data.environment?.sunlight?.times?.sunset)}"><div class="label">Sunset</div><div class="value">${data.environment?.sunlight?.times?.sunset?.value ? new Date(data.environment.sunlight.times.sunset.value).toLocaleTimeString() : 'N/A'}</div></div>
    `;

    document.getElementById('internet-grid').innerHTML = `
      <div class="info-item" title="${withUpdated('Internet service provider', internet.ISP)}"><div class="label">ISP</div><div class="value value-text">${internet.ISP?.value || 'N/A'}</div></div>
      <div class="info-item" data-path="internet.speed.download" data-label="Download" title="${withUpdated('Download speed', internet.speed?.download)}"><div class="label">Download</div><div class="value">${isNumericValue(internet.speed?.download?.value) ? internet.speed.download.value.toFixed(1) + ' Mbps' : 'N/A'}</div></div>
      <div class="info-item" data-path="internet.speed.upload" data-label="Upload" title="${withUpdated('Upload speed', internet.speed?.upload)}"><div class="label">Upload</div><div class="value">${isNumericValue(internet.speed?.upload?.value) ? internet.speed.upload.value.toFixed(1) + ' Mbps' : 'N/A'}</div></div>
      <div class="info-item" data-path="internet.ping.latency" data-label="Latency" title="${withUpdated('Ping latency', internet.ping?.latency)}"><div class="label">Latency</div><div class="value">${isNumericValue(internet.ping?.latency?.value) ? internet.ping.latency.value.toFixed(1) + ' ms' : 'N/A'}</div></div>
      <div class="info-item" data-path="internet.ping.jitter" data-label="Jitter" title="${withUpdated('Ping jitter', internet.ping?.jitter)}"><div class="label">Jitter</div><div class="value">${isNumericValue(internet.ping?.jitter?.value) ? internet.ping.jitter.value.toFixed(1) + ' ms' : 'N/A'}</div></div>
      <div class="info-item" data-path="internet.packetLoss" data-label="Packet Loss" title="${withUpdated('Packet loss percentage', internet.packetLoss)}"><div class="label">Packet Loss</div>${packetLossHtml}</div>
    `;

    // Update system health (RPi)
    const rpi = env.rpi || {};
    const fmtCelsius = (k) => Number.isFinite(k) ? `${(k - 273.15).toFixed(1)} °C` : 'N/A';
    const fmtPercent = (v) => Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : 'N/A';
    document.getElementById('system-grid').innerHTML = `
      <div class="info-item" data-path="environment.rpi.cpu.temperature" data-label="CPU Temp" data-unit-group="temperature" data-raw="${rpi.cpu?.temperature?.value ?? ''}" title="${withUpdated('Raspberry Pi CPU temperature', rpi.cpu?.temperature)}"><div class="label">CPU Temp</div><div class="value">${fmtCelsius(rpi.cpu?.temperature?.value)}</div></div>
      <div class="info-item" data-path="environment.rpi.gpu.temperature" data-label="GPU Temp" data-unit-group="temperature" data-raw="${rpi.gpu?.temperature?.value ?? ''}" title="${withUpdated('Raspberry Pi GPU temperature', rpi.gpu?.temperature)}"><div class="label">GPU Temp</div><div class="value">${fmtCelsius(rpi.gpu?.temperature?.value)}</div></div>
      <div class="info-item" data-path="environment.rpi.cpu.utilisation" data-label="CPU Use" title="${withUpdated('Raspberry Pi CPU utilisation', rpi.cpu?.utilisation)}"><div class="label">CPU Use</div><div class="value">${fmtPercent(rpi.cpu?.utilisation?.value)}</div></div>
      <div class="info-item" data-path="environment.rpi.memory.utilisation" data-label="RAM Use" title="${withUpdated('Raspberry Pi memory utilisation', rpi.memory?.utilisation)}"><div class="label">RAM Use</div><div class="value">${fmtPercent(rpi.memory?.utilisation?.value)}</div></div>
      <div class="info-item" data-path="environment.rpi.sd.utilisation" data-label="SD Use" title="${withUpdated('Raspberry Pi SD card utilisation', rpi.sd?.utilisation)}"><div class="label">SD Use</div><div class="value">${fmtPercent(rpi.sd?.utilisation?.value)}</div></div>
    `;

    const propulsion = data.propulsion?.port || {};
    const rpmValue = propulsion.revolutions?.value;
    document.getElementById('propulsion-grid').innerHTML = `
      <div class="info-item" title="${withUpdated('Engine state', propulsion.state)}"><div class="label">State</div><div class="value value-text">${propulsion.state?.value || 'N/A'}</div></div>
      <div class="info-item" data-path="propulsion.port.revolutions" data-label="RPM" data-unit-group="rotation" data-raw="${rpmValue ?? ''}" title="${withUpdated('Engine revolutions per minute', propulsion.revolutions)}"><div class="label">RPM</div><div class="value">${fmtUnit('rotation', rpmValue)}</div></div>
    `;

    const tanks = data.tanks || {};
    const fuelMain = tanks.fuel?.['0'] || {};
    const fuelReserve = tanks.fuel?.reserve || {};
    const freshWater0 = tanks.freshWater?.['0'] || {};
    const freshWater1 = tanks.freshWater?.['1'] || {};
    const propaneA = tanks.propane?.a || {};
    const propaneB = tanks.propane?.b || {};
    const blackwaterBow = tanks.blackwater?.bow || {};
    const liveWell0 = tanks.liveWell?.['0'] || {};
    document.getElementById('tanks-grid').innerHTML = `
      <div class="info-item" data-path="tanks.fuel.0.currentLevel" data-label="Fuel (Main)" data-unit-group="volume" data-raw="${fuelMain.currentVolume?.value ?? ''}" data-level="${toPercent(fuelMain.currentLevel?.value)}" title="${withUpdatedNodes('Main fuel tank level, volume, and temperature (if available)', fuelMain.currentLevel, fuelMain.currentVolume, fuelMain.temperature)}"><div class="label">Fuel (Main)</div>${tankValueWithBadge(fuelMain.currentLevel?.value, formatTankDisplay(fuelMain.currentLevel?.value, fuelMain.currentVolume?.value), false, fuelMain.currentLevel?.meta?.zones)}</div>
      <div class="info-item" data-path="tanks.fuel.reserve.currentLevel" data-label="Fuel (Reserve)" data-unit-group="volume" data-raw="${fuelReserve.currentVolume?.value ?? ''}" data-level="${toPercent(fuelReserve.currentLevel?.value)}" title="${withUpdatedNodes('Reserve fuel tank level, volume, and temperature (if available)', fuelReserve.currentLevel, fuelReserve.currentVolume, fuelReserve.temperature)}"><div class="label">Fuel (Reserve)</div>${tankValueWithBadge(fuelReserve.currentLevel?.value, formatTankDisplay(fuelReserve.currentLevel?.value, fuelReserve.currentVolume?.value), false, fuelReserve.currentLevel?.meta?.zones)}</div>
      <div class="info-item" data-path="tanks.freshWater.0.currentLevel" data-label="Fresh Water 1" data-unit-group="volume" data-raw="${freshWater0.currentVolume?.value ?? ''}" data-level="${toPercent(freshWater0.currentLevel?.value)}" title="${withUpdatedNodes('Fresh water tank 1 level and volume', freshWater0.currentLevel, freshWater0.currentVolume)}"><div class="label">Fresh Water 1</div>${tankValueWithBadge(freshWater0.currentLevel?.value, formatTankDisplay(freshWater0.currentLevel?.value, freshWater0.currentVolume?.value), false, freshWater0.currentLevel?.meta?.zones)}</div>
      <div class="info-item" data-path="tanks.freshWater.1.currentLevel" data-label="Fresh Water 2" data-unit-group="volume" data-raw="${freshWater1.currentVolume?.value ?? ''}" data-level="${toPercent(freshWater1.currentLevel?.value)}" title="${withUpdatedNodes('Fresh water tank 2 level and volume', freshWater1.currentLevel, freshWater1.currentVolume)}"><div class="label">Fresh Water 2</div>${tankValueWithBadge(freshWater1.currentLevel?.value, formatTankDisplay(freshWater1.currentLevel?.value, freshWater1.currentVolume?.value), false, freshWater1.currentLevel?.meta?.zones)}</div>
      <div class="info-item" data-path="tanks.propane.a.currentLevel" data-label="Propane A" title="${withUpdatedNodes('Propane tank A level and temperature', propaneA.currentLevel, propaneA.temperature)}"><div class="label">Propane A</div>${tankValueWithBadge(propaneA.currentLevel?.value, formatTankDisplay(propaneA.currentLevel?.value, null), false, propaneA.currentLevel?.meta?.zones)}</div>
      <div class="info-item" data-path="tanks.propane.b.currentLevel" data-label="Propane B" title="${withUpdatedNodes('Propane tank B level and temperature', propaneB.currentLevel, propaneB.temperature)}"><div class="label">Propane B</div>${tankValueWithBadge(propaneB.currentLevel?.value, formatTankDisplay(propaneB.currentLevel?.value, null), false, propaneB.currentLevel?.meta?.zones)}</div>
      <div class="info-item" data-path="tanks.blackwater.bow.currentLevel" data-label="Blackwater" title="${withUpdatedNodes('Blackwater tank level and temperature', blackwaterBow.currentLevel, blackwaterBow.temperature)}"><div class="label">Blackwater</div>${tankValueWithBadge(blackwaterBow.currentLevel?.value, formatTankDisplay(blackwaterBow.currentLevel?.value, null), true, blackwaterBow.currentLevel?.meta?.zones)}</div>
      <div class="info-item" data-path="tanks.liveWell.0.currentLevel" data-label="Bilge" title="${withUpdated('Bilge level', liveWell0.currentLevel)}"><div class="label">Bilge</div>${tankValueWithBadge(liveWell0.currentLevel?.value, formatTankDisplay(liveWell0.currentLevel?.value, null), true, liveWell0.currentLevel?.meta?.zones)}</div>
    `;

    // Render alert summary and inline sparklines now that all info-item cards are in the DOM.
    renderAlertSummary();
    initInlineSparklines();
  } catch (err) {
    console.error("Failed to load data:", err);
    console.error("Error details:", err.message);
    const sentenceEl = document.getElementById('status-sentence');
    if (sentenceEl) sentenceEl.textContent = `Error loading data: ${err.message}`;
    const statusHero = document.getElementById('status-hero');
    if (statusHero) statusHero.classList.add('stale');

    Object.keys(PANEL_SKELETONS).forEach((id) =>
      renderEmptyState(id, 'Data unavailable', 'Could not load vessel data.'));
  }
}

async function loadPolarData() {
  try {
    const response = await fetch('data/vessel/polars.csv');

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const csvText = await response.text();

    // Parse CSV data
    const lines = csvText.split('\n');
    const headers = lines[0].split(';');
    const windSpeeds = headers.slice(1).map(Number); // [4, 6, 8, 10, 12, 14, 16, 20, 24]

    polarData = [];
    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(';');
      const twa = parseFloat(values[0]); // True Wind Angle
      if (!isNaN(twa)) {
        const speeds = values.slice(1).map(v => parseFloat(v) || 0);
        polarData.push({ twa, speeds });
      }
    }
  } catch (error) {
    console.error('Error loading polar data:', error);
  }
}

function calculateVMG(bearingToDest, bsp) {
  // VMG = Boat Speed * cos(angle between boat heading and destination bearing)
  // This calculates how fast you're progressing toward your destination
  const angleRad = (bearingToDest * Math.PI) / 180;
  return bsp * Math.cos(angleRad);
}


function updatePolarPerformance() {
  if (!polarData) {
    return;
  }

  // Check for different wind angle data sources
  let windAngle = null;
  if (currentEnv?.wind?.angleTrue?.value) {
    windAngle = currentEnv.wind.angleTrue.value;
  } else if (currentEnv?.wind?.angleTrueWater?.value) {
    windAngle = currentEnv.wind.angleTrueWater.value;
  } else if (currentEnv?.wind?.angleApparent?.value) {
    windAngle = currentEnv.wind.angleApparent.value;
  }

  // Check for different boat speed data sources
  let boatSpeed = null;
  if (currentNav?.speedThroughWater?.value) {
    boatSpeed = currentNav.speedThroughWater.value;
  } else if (currentNav?.speedOverGround?.value) {
    boatSpeed = currentNav.speedOverGround.value;
  }

  // Check for wind speed data
  let windSpeed = null;
  if (currentEnv?.wind?.speedTrue?.value) {
    windSpeed = currentEnv.wind.speedTrue.value;
  }

  // Use default values if data is missing
  const twa = windAngle ? windAngle * 180 / Math.PI : 90; // Default to 90 degrees (middle of chart)
  const bsp = boatSpeed ? boatSpeed * 1.94384 : 0; // Default to 0 knots (center of bullseye)
  const tws = windSpeed ? windSpeed * 1.94384 : 10; // Default to 10 knots

  // Engine / propulsion state
  const engineState = currentPropulsion?.state?.value;
  const engineHz    = currentPropulsion?.revolutions?.value;
  const rpm         = engineHz != null ? Math.round(engineHz * 60) : null;
  const engineOn    = engineState === 'started' || (rpm != null && rpm > 100);

  // Show/hide motoring badge over the polar chart
  const indicator = document.getElementById('polar-engine-indicator');
  if (indicator) {
    if (engineOn) {
      indicator.textContent = rpm != null ? `Motoring · ${rpm} RPM` : 'Engine On';
      indicator.style.display = '';
    } else {
      indicator.style.display = 'none';
    }
  }

  // Always draw polar chart, even with default values
  drawPolarChart(twa, bsp, tws);
}

function drawPolarChart(currentTWA, currentSpeed, currentTWS) {
  const now = Date.now();
  if (isDrawingPolarChart) {
    return;
  }


  if (!polarData) return;

  // Get theme information early for use throughout the function
  const isDark = isDarkTheme(document.documentElement.getAttribute('data-theme'));

  isDrawingPolarChart = true;
  lastPolarChartUpdate = now;

  const canvas = document.getElementById('polarChart');
  const ctx = canvas.getContext('2d');

  // Ensure previous chart is properly destroyed
  if (polarChartInstance) {
    polarChartInstance.destroy();
    polarChartInstance = null;
  }



  // Clear the canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Determine which side to show based on boat course
  let focusSide = 'starboard'; // default
  if (currentNav?.courseOverGroundTrue?.value) {
    const boatCourse = currentNav.courseOverGroundTrue.value * 180 / Math.PI;
    const windDirection = currentEnv?.wind?.angleTrueWater?.value * 180 / Math.PI;

    // Calculate relative angle to determine tack
    let relativeAngle = boatCourse - windDirection;
    if (relativeAngle > 180) relativeAngle -= 360;
    if (relativeAngle < -180) relativeAngle += 360;

    // Positive = starboard tack, negative = port tack
    focusSide = relativeAngle > 0 ? 'starboard' : 'port';
  }

  // Create full 360° angle array.
  // Labels use sailing sign convention: positive = starboard, negative = port.
  const fullAngles = [];
  const fullLabels = [];

  // Starboard side: 0° → +180°
  for (let i = 0; i <= 180; i += 15) {
    fullAngles.push(i);
    fullLabels.push(i === 0 ? '0°' : `+${i}°`);
  }

  // Port side: -165° → -15° (stored internally as 195°→345° for Chart.js)
  for (let i = 195; i <= 345; i += 15) {
    fullAngles.push(i);
    fullLabels.push(`${i - 360}°`);  // 195→-165, 210→-150, … 345→-15
  }

  // Create datasets for each wind speed
  const polarDatasets = [];
  const windSpeeds = [4, 6, 8, 10, 12, 14, 16, 20, 24];

  // Find the closest wind speed to current wind speed
  let closestWindSpeedIndex = 0;
  let minWindSpeedDiff = Math.abs(currentTWS - windSpeeds[0]);
  for (let i = 1; i < windSpeeds.length; i++) {
    const diff = Math.abs(currentTWS - windSpeeds[i]);
    if (diff < minWindSpeedDiff) {
      minWindSpeedDiff = diff;
      closestWindSpeedIndex = i;
    }
  }

  windSpeeds.forEach((tws, index) => {
    const speeds = fullAngles.map(angle => {
      // For angles > 180°, use the mirror angle (360° - angle)
      const lookupAngle = angle > 180 ? 360 - angle : angle;

      // Find closest angle in polar data
      let closestAngle = polarData[0];
      let minDiff = Math.abs(lookupAngle - polarData[0].twa);

      for (const point of polarData) {
        const diff = Math.abs(lookupAngle - point.twa);
        if (diff < minDiff) {
          minDiff = diff;
          closestAngle = point;
        }
      }

      return closestAngle.speeds[index] || 0;
    });

    const validSpeeds = speeds.filter(speed => speed > 0);
    if (validSpeeds.length > 0) {
      // Reverse the color order: red for max wind, blue for min wind
      const reversedIndex = windSpeeds.length - 1 - index;
      const hue = reversedIndex * 30; // 0 = red, 30 = orange, 60 = yellow, 120 = green, 180 = cyan, 240 = blue

      // Highlight the closest wind speed line
      const isClosestWindSpeed = index === closestWindSpeedIndex;

      polarDatasets.push({
        label: `${tws} kts${isClosestWindSpeed ? ' (Current)' : ''}`,
        data: speeds,
        borderColor: isClosestWindSpeed ? (isDark ? '#60a5fa' : '#2563eb') : `hsla(${hue}, 70%, 50%, 0.50)`, // 50% alpha for non-current lines
        backgroundColor: isClosestWindSpeed ? (isDark ? 'rgba(96,165,250,0.2)' : 'rgba(37,99,235,0.2)') : `hsla(${hue}, 70%, 50%, 0.025)`, // Reduced alpha for background too
        borderWidth: isClosestWindSpeed ? 4 : 2, // Thicker line for current wind speed
        fill: false,
        tension: 0.4,
        order: isClosestWindSpeed ? 0 : 1 // Current wind speed drawn last (on top)
      });
    }
  });

  // Add current position as a single point
  // Normalize TWA to 0-360 range
  let normalizedTWA = currentTWA;
  while (normalizedTWA < 0) normalizedTWA += 360;
  while (normalizedTWA >= 360) normalizedTWA -= 360;

  // Find the closest angle in our chart's angle array
  const closestAngleIndex = fullAngles.reduce((closest, angle, index) => {
    return Math.abs(angle - normalizedTWA) < Math.abs(fullAngles[closest] - normalizedTWA) ? index : closest;
  }, 0);

  // Create a dataset with just the single point
  const currentData = new Array(fullAngles.length).fill(null);
  currentData[closestAngleIndex] = currentSpeed;



  // Add current position last so it appears on top
  polarDatasets.push({
    label: 'Current',
    data: currentData,
    borderColor: isDark ? '#60a5fa' : '#2563eb',
    backgroundColor: isDark ? '#60a5fa' : '#2563eb',
    borderWidth: 0, // No line
    pointRadius: 12,
    pointHoverRadius: 16,
    fill: false,
    tension: 0,
    showLine: false, // Don't draw lines between points
    order: -1 // Lower order values are drawn last (on top)
  });

  // Note: Chart.js radar charts don't support true straight radial lines
  // The TWA line would need to be implemented as a custom canvas overlay
  // For now, the current position marker and highlighted wind speed line provide good reference

  let startAngle = 0;
  let endAngle = 180;

  polarChartInstance = new Chart(ctx, {
    type: 'radar',
    data: {
      labels: fullLabels,
      datasets: polarDatasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 0 // Disable all animations
      },
      plugins: {
        tooltip: {
          enabled: false
        },
        legend: {
          position: 'top',
          labels: {
            usePointStyle: true,
            color: isDark ? '#ffffff' : '#2c3e50'
          }
        }
      },
      scales: {
        r: {
            beginAtZero: true,
            grid: {
              color: isDark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.1)'
            },
            ticks: {
              stepSize: 2,
              color: isDark ? '#ffffff' : '#2c3e50',
              backdropColor: 'transparent',
              font: {
                size: 11,
                weight: 'bold'
              }
            },
            pointLabels: {
              color: isDark ? '#ffffff' : '#2c3e50',
              font: {
                size: 9,
              },
              callback: function(value, index) {
                return value;
              }
            },
            title: {
              display: true,
              text: 'Boat Speed (kts)',
              color: isDark ? '#ffffff' : '#2c3e50'
            },
            startAngle: startAngle,
            min: 0,
            max: 12,
            backgroundColor: 'transparent'
          }
        }
    }
  });

  isDrawingPolarChart = false;


}



// ─────────────────────────────────────────────────────────────────────────
// Conditions Forecast — 48-hr unified panel
// ─────────────────────────────────────────────────────────────────────────
let conditionsChartInstances = {};

async function loadConditionsForecast() {
  const stack   = document.getElementById('conditions-chart-stack');
  const loading = document.getElementById('conditions-loading');

  const tidePos = resolveTidePosition(lat, lon);
  if (!hasValidCoordinates(tidePos.lat, tidePos.lon)) {
    if (loading) loading.textContent = 'Waiting for GPS position…';
    return;
  }

  const now         = new Date();
  // 48-hr window: midnight local today → midnight local day+2
  const windowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const windowEnd   = new Date(windowStart.getTime() + 48 * 3600000);
  const nowOffset   = (now - windowStart) / 3600000; // fractional hour within window

  // Format YYYY-MM-DD in local time
  function localDateStr(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  // Format YYYYMMDD in UTC (for NOAA)
  function utcDateStr(d) {
    return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`;
  }

  const today    = localDateStr(windowStart);
  const tomorrow = localDateStr(new Date(windowStart.getTime() + 24 * 3600000));
  const latR = Math.round(tidePos.lat * 100) / 100;
  const lonR = Math.round(tidePos.lon * 100) / 100;

  // Show date range in header
  const dateRangeEl = document.getElementById('conditions-date-range');
  if (dateRangeEl) {
    const fmtD = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    dateRangeEl.textContent = `${fmtD(windowStart)} – ${fmtD(new Date(windowEnd.getTime() - 1))}`;
  }

  // Fetch all three sources in parallel; each fails independently
  const [atmosResult, marineResult, tideResult] = await Promise.allSettled([

    // ── Atmospheric (Open-Meteo) ──────────────────────────────────────────
    (async () => {
      const key = `cond_atmos2_${latR}_${lonR}_${today}`;
      const hit = getCached(key, C.FORECAST_CACHE_TTL_MS);
      if (hit) return hit;
      const url = `https://api.open-meteo.com/v1/forecast` +
        `?latitude=${tidePos.lat}&longitude=${tidePos.lon}` +
        `&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m,temperature_2m,` +
        `surface_pressure,precipitation_probability,cloud_cover` +
        `&wind_speed_unit=kn&temperature_unit=fahrenheit` +
        `&timezone=auto&start_date=${today}&end_date=${tomorrow}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`atmos HTTP ${res.status}`);
      const data = await res.json();
      setCached(key, data);
      return data;
    })(),

    // ── Marine (Open-Meteo Marine) ────────────────────────────────────────
    (async () => {
      const key = `cond_marine_${latR}_${lonR}_${today}`;
      const hit = getCached(key, C.FORECAST_CACHE_TTL_MS);
      if (hit) return hit;
      const url = `https://marine-api.open-meteo.com/v1/marine` +
        `?latitude=${tidePos.lat}&longitude=${tidePos.lon}` +
        `&hourly=wave_height,wave_period,wave_direction,ocean_current_velocity,ocean_current_direction` +
        `&timezone=auto&start_date=${today}&end_date=${tomorrow}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`marine HTTP ${res.status}`);
      const data = await res.json();
      setCached(key, data);
      return data;
    })(),

    // ── Tide (NOAA) ───────────────────────────────────────────────────────
    (async () => {
      const station = await findNearestNOAAStation(tidePos.lat, tidePos.lon);
      const begin   = utcDateStr(windowStart);
      const end     = utcDateStr(windowEnd);
      const key     = `cond_tide_${station.id}_${begin}_${end}`;
      const hit     = getCached(key, C.TIDE_CACHE_TTL_MS);
      if (hit) return { station, predictions: hit };
      const params = new URLSearchParams({
        product: 'predictions', application: 'vessel-tracker',
        begin_date: begin, end_date: end,
        datum: 'MLLW', station: station.id,
        time_zone: 'gmt', units: 'english', interval: 'h', format: 'json'
      });
      const res = await fetch(`https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?${params}`);
      if (!res.ok) throw new Error(`tide HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error.message);
      const predictions = json.predictions || [];
      if (predictions.length > 0) setCached(key, predictions);
      return { station, predictions };
    })()
  ]);

  // ── Build unified hourly arrays (index 0 = windowStart, 48 = windowEnd) ─
  // Open-Meteo hourly times are local (timezone=auto), no Z suffix → new Date() treats as local ✓
  function mapHourlyLocal(times, values) {
    const out = new Array(49).fill(null);
    if (!times || !values) return out;
    times.forEach((ts, i) => {
      const t   = new Date(ts);
      const idx = Math.round((t - windowStart) / 3600000);
      if (idx >= 0 && idx <= 48 && values[i] != null) out[idx] = values[i];
    });
    return out;
  }

  const isDark = isDarkTheme(document.documentElement.getAttribute('data-theme'));

  // Wind
  let windSpeed   = new Array(49).fill(null);
  let windGust    = new Array(49).fill(null);
  let windDir     = new Array(49).fill(null);
  let windCurrent = null;
  let windDirCurrent = null;
  if (atmosResult.status === 'fulfilled') {
    const h = atmosResult.value?.hourly;
    if (h) {
      windSpeed = mapHourlyLocal(h.time, h.wind_speed_10m);
      windGust  = mapHourlyLocal(h.time, h.wind_gusts_10m);
      windDir   = mapHourlyLocal(h.time, h.wind_direction_10m);
      const idx = Math.min(48, Math.max(0, Math.round(nowOffset)));
      windCurrent    = windSpeed[idx];
      windDirCurrent = windDir[idx];
    }
  }

  // Swell
  let swellHeight = new Array(49).fill(null);
  let swellCurrent = null;
  if (marineResult.status === 'fulfilled') {
    const h = marineResult.value?.hourly;
    if (h) {
      const raw = mapHourlyLocal(h.time, h.wave_height);
      swellHeight = raw.map(v => v != null ? v * 3.28084 : null); // m → ft
      const idx = Math.min(48, Math.max(0, Math.round(nowOffset)));
      swellCurrent = swellHeight[idx];
    }
  }

  // Ocean current speed + direction
  let currentSpeed = new Array(49).fill(null);
  let currentDir   = new Array(49).fill(null);
  let currentCurrent = null;
  let currentDirCurrent = null;
  if (marineResult.status === 'fulfilled') {
    const h = marineResult.value?.hourly;
    if (h) {
      const raw = mapHourlyLocal(h.time, h.ocean_current_velocity);
      currentSpeed = raw.map(v => v != null ? v * 1.94384 : null); // m/s → kts
      currentDir   = mapHourlyLocal(h.time, h.ocean_current_direction);
      const idx = Math.min(48, Math.max(0, Math.round(nowOffset)));
      currentCurrent    = currentSpeed[idx];
      currentDirCurrent = currentDir[idx];
    }
  }

  // Temperature
  let temperature = new Array(49).fill(null);
  let tempCurrent = null;
  if (atmosResult.status === 'fulfilled') {
    const h = atmosResult.value?.hourly;
    if (h) {
      temperature = mapHourlyLocal(h.time, h.temperature_2m);
      const idx = Math.min(48, Math.max(0, Math.round(nowOffset)));
      tempCurrent = temperature[idx];
    }
  }

  // Tide — NOAA returns UTC timestamps with a space ("YYYY-MM-DD HH:mm")
  let tideHeight = new Array(49).fill(null);
  let tideCurrent = null;
  let tideStationName = '';
  if (tideResult.status === 'fulfilled') {
    const { station, predictions } = tideResult.value;
    tideStationName = station?.name || '';
    predictions.forEach(d => {
      // Force UTC parse by appending 'Z' after replacing space with 'T'
      const t   = new Date(d.t.replace(' ', 'T') + 'Z');
      const idx = Math.round((t - windowStart) / 3600000);
      if (idx >= 0 && idx <= 48) tideHeight[idx] = parseFloat(d.v);
    });
    const idx = Math.min(48, Math.max(0, Math.round(nowOffset)));
    tideCurrent = tideHeight[idx];
  }

  // Swell period
  let swellPeriod = new Array(49).fill(null);
  let periodCurrent = null;
  if (marineResult.status === 'fulfilled') {
    const h = marineResult.value?.hourly;
    if (h) {
      swellPeriod = mapHourlyLocal(h.time, h.wave_period);
      const idx = Math.min(48, Math.max(0, Math.round(nowOffset)));
      periodCurrent = swellPeriod[idx];
    }
  }

  // Swell direction
  let swellDir = new Array(49).fill(null);
  let swellDirCurrent = null;
  if (marineResult.status === 'fulfilled') {
    const h = marineResult.value?.hourly;
    if (h) {
      swellDir = mapHourlyLocal(h.time, h.wave_direction);
      const idx = Math.min(48, Math.max(0, Math.round(nowOffset)));
      swellDirCurrent = swellDir[idx];
    }
  }

  // Precipitation probability
  let precipProb = new Array(49).fill(null);
  let precipCurrent = null;
  if (atmosResult.status === 'fulfilled') {
    const h = atmosResult.value?.hourly;
    if (h) {
      precipProb = mapHourlyLocal(h.time, h.precipitation_probability);
      const idx = Math.min(48, Math.max(0, Math.round(nowOffset)));
      precipCurrent = precipProb[idx];
    }
  }

  // Cloud cover
  let cloudCover = new Array(49).fill(null);
  let cloudCurrent = null;
  if (atmosResult.status === 'fulfilled') {
    const h = atmosResult.value?.hourly;
    if (h) {
      cloudCover = mapHourlyLocal(h.time, h.cloud_cover);
      const idx = Math.min(48, Math.max(0, Math.round(nowOffset)));
      cloudCurrent = cloudCover[idx];
    }
  }

  // Surface pressure
  let pressure = new Array(49).fill(null);
  let pressureCurrent = null;
  if (atmosResult.status === 'fulfilled') {
    const h = atmosResult.value?.hourly;
    if (h) {
      pressure = mapHourlyLocal(h.time, h.surface_pressure);
      const idx = Math.min(48, Math.max(0, Math.round(nowOffset)));
      pressureCurrent = pressure[idx];
    }
  }

  // Update sidebar current values
  function setCrVal(id, val, digits) {
    const el = document.getElementById(id);
    if (el) el.textContent = val != null ? val.toFixed(digits) : '--';
  }
  const cardinalAbbr = deg => {
    if (deg == null) return '--';
    const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return dirs[Math.round(deg / 22.5) % 16];
  };
  const setDirVal = (id, deg) => {
    const el = document.getElementById(id);
    if (el) el.textContent = cardinalAbbr(deg);
  };

  setCrVal('cr-wind-val',     windCurrent,     1);
  setDirVal('cr-winddir-val', windDirCurrent);
  setCrVal('cr-swell-val',    swellCurrent,    1);
  setCrVal('cr-period-val',   periodCurrent,   1);
  setDirVal('cr-swelldir-val', swellDirCurrent);
  setCrVal('cr-tide-val',     tideCurrent,     1);
  setCrVal('cr-temp-val',     tempCurrent,     0);
  setCrVal('cr-precip-val',   precipCurrent,   0);
  setCrVal('cr-cloud-val',    cloudCurrent,    0);
  setCrVal('cr-pressure-val', pressureCurrent, 0);
  setCrVal('cr-current-val',  currentCurrent,  2);
  setDirVal('cr-curdir-val',  currentDirCurrent);

  // Show charts, hide loading message
  if (loading) loading.style.display = 'none';
  if (stack)   stack.style.display   = '';

  // ── Chart helpers ─────────────────────────────────────────────────────────
  const gridColor   = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)';
  const tickColor   = isDark ? '#99a0b0'                : '#6b7280';
  const nowLineClr  = isDark ? 'rgba(255,255,255,0.50)' : 'rgba(0,0,0,0.30)';
  const nowFillClr  = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.025)';

  function nowAnnotations(showLabel) {
    return {
      nowBand: {
        type: 'box',
        xMin: nowOffset - 0.25,
        xMax: nowOffset + 0.25,
        backgroundColor: nowFillClr,
        borderWidth: 0,
        drawTime: 'beforeDatasetsDraw'
      },
      nowLine: {
        type: 'line',
        xMin: nowOffset,
        xMax: nowOffset,
        borderColor: nowLineClr,
        borderWidth: 1.5,
        borderDash: [3, 3],
        drawTime: 'afterDatasetsDraw',
        label: showLabel ? {
          display: true,
          content: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
          position: 'start',
          yAdjust: 6,
          backgroundColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.07)',
          color: isDark ? '#dde' : '#444',
          font: { size: 9, weight: '600' },
          padding: { x: 5, y: 3 },
          borderRadius: 4
        } : { display: false }
      }
    };
  }

  function makeXAxis(isLast) {
    return {
      type: 'linear',
      min: 0,
      max: 48,
      // Always display so Chart.js allocates the same axis height on every row,
      // keeping all plot areas the same width and gridlines aligned.
      display: true,
      grid: { color: gridColor, tickLength: isLast ? 4 : 0 },
      border: { display: false },
      ticks: {
        // Invisible on non-last rows but still measured, so every row gets the
        // same bottom padding and the vertical gridlines stay in sync.
        color: isLast ? tickColor : 'transparent',
        font: { size: 9 },
        maxRotation: 90,
        minRotation: 90,
        stepSize: 6,
        callback(val) {
          if (val < 0 || val > 48 || val % 6 !== 0) return null;
          const t = new Date(windowStart.getTime() + val * 3600000);
          if (val % 24 === 0) {
            // Midnight: compact "Mon 24" to keep label short when rotated
            return t.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' });
          }
          return t.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        }
      }
    };
  }

  function makeYAxis(unitLabel, accentColor) {
    return {
      display: true,
      position: 'right',
      grid: { color: gridColor },
      border: { display: false },
      ticks: {
        color: tickColor,
        font: { size: 9 },
        maxTicksLimit: 4,
        callback: v => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1))
      },
      title: {
        display: true,
        text: unitLabel,
        color: accentColor,
        font: { size: 8, weight: '700' },
        padding: { top: 0, bottom: 0 }
      },
      // Force every y-axis to the same width so all plot areas align
      afterFit(scale) { scale.width = 44; }
    };
  }

  function buildDataset(values, label, unit, digits, borderColor, bgColor, opts = {}) {
    return {
      label,
      unit,
      digits,
      data: values.map((v, i) => ({ x: i, y: v })),
      borderColor,
      backgroundColor: bgColor,
      borderWidth: opts.dashed ? 1.5 : 1.8,
      borderDash: opts.dashed ? [5, 3] : undefined,
      fill: opts.fill !== undefined ? opts.fill : true,
      tension: 0.38,
      pointRadius: 0,
      pointHoverRadius: 3,
      spanGaps: true,
      order: opts.order ?? 0
    };
  }

  function renderChart(canvasId, datasets, unitLabel, accentColor, isLast, yMin, yMax, source) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (conditionsChartInstances[canvasId]) {
      conditionsChartInstances[canvasId].destroy();
      delete conditionsChartInstances[canvasId];
    }
    const yAxis = makeYAxis(unitLabel, accentColor);
    if (yMin != null) yAxis.min = yMin;
    if (yMax != null) yAxis.max = yMax;

    // Draw a dot on each dataset curve at the current moment
    const nowDotPlugin = {
      id: `nowDot_${canvasId}`,
      afterDatasetsDraw(chart) {
        const { ctx, scales: { x, y } } = chart;
        if (nowOffset < 0 || nowOffset > 48) return;
        const px = x.getPixelForValue(nowOffset);
        const i0 = Math.floor(nowOffset);
        const i1 = Math.min(i0 + 1, 48);
        const frac = nowOffset - i0;

        chart.data.datasets.forEach((ds, di) => {
          if (chart.getDatasetMeta(di).hidden) return;
          const y0 = ds.data[i0]?.y;
          const y1 = ds.data[i1]?.y;
          if (y0 == null && y1 == null) return;
          const nowY = (y0 != null && y1 != null) ? y0 + (y1 - y0) * frac : (y0 ?? y1);
          const py = y.getPixelForValue(nowY);
          ctx.save();
          ctx.beginPath();
          ctx.arc(px, py, 4, 0, Math.PI * 2);
          ctx.fillStyle = ds.borderColor;
          ctx.fill();
          ctx.strokeStyle = isDark ? 'rgba(22,22,28,0.85)' : 'rgba(255,255,255,0.85)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.restore();
        });
      }
    };

    const chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 350 },
        layout: { padding: { top: 4, bottom: 0, left: 0, right: 6 } },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            bodyFont: { size: 10 },
            titleFont: { size: 10 },
            callbacks: {
              title([ctx]) {
                const t = new Date(windowStart.getTime() + ctx.parsed.x * 3600000);
                return t.toLocaleString('en-US', {
                  weekday: 'short', month: 'short', day: 'numeric',
                  hour: '2-digit', minute: '2-digit', hour12: false
                });
              },
              label(ctx) {
                if (ctx.parsed.y == null) return null;
                const { label: lbl, unit: u, digits: dg } = ctx.dataset;
                return `${lbl}: ${ctx.parsed.y.toFixed(dg ?? 1)} ${u ?? ''}`;
              },
              footer() {
                return source ? `Source: ${source}` : undefined;
              }
            },
            footerFont: { size: 9, style: 'italic' },
            footerColor: isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.40)',
            footerMarginTop: 4
          },
          annotation: { annotations: nowAnnotations(isLast) }
        },
        scales: {
          x: makeXAxis(isLast),
          y: yAxis
        }
      },
      plugins: [nowDotPlugin, Chart.registry.getPlugin('annotation')]
    });

    conditionsChartInstances[canvasId] = chart;
  }

  // Render a direction row as evenly-spaced arrow glyphs instead of a line.
  // A hidden line dataset is still used so Chart.js handles axes, layout,
  // and hover tooltips identically to all other rows.
  // `comesFrom` marks data reported in the meteorological "coming from"
  // convention (Open-Meteo wind_direction_10m, wave_direction). The arrows show
  // where it is headed, so those bearings are flipped 180° before drawing.
  // Ocean current direction is already a "flowing toward" bearing — no flip.
  function renderDirectionChart(canvasId, dirData, label, accentColor, isLast, source, comesFrom = false) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (conditionsChartInstances[canvasId]) {
      conditionsChartInstances[canvasId].destroy();
      delete conditionsChartInstances[canvasId];
    }

    const dirs16 = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];

    const arrowPlugin = {
      id: `dirArrows_${canvasId}`,
      afterDatasetsDraw(chart) {
        const { ctx, chartArea: { left, right, top, bottom } } = chart;
        const plotW  = right - left;
        const centerY = (top + bottom) / 2;
        const len  = 9;
        const head = 4;

        ctx.save();
        // Clip to the chart area so arrows don't overdraw axes
        ctx.beginPath();
        ctx.rect(left, top, plotW, bottom - top);
        ctx.clip();

        ctx.lineWidth = 1.6;
        ctx.lineCap   = 'round';
        ctx.strokeStyle = accentColor;

        for (let i = 0; i <= 48; i += 3) {
          const dir = dirData[i];
          if (dir == null) continue;
          const px = left + (i / 48) * plotW;
          // Arrows point the way it is going, so flip "coming from" bearings.
          const headingTo = comesFrom ? dir + 180 : dir;
          // 0° = N = "up" on screen → subtract 90° to convert to canvas angle
          const rad = ((headingTo - 90) * Math.PI) / 180;

          ctx.save();
          ctx.translate(px, centerY);
          ctx.rotate(rad);
          ctx.beginPath();
          ctx.moveTo(-len / 2, 0);
          ctx.lineTo( len / 2, 0);
          ctx.moveTo( len / 2, 0);
          ctx.lineTo( len / 2 - head, -head * 0.55);
          ctx.moveTo( len / 2, 0);
          ctx.lineTo( len / 2 - head,  head * 0.55);
          ctx.stroke();
          ctx.restore();
        }

        ctx.restore();
      }
    };

    // Hidden dataset — provides hover hitboxes and keeps layout identical
    const hoverData = dirData.map((v, i) => ({ x: i, y: 0 }));

    const chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        datasets: [{
          label,
          data: hoverData,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: accentColor,
          borderColor: 'transparent',
          backgroundColor: 'transparent',
          borderWidth: 0,
          tension: 0,
          spanGaps: true
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 350 },
        layout: { padding: { top: 4, bottom: 0, left: 0, right: 6 } },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            bodyFont: { size: 10 },
            titleFont: { size: 10 },
            callbacks: {
              title([ctx]) {
                const t = new Date(windowStart.getTime() + ctx.parsed.x * 3600000);
                return t.toLocaleString('en-US', {
                  weekday: 'short', month: 'short', day: 'numeric',
                  hour: '2-digit', minute: '2-digit', hour12: false
                });
              },
              label(ctx) {
                const dir = dirData[Math.round(ctx.parsed.x)];
                if (dir == null) return null;
                const cardinal = dirs16[Math.round(dir / 22.5) % 16];
                const sense = comesFrom ? 'from ' : 'toward ';
                return `${label}: ${sense}${cardinal} (${dir.toFixed(0)}°)`;
              },
              footer() { return source ? `Source: ${source}` : undefined; }
            },
            footerFont: { size: 9, style: 'italic' },
            footerColor: isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.40)',
            footerMarginTop: 4
          },
          annotation: { annotations: nowAnnotations(isLast) }
        },
        scales: {
          x: makeXAxis(isLast),
          y: {
            position: 'right',
            display: true,
            min: -1,
            max: 1,
            grid: { drawOnChartArea: false },
            border: { display: false },
            ticks: { color: 'transparent', font: { size: 8 } },
            afterFit(scale) { scale.width = 44; }
          }
        }
      },
      plugins: [arrowPlugin, Chart.registry.getPlugin('annotation')]
    });

    conditionsChartInstances[canvasId] = chart;
  }

  // ── Render each row ───────────────────────────────────────────────────────

  const OM_FORECAST = 'Open-Meteo Forecast';
  const OM_MARINE   = 'Open-Meteo Marine';
  const NOAA_TIDES  = 'NOAA Tides & Currents';

  // Wind speed + gusts (sky-blue)
  const windAccent = isDark ? '#38bdf8' : '#0ea5e9';
  const windMax = Math.max(15, ...windGust.filter(v => v != null)) * 1.08;
  renderChart('condWindChart', [
    buildDataset(windGust,  'Gusts', 'kts', 1,
      isDark ? 'rgba(56,189,248,0.30)' : 'rgba(14,165,233,0.25)',
      'transparent', { dashed: true, fill: false, order: 1 }),
    buildDataset(windSpeed, 'Wind',  'kts', 1,
      windAccent,
      isDark ? 'rgba(56,189,248,0.14)' : 'rgba(14,165,233,0.10)',
      { order: 0 })
  ], 'kts', windAccent, false, 0, windMax, OM_FORECAST);

  // Wind direction — arrows
  const windDirAccent = isDark ? '#7dd3fc' : '#0369a1';
  renderDirectionChart('condWindDirChart', windDir, 'Wind Dir', windDirAccent, false, OM_FORECAST, true);

  // Swell height (emerald)
  const swellAccent = isDark ? '#34d399' : '#059669';
  const swellMax = Math.max(3, ...swellHeight.filter(v => v != null)) * 1.12;
  renderChart('condSwellChart', [
    buildDataset(swellHeight, 'Swell Height', 'ft', 1,
      swellAccent,
      isDark ? 'rgba(52,211,153,0.14)' : 'rgba(5,150,105,0.10)')
  ], 'ft', swellAccent, false, 0, swellMax, OM_MARINE);

  // Swell period (cyan)
  const periodAccent = isDark ? '#22d3ee' : '#0891b2';
  const validPeriod  = swellPeriod.filter(v => v != null);
  const periodMin    = validPeriod.length ? Math.max(0, Math.min(...validPeriod) - 1) : 0;
  const periodMax    = validPeriod.length ? Math.max(...validPeriod) + 1 : 20;
  renderChart('condPeriodChart', [
    buildDataset(swellPeriod, 'Swell Period', 's', 1,
      periodAccent,
      isDark ? 'rgba(34,211,238,0.14)' : 'rgba(8,145,178,0.10)')
  ], 's', periodAccent, false, periodMin, periodMax, OM_MARINE);

  // Swell direction — arrows
  const swellDirAccent = isDark ? '#2dd4bf' : '#0d9488';
  renderDirectionChart('condSwellDirChart', swellDir, 'Swell Dir', swellDirAccent, false, OM_MARINE, true);

  // Tide (indigo) — may have nulls at start/end; use spanGaps
  const tideAccent = isDark ? '#818cf8' : '#4f46e5';
  const validTide  = tideHeight.filter(v => v != null);
  const tideMin    = validTide.length ? Math.min(...validTide) - 0.6 : -2;
  const tideMax    = validTide.length ? Math.max(...validTide) + 0.6 :  6;
  renderChart('condTideChart', [
    buildDataset(tideHeight, tideStationName ? `Tide (${tideStationName})` : 'Tide', 'ft', 1,
      tideAccent,
      isDark ? 'rgba(129,140,248,0.14)' : 'rgba(79,70,229,0.10)')
  ], 'ft', tideAccent, false, tideMin, tideMax, NOAA_TIDES);

  // Ocean current speed (violet)
  const curAccent = isDark ? '#c084fc' : '#9333ea';
  const validCur  = currentSpeed.filter(v => v != null);
  const curMax    = validCur.length ? Math.max(0.5, ...validCur) * 1.12 : 1;
  renderChart('condCurrentChart', [
    buildDataset(currentSpeed, 'Current', 'kts', 2,
      curAccent,
      isDark ? 'rgba(192,132,252,0.14)' : 'rgba(147,51,234,0.10)')
  ], 'kts', curAccent, false, 0, curMax, OM_MARINE);

  // Current direction — arrows
  const curDirAccent = isDark ? '#e879f9' : '#a21caf';
  renderDirectionChart('condCurrentDirChart', currentDir, 'Current Dir', curDirAccent, false, OM_MARINE);

  // Temperature (orange)
  const tempAccent  = isDark ? '#fb923c' : '#ea580c';
  const validTemp   = temperature.filter(v => v != null);
  const tempMinY    = validTemp.length ? Math.min(...validTemp) - 4 : 40;
  const tempMaxY    = validTemp.length ? Math.max(...validTemp) + 4 : 80;
  renderChart('condTempChart', [
    buildDataset(temperature, 'Temp', '°F', 0,
      tempAccent,
      isDark ? 'rgba(251,146,60,0.14)' : 'rgba(234,88,12,0.10)')
  ], '°F', tempAccent, false, tempMinY, tempMaxY, OM_FORECAST);

  // Precipitation probability (light blue)
  const precipAccent = isDark ? '#93c5fd' : '#2563eb';
  renderChart('condPrecipChart', [
    buildDataset(precipProb, 'Precip', '%', 0,
      precipAccent,
      isDark ? 'rgba(147,197,253,0.20)' : 'rgba(37,99,235,0.12)')
  ], '%', precipAccent, false, 0, 100, OM_FORECAST);

  // Cloud cover (slate)
  const cloudAccent = isDark ? '#94a3b8' : '#64748b';
  renderChart('condCloudChart', [
    buildDataset(cloudCover, 'Cloud', '%', 0,
      cloudAccent,
      isDark ? 'rgba(148,163,184,0.16)' : 'rgba(100,116,139,0.10)')
  ], '%', cloudAccent, false, 0, 100, OM_FORECAST);

  // Pressure (amber) — last row, shows x-axis
  const pressureAccent = isDark ? '#fbbf24' : '#d97706';
  const validPressure  = pressure.filter(v => v != null);
  const pressureMin    = validPressure.length ? Math.min(...validPressure) - 2 : 990;
  const pressureMax    = validPressure.length ? Math.max(...validPressure) + 2 : 1030;
  renderChart('condPressureChart', [
    buildDataset(pressure, 'Pressure', 'hPa', 0,
      pressureAccent,
      isDark ? 'rgba(251,191,36,0.14)' : 'rgba(217,119,6,0.10)')
  ], 'hPa', pressureAccent, true, pressureMin, pressureMax, OM_FORECAST);
}

// Dark mode functionality
function initDarkMode() {
  const darkModeToggle = document.getElementById('darkModeToggle');
  const html = document.documentElement;

  // Check for saved theme preference, then vessel config, then fall back to light
  const savedTheme = localStorage.getItem('theme') || vesselData?.theme || 'marine';
  html.setAttribute('data-theme', savedTheme);
  updateDarkModeButton(savedTheme);

  darkModeToggle.addEventListener('click', () => {
      const currentTheme = html.getAttribute('data-theme');
      const newTheme = THEMES[(THEMES.indexOf(currentTheme) + 1) % THEMES.length];

      // Apply theme immediately
      html.setAttribute('data-theme', newTheme);
      localStorage.setItem('theme', newTheme);
      updateDarkModeButton(newTheme);

      // Debounce the expensive chart redraws
      if (themeChangeTimeout) clearTimeout(themeChangeTimeout);
      themeChangeTimeout = setTimeout(() => {
        updateChartsForTheme(newTheme);
        refreshSparklines?.();
      }, 150);
    });
}

function updateDarkModeButton(theme) {
  const button = document.getElementById('darkModeToggle');
  button.textContent = theme.charAt(0).toUpperCase() + theme.slice(1);
  button.style.background = isDarkTheme(theme) ? '#555e6e' : '#2c3e50';
  button.style.color = '#fff';
}

function updateChartsForTheme(theme) {
  const isDark = isDarkTheme(theme);

  // Update tide chart
  if (tideChartInstance) {
    tideChartInstance.options.scales.x.grid.color = isDark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.08)';
    tideChartInstance.options.scales.y.grid.color = isDark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.08)';
    tideChartInstance.options.scales.x.ticks.color = isDark ? '#ffffff' : '#2c3e50';
    tideChartInstance.options.scales.y.ticks.color = isDark ? '#ffffff' : '#2c3e50';
    tideChartInstance.options.scales.x.title.color = isDark ? '#ffffff' : '#2c3e50';
    tideChartInstance.options.scales.y.title.color = isDark ? '#ffffff' : '#2c3e50';
    tideChartInstance.data.datasets[0].borderColor = isDark ? '#60a5fa' : '#2563eb';
    tideChartInstance.data.datasets[0].backgroundColor = isDark ? 'rgba(96,165,250,0.12)' : 'rgba(37,99,235,0.1)';

    // Update annotations if they exist
    if (tideChartInstance.options.plugins.annotation && tideChartInstance.options.plugins.annotation.annotations) {
      tideChartInstance.options.plugins.annotation.annotations.forEach(annotation => {
        if (annotation.type === 'label') {
          annotation.backgroundColor = isDark ? 'rgba(96,165,250,0.9)' : 'rgba(37,99,235,0.85)';
          annotation.color = '#ffffff';
          annotation.borderColor = isDark ? '#60a5fa' : '#2563eb';
        }
      });
    }

    tideChartInstance.update();
  }

  // Update polar chart - force complete redraw for point labels
  if (polarData && !isDrawingPolarChart) {
    // Destroy existing chart if it exists
    if (polarChartInstance) {
      polarChartInstance.destroy();
      polarChartInstance = null;
    }

    // Use the same logic as updatePolarPerformance for consistency
    let windAngle = null;
    if (currentEnv?.wind?.angleTrue?.value) {
      windAngle = currentEnv.wind.angleTrue.value;
    } else if (currentEnv?.wind?.angleTrueWater?.value) {
      windAngle = currentEnv.wind.angleTrueWater.value;
    } else if (currentEnv?.wind?.angleApparent?.value) {
      windAngle = currentEnv.wind.angleApparent.value;
    }

    let boatSpeed = null;
    if (currentNav?.speedThroughWater?.value) {
      boatSpeed = currentNav.speedThroughWater.value;
    } else if (currentNav?.speedOverGround?.value) {
      boatSpeed = currentNav.speedOverGround.value;
    }

    let windSpeed = null;
    if (currentEnv?.wind?.speedTrue?.value) {
      windSpeed = currentEnv.wind.speedTrue.value;
    }

    // Use default values if data is missing (same as updatePolarPerformance)
    const twa = windAngle ? windAngle * 180 / Math.PI : 90;
    const bsp = boatSpeed ? boatSpeed * 1.94384 : 0;
    const tws = windSpeed ? windSpeed * 1.94384 : 10;

    // Always draw the chart to ensure it appears
    drawPolarChart(twa, bsp, tws);

  }

  // Staleness class drives status-hero colors via CSS; no inline style needed here.

  // Redraw conditions forecast charts with new theme colors
  if (Object.keys(conditionsChartInstances).length > 0) {
    loadConditionsForecast().catch(err => console.error('Conditions forecast theme error:', err));
  }

  // Update map tile layer
  if (map) {
    map.eachLayer((layer) => {
      if (layer instanceof L.TileLayer) {
        map.removeLayer(layer);
      }
    });

    tileLayerForTheme().addTo(map);

    // Re-add marker if it exists
    if (marker) {
      marker.addTo(map);
    }
  }

  // Update anchor distance colors in the data grid
  const anchorDistanceElement = document.querySelector('.info-item .value[style*="color"]');
  if (anchorDistanceElement && anchorDistanceElement.textContent.includes('ft')) {
    const theme = document.documentElement.getAttribute('data-theme');
    // Find the anchor distance element and update its color
    const anchorItems = document.querySelectorAll('.info-item');
    anchorItems.forEach(item => {
      const label = item.querySelector('.label');
      const value = item.querySelector('.value');
      if (label && label.textContent === 'Anchor Distance' && value) {
        const currentColor = value.style.color;
        // Check if it's currently red or green and update accordingly
        if (currentColor.includes('#e74c3c') || currentColor.includes('#ff6b6b')) {
          // Currently red (outside safe radius)
          value.style.color = getAnchorDistanceColor(true, theme);
        } else if (currentColor.includes('#27ae60') || currentColor.includes('#51cf66')) {
          // Currently green (inside safe radius)
          value.style.color = getAnchorDistanceColor(false, theme);
        }
      }
    });
  }
}

    document.addEventListener("DOMContentLoaded", async function() {
  primeSkeletons();
  // Load vessel data first
  await loadVesselData();

  // Load tide stations data
  await loadTideStations();

  initDarkMode();
  loadPolarData();
  loadVoyageStats();
  loadData();

  // Real-time SignalK updates removed; using static data only

  // Unit toggle: click/tap any info-item with data-unit-group to cycle its units.
  document.addEventListener('click', (e) => {
    const item = e.target.closest('.info-item[data-unit-group]');
    if (!item) return;
    const group = item.dataset.unitGroup;
    if (!UNIT_GROUPS[group]) return;
    unitPrefs[group] = ((unitPrefs[group] || 0) + 1) % UNIT_GROUPS[group].length;
    try { localStorage.setItem(UNIT_PREFS_KEY, JSON.stringify(unitPrefs)); } catch {}
    // Re-render every box in this group from its stored raw SI value.
    document.querySelectorAll(`.info-item[data-unit-group="${group}"]`).forEach(el => {
      const raw = parseFloat(el.dataset.raw);
      const valueEl = el.querySelector('.value');
      if (!valueEl) return;
      let formatted = fmtUnit(group, Number.isFinite(raw) ? raw : null);
      // Tank volume items store the level% separately; reconstruct the combined display.
      if (group === 'volume' && el.dataset.level) {
        const lvl = el.dataset.level;
        if (lvl && lvl !== 'N/A' && formatted !== 'N/A') {
          valueEl.innerHTML = `<span>${lvl}</span><span class="value-sub">${formatted}</span>`;
        } else {
          valueEl.textContent = (lvl && lvl !== 'N/A') ? lvl : (formatted !== 'N/A' ? formatted : 'N/A');
        }
      } else {
        // Preserve colour spans produced by colorValue(); only update the text.
        const inner = valueEl.querySelector('span') || valueEl;
        inner.textContent = formatted;
      }
    });
    if (refreshSparklines) refreshSparklines();
  });

  setInterval(() => {
    loadConditionsForecast().catch(err => console.error('Conditions forecast error:', err));
  }, C.FORECAST_CACHE_TTL_MS);
});
