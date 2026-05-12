import { geocodePlace, haversine, json, publicError, csvToRows } from './_lib.js';

const OCM_BASE_URL = 'https://api.openchargemap.io/v3/poi/';
const CACHE_TTL_MS = 10 * 60 * 1000;
const FEED_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_RADIUS_KM = 80;
const MAX_RESULTS = 100;

// Fallback trasparente quando non c'e un listino puntuale per l'operatore.
// Valori medi pay-per-use Italia da analisi MIMIT/BMTI aprile 2025:
// AC 0,66 EUR/kWh, DC 0,80 EUR/kWh, HPC 0,86 EUR/kWh.
const MARKET_AVERAGE_SOURCE = 'MIMIT/BMTI prezzo medio ricarica pubblica aprile 2025';
const MARKET_AVERAGE_PRICES = {
  ac: { label: 'Stima media AC', eurPerKwh: 0.66, minPowerKw: 0, maxPowerKw: 49.99 },
  dc: { label: 'Stima media DC rapida', eurPerKwh: 0.80, minPowerKw: 50, maxPowerKw: 149.99 },
  hpc: { label: 'Stima media HPC ultrarapida', eurPerKwh: 0.86, minPowerKw: 150, maxPowerKw: null },
};

const cache = globalThis.__prezzofuel_ev_cache ?? {
  ocm: new Map(),
  tariffs: { expiresAt: 0, rows: [], sources: [] },
  stationFeeds: new Map(),
};
globalThis.__prezzofuel_ev_cache = cache;

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}


function normalizeKey(value) {
  return normalizeText(value).replace(/\s+/g, '_');
}

function pickField(row, names) {
  if (!row || typeof row !== 'object') return null;
  const directKeys = Object.keys(row);
  const normalizedMap = new Map(directKeys.map((key) => [normalizeKey(key), key]));
  for (const name of names) {
    const direct = row[name];
    if (direct !== undefined && direct !== null && String(direct).trim() !== '') return direct;
    const normalized = normalizeKey(name);
    const key = normalizedMap.get(normalized);
    if (key && row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') return row[key];
  }
  return null;
}

function parseMaybeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim().replace(',', '.').replace(/[^0-9.\-]/g, '');
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function parseOperationalFromText(value) {
  if (value === true || value === false) return value;
  const text = normalizeText(value);
  if (!text) return null;
  if (/fuori servizio|out of service|offline|non operativo|non disponibile|guasto|in manutenzione|unavailable|inoperative/.test(text)) return false;
  if (/operativo|available|disponibile|active|attivo|in servizio|working|ok/.test(text)) return true;
  return null;
}

function parseExternalDate(row) {
  return pickField(row, [
    'updatedAt', 'updated_at', 'lastUpdated', 'last_updated', 'data_aggiornamento',
    'dataAggiornamento', 'dateLastUpdated', 'dateLastModified', 'DateLastModified',
    'DateLastVerified', 'DateLastStatusUpdate', 'createdAt', 'data_inserimento'
  ]);
}

function parseExternalLatLon(row) {
  const geometry = row?.geometry || row?.Geometry || null;
  if (geometry && Array.isArray(geometry.coordinates) && geometry.coordinates.length >= 2) {
    const lon = parseMaybeNumber(geometry.coordinates[0]);
    const lat = parseMaybeNumber(geometry.coordinates[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  }
  if (geometry && (geometry.x !== undefined || geometry.y !== undefined)) {
    const lon = parseMaybeNumber(geometry.x);
    const lat = parseMaybeNumber(geometry.y);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  }

  const lat = parseMaybeNumber(pickField(row, ['lat', 'latitude', 'latitudine', 'y', 'LAT', 'LATITUDINE']));
  const lon = parseMaybeNumber(pickField(row, ['lon', 'lng', 'longitude', 'longitudine', 'x', 'LON', 'LONGITUDINE']));
  if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  return null;
}

function stationSourcesFor(station) {
  if (Array.isArray(station.sources) && station.sources.length) return station.sources;
  return [station.source || 'Fonte esterna'].filter(Boolean);
}

function stationSourceLinksFor(station) {
  if (Array.isArray(station.sourceLinks) && station.sourceLinks.length) return station.sourceLinks;
  const sources = stationSourcesFor(station);
  return sources.map((name) => ({ name, url: station.sourceUrl || null }));
}

function parseConnectorFilters(raw) {
  const values = String(raw || '')
    .split(',')
    .map((x) => normalizeText(x))
    .filter(Boolean);
  return new Set(values);
}

function connectorMatches(connection, filters) {
  if (!filters || !filters.size) return true;
  const haystack = normalizeText([
    connection.type,
    connection.currentType,
    connection.level,
  ].filter(Boolean).join(' '));

  for (const filter of filters) {
    if (filter === 'ccs' && /ccs|combo/.test(haystack)) return true;
    if (filter === 'type2' && /type\s*2|mennekes/.test(haystack)) return true;
    if (filter === 'chademo' && /chademo/.test(haystack)) return true;
    if (filter === 'tesla' && /tesla|nacs/.test(haystack)) return true;
    if (haystack.includes(filter)) return true;
  }
  return false;
}

function parseItalianNumber(value) {
  const n = Number(String(value || '').replace(',', '.').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function dateTimestamp(value) {
  if (!value) return 0;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function latestDateEntry(entries) {
  return entries
    .map((entry) => ({ ...entry, timestamp: dateTimestamp(entry.value) }))
    .filter((entry) => entry.timestamp > 0)
    .sort((a, b) => b.timestamp - a.timestamp)[0] || null;
}

function latestDateValue(values) {
  const latest = latestDateEntry(values.map((value) => ({ value })));
  return latest ? latest.value : null;
}

function openChargeMapUpdateInfo(row) {
  return latestDateEntry([
    { field: 'DateLastVerified', value: row?.DateLastVerified },
    { field: 'DateLastStatusUpdate', value: row?.DateLastStatusUpdate },
    { field: 'DateLastConfirmed', value: row?.DateLastConfirmed },
    { field: 'DateLastModified', value: row?.DateLastModified },
    { field: 'DateCreated', value: row?.DateCreated },
  ]);
}


function parseBooleanFlag(value) {
  const normalized = normalizeText(value);
  return ['1', 'true', 'yes', 'si', 'solo operative', 'operative'].includes(normalized);
}

function buildRadiusSearchPlan(radiusKm) {
  const base = clampNumber(radiusKm, 1, MAX_RADIUS_KM, 10);
  const candidates = [base, 25, 50, MAX_RADIUS_KM]
    .filter((value) => value >= base && value <= MAX_RADIUS_KM);
  return [...new Set(candidates)].sort((a, b) => a - b);
}

function stationOperationalValue(station) {
  const values = (station.connections || [])
    .map((connection) => connection.isOperational)
    .filter((value) => value === true || value === false);

  if (values.some((value) => value === true)) return true;
  if (station.isOperational === true) return true;
  if (station.isOperational === false) return false;
  if (values.length && values.every((value) => value === false)) return false;
  return null;
}

function connectionMatchesPowerBand(connection, band) {
  const powerKw = Number(connection.powerKw || 0);
  const text = normalizeText(`${connection.type} ${connection.currentType} ${connection.level}`);

  if (band === 'ac') return (powerKw > 0 && powerKw < 50) || (/\bac\b|type 2|mennekes/.test(text) && !/ccs|combo|chademo|dc/.test(text));
  if (band === 'dc') return (powerKw >= 50 && powerKw < 150) || (/ccs|combo|chademo|\bdc\b/.test(text) && powerKw < 150);
  if (band === 'hpc') return powerKw >= 150;
  if (band === 'ultra300') return powerKw >= 300;
  return true;
}

function stationMatchesPowerBands(station, powerBands) {
  if (!powerBands || !powerBands.size) return true;
  return (station.connections || []).some((connection) => {
    for (const band of powerBands) {
      if (connectionMatchesPowerBand(connection, band)) return true;
    }
    return false;
  });
}

function buildDataQuality(station) {
  const missingFields = [];
  if (!station.address) missingFields.push('indirizzo');
  if (!station.maxPowerKw) missingFields.push('potenza');
  if (station.isOperational !== true && station.isOperational !== false) missingFields.push('stato');
  if (!station.updatedAt) missingFields.push('aggiornamento');

  const timestamp = dateTimestamp(station.updatedAt);
  if (!timestamp) {
    return {
      level: 'incomplete',
      label: 'Dato incompleto',
      detail: missingFields.length ? `Manca: ${missingFields.join(', ')}` : 'Aggiornamento non disponibile',
      ageDays: null,
      missingFields,
    };
  }

  const ageDays = Math.max(0, Math.round((Date.now() - timestamp) / 86400000));
  let level = 'recent';
  let label = 'Dato recente';
  let detail = 'Aggiornato negli ultimi 90 giorni';

  if (ageDays > 365) {
    level = 'stale';
    label = 'Dato vecchio';
    detail = 'Aggiornato da oltre 1 anno';
  } else if (ageDays > 90) {
    level = 'verify';
    label = 'Dato da verificare';
    detail = 'Aggiornato da oltre 90 giorni';
  }

  if (missingFields.length >= 2) {
    level = 'incomplete';
    label = 'Dato incompleto';
    detail = `Manca: ${missingFields.join(', ')}`;
  }

  return { level, label, detail, ageDays, missingFields };
}

function buildCostEstimate(price, estimateKwh) {
  const kwh = Number(estimateKwh);
  if (!price || !Number.isFinite(kwh) || kwh <= 0) return null;
  if (price.unit !== 'EUR/kWh' || !Number.isFinite(price.min) || price.min <= 0) return null;

  const fixedFee = Number.isFinite(price.fixedFee) ? price.fixedFee : 0;
  const estimated = price.min * kwh + fixedFee;
  return {
    kwh,
    amount: Number(estimated.toFixed(2)),
    display: `${estimated.toFixed(2)} EUR per ${kwh.toFixed(kwh % 1 ? 1 : 0)} kWh`,
    note: fixedFee > 0 ? 'Include eventuale costo fisso rilevato' : 'Stima sul solo prezzo energia',
  };
}

function numericPrice(station) {
  const n = Number(station?.price?.min);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function scaleScore(value, min, max, invert = false, fallback = 0.35) {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)) return fallback;
  if (max <= min) return 1;
  const normalized = Math.max(0, Math.min(1, (value - min) / (max - min)));
  return invert ? 1 - normalized : normalized;
}

function applyRecommendationScores(results) {
  const prices = results.map(numericPrice).filter((value) => Number.isFinite(value));
  const distances = results.map((station) => Number(station.distanceKm)).filter((value) => Number.isFinite(value));
  const powers = results.map((station) => Number(station.maxPowerKw || 0)).filter((value) => Number.isFinite(value));

  const minPrice = prices.length ? Math.min(...prices) : null;
  const maxPrice = prices.length ? Math.max(...prices) : null;
  const minDistance = distances.length ? Math.min(...distances) : null;
  const maxDistance = distances.length ? Math.max(...distances) : null;
  const minPower = powers.length ? Math.min(...powers) : 0;
  const maxPower = powers.length ? Math.max(...powers) : 300;

  return results.map((station) => {
    const price = numericPrice(station);
    const confidenceMultiplier = station.price?.confidence === 'indicative'
      ? 1
      : station.price?.confidence === 'estimated'
        ? 0.7
        : station.price?.confidence === 'low'
          ? 0.55
          : 0.3;
    const priceScore = scaleScore(price, minPrice, maxPrice, true, 0.25) * confidenceMultiplier;
    const distanceScore = scaleScore(Number(station.distanceKm), minDistance, maxDistance, true, 0.5);
    const powerScore = scaleScore(Number(station.maxPowerKw || 0), minPower, Math.max(maxPower || 0, 50), false, 0.35);
    const freshnessScore = station.dataQuality?.level === 'recent'
      ? 1
      : station.dataQuality?.level === 'verify'
        ? 0.7
        : station.dataQuality?.level === 'stale'
          ? 0.35
          : 0.15;
    const operationalScore = station.isOperational === true ? 1 : station.isOperational === false ? 0 : 0.45;

    const score = (
      priceScore * 0.32
      + distanceScore * 0.24
      + powerScore * 0.18
      + freshnessScore * 0.14
      + operationalScore * 0.12
    ) * 100;

    const reasons = [];
    if (station.isOperational === true) reasons.push('operativa');
    if (station.dataQuality?.level === 'recent') reasons.push('dato recente');
    if (Number.isFinite(price)) reasons.push('prezzo confrontabile');
    if (Number(station.maxPowerKw || 0) >= 150) reasons.push('alta potenza');
    if (Number(station.distanceKm || 0) <= 5) reasons.push('vicina');

    return {
      ...station,
      recommendationScore: Math.round(score),
      recommendationReasons: reasons.slice(0, 3),
    };
  });
}

function parseUsageCostText(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];

  const candidates = [];
  const eurKwh = raw.match(/(\d+(?:[.,]\d+)?)\s*(?:€|eur)?\s*\/?\s*k\s*w\s*h/i)
    || raw.match(/(?:€|eur)\s*(\d+(?:[.,]\d+)?)\s*\/?\s*k\s*w\s*h/i);
  const eurMinute = raw.match(/(\d+(?:[.,]\d+)?)\s*(?:€|eur)?\s*\/?\s*(?:min|minute|minuto)/i)
    || raw.match(/(?:€|eur)\s*(\d+(?:[.,]\d+)?)\s*\/?\s*(?:min|minute|minuto)/i);
  const fixedFee = raw.match(/(?:fee|start|sessione|scatto|attivazione)[^0-9]*(\d+(?:[.,]\d+)?)/i);

  if (eurKwh) {
    candidates.push({
      source: 'OpenChargeMap UsageCost',
      label: 'Costo dichiarato su OpenChargeMap',
      eurPerKwh: parseItalianNumber(eurKwh[1]),
      note: raw,
      confidence: 'low',
    });
  }
  if (eurMinute) {
    candidates.push({
      source: 'OpenChargeMap UsageCost',
      label: 'Costo al minuto dichiarato su OpenChargeMap',
      eurPerMinute: parseItalianNumber(eurMinute[1]),
      note: raw,
      confidence: 'low',
    });
  }
  if (fixedFee && candidates.length) {
    candidates.forEach((candidate) => {
      candidate.fixedFee = parseItalianNumber(fixedFee[1]);
    });
  }
  if (!candidates.length && raw) {
    candidates.push({
      source: 'OpenChargeMap UsageCost',
      label: 'Nota costo da OpenChargeMap',
      note: raw,
      confidence: 'text-only',
    });
  }
  return candidates.filter((x) => x.eurPerKwh || x.eurPerMinute || x.note);
}

function getOcmApiKey() {
  return String(
    process.env.OCM_API_KEY
      || process.env.OPENCHARGEMAP_API_KEY
      || process.env.OPEN_CHARGE_MAP_API_KEY
      || ''
  ).trim();
}

function redactUrl(url) {
  try {
    const safe = new URL(url);
    if (safe.searchParams.has('key')) safe.searchParams.set('key', '***');
    return safe.toString();
  } catch {
    return String(url).replace(/([?&]key=)[^&]+/i, '$1***');
  }
}

function textSnippet(text, maxLength = 220) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'PrezzoFuel/1.0 EV charging search',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      const snippet = textSnippet(text);
      const status = response.status ? `HTTP ${response.status}` : 'risposta non JSON';
      throw new Error(`${status}: risposta non JSON da ${redactUrl(url)}${snippet ? ` - ${snippet}` : ''}`);
    }
  }

  if (!response.ok) {
    const message = data?.message || data?.error || data?.Error || `HTTP ${response.status}`;
    throw new Error(String(message));
  }
  return data;
}

async function fetchOpenChargeMap({ lat, lon, radiusKm, maxResults }) {
  const apiKey = getOcmApiKey();
  if (!apiKey) {
    throw new Error('OCM_API_KEY non caricata. In locale crea un file .env.local nella cartella principale del progetto e riavvia npm run dev.');
  }

  const params = new URLSearchParams({
    output: 'json',
    countrycode: 'IT',
    latitude: String(lat),
    longitude: String(lon),
    distance: String(radiusKm),
    distanceunit: 'KM',
    maxresults: String(maxResults),
    compact: 'false',
    verbose: 'false',
    key: apiKey,
  });

  const url = `${OCM_BASE_URL}?${params.toString()}`;
  const cacheKey = redactUrl(url);
  const cached = cache.ocm.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.rows;

  const rows = await fetchJson(url, {
    headers: {
      'X-API-Key': apiKey,
    },
  });
  if (!Array.isArray(rows)) throw new Error('OpenChargeMap: risposta inattesa');
  cache.ocm.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, rows });
  return rows;
}


function stationFeedSources() {
  const configured = [];
  const add = (name, value) => {
    String(value || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .forEach((url) => configured.push({ name, url }));
  };

  add('Feed colonnine', process.env.EV_STATIONS_URL || process.env.EV_STATIONS_URLS);
  add('PUN / feed nazionale', process.env.PUN_STATIONS_URL || process.env.PUN_EV_STATIONS_URL);
  add('Plenitude', process.env.PLENITUDE_STATIONS_URL || process.env.BECHARGE_STATIONS_URL);
  add('Electromaps', process.env.ELECTROMAPS_STATIONS_URL);

  return configured;
}

function asStationArrayPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.stations)) return payload.stations;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.features)) {
    return payload.features.map((feature) => ({
      ...(feature.properties || {}),
      ...(feature.attributes || {}),
      geometry: feature.geometry || null,
    }));
  }
  if (Array.isArray(payload?.features?.features)) return asStationArrayPayload(payload.features);
  return [];
}

function csvPayloadToObjects(text) {
  const rows = csvToRows(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => String(h || '').trim());
  return rows.slice(1).map((cells) => {
    const obj = {};
    headers.forEach((header, index) => {
      obj[header] = cells[index] ?? '';
    });
    return obj;
  });
}

async function fetchStationFeed(source) {
  const cacheKey = `${source.name}:${source.url}`;
  const cached = cache.stationFeeds.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const response = await fetch(source.url, {
    headers: {
      Accept: 'application/json, text/csv, text/plain;q=0.9, */*;q=0.8',
      'User-Agent': 'PrezzoFuel/1.0 EV station feed aggregator',
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${source.name}: HTTP ${response.status}`);

  let rows = [];
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('json') || /^[\s\r\n]*[\[{]/.test(text)) {
    rows = asStationArrayPayload(JSON.parse(text));
  } else {
    rows = csvPayloadToObjects(text);
  }

  const payload = { expiresAt: Date.now() + FEED_CACHE_TTL_MS, rows, source };
  cache.stationFeeds.set(cacheKey, payload);
  return payload;
}

function normalizeExternalStation(row, center, source) {
  const normalizedRow = row?.attributes || row?.properties || row || {};
  const coords = parseExternalLatLon(normalizedRow);
  if (!coords) return null;

  const title = String(pickField(normalizedRow, [
    'title', 'name', 'nome', 'nome_stazione', 'denominazione', 'stationName',
    'indirizzo', 'address', 'ubicazione', 'locationName'
  ]) || 'Colonnina').trim();

  const operator = String(pickField(normalizedRow, [
    'operator', 'gestore', 'cpo', 'network', 'provider', 'operatore', 'brand', 'societa', 'società'
  ]) || '').trim() || null;

  const address = [
    pickField(normalizedRow, ['address', 'indirizzo', 'via', 'ubicazione', 'location']),
    pickField(normalizedRow, ['town', 'comune', 'city', 'municipality']),
    pickField(normalizedRow, ['province', 'provincia', 'state', 'regione']),
    pickField(normalizedRow, ['postcode', 'cap', 'zip'])
  ].filter(Boolean).join(', ');

  const connectorType = String(pickField(normalizedRow, [
    'connector', 'connectors', 'tipo_connettore', 'tipoPresa', 'tipo_presa',
    'connectionType', 'standard', 'presa'
  ]) || '').trim() || null;
  const currentType = String(pickField(normalizedRow, ['currentType', 'corrente', 'alimentazione', 'tipo_alimentazione']) || '').trim() || null;
  const powerKw = parseMaybeNumber(pickField(normalizedRow, [
    'powerKw', 'power_kw', 'potenza', 'potenza_kw', 'potenzaMassima', 'potenza_massima',
    'maxPowerKw', 'max_power_kw', 'kw'
  ]));
  const statusRaw = pickField(normalizedRow, ['status', 'stato', 'availability', 'disponibilita', 'disponibilità']);
  const isOperational = parseOperationalFromText(statusRaw);

  const connection = {
    id: pickField(normalizedRow, ['connectorId', 'id_connettore', 'socketId']) || null,
    type: connectorType,
    currentType,
    status: statusRaw ? String(statusRaw) : null,
    isOperational,
    level: null,
    amps: parseMaybeNumber(pickField(normalizedRow, ['amps', 'ampere'])) || null,
    voltage: parseMaybeNumber(pickField(normalizedRow, ['voltage', 'volt', 'tensione'])) || null,
    powerKw,
    quantity: parseMaybeNumber(pickField(normalizedRow, ['quantity', 'numero_prese', 'num_connectors'])) || null,
  };

  const idRaw = pickField(normalizedRow, ['id', 'stationId', 'station_id', 'id_stazione', 'codice', 'uid']);
  const sourceUrl = pickField(normalizedRow, ['url', 'sourceUrl', 'link', 'scheda', 'detailUrl']) || null;
  const updatedAt = parseExternalDate(normalizedRow);

  return {
    id: `${normalizeText(source.name) || 'feed'}:${idRaw || `${coords.lat},${coords.lon},${title}`}`,
    title,
    operator,
    usageCostText: pickField(normalizedRow, ['usageCost', 'costo', 'tariffa', 'price', 'prezzo']) || null,
    updatedAt,
    updatedAtField: updatedAt ? 'feed' : null,
    verifiedAt: null,
    statusUpdatedAt: null,
    createdAt: null,
    address,
    town: pickField(normalizedRow, ['town', 'comune', 'city']) || null,
    province: pickField(normalizedRow, ['province', 'provincia', 'state']) || null,
    postcode: pickField(normalizedRow, ['postcode', 'cap', 'zip']) || null,
    lat: coords.lat,
    lon: coords.lon,
    distanceKm: Number(haversine(center.lat, center.lon, coords.lat, coords.lon).toFixed(2)),
    status: statusRaw ? String(statusRaw) : null,
    isOperational,
    maxPowerKw: powerKw || null,
    connections: connectorType || powerKw || statusRaw ? [connection] : [],
    source: source.name,
    sourceUrl,
    sources: [source.name],
    sourceLinks: [{ name: source.name, url: sourceUrl }],
    externalRawSource: source.url,
  };
}

async function loadExternalStations(center) {
  const sources = stationFeedSources();
  if (!sources.length) return { rows: [], sources: [], errors: [] };

  const rows = [];
  const loadedSources = [];
  const errors = [];

  for (const source of sources) {
    try {
      const payload = await fetchStationFeed(source);
      loadedSources.push(source.name);
      rows.push(...payload.rows
        .map((row) => normalizeExternalStation(row, center, source))
        .filter(Boolean));
    } catch (err) {
      errors.push({ source: source.name, error: publicError(err, `${source.name} non disponibile`) });
      console.warn(`Feed colonnine non disponibile ${source.name}:`, err.message);
    }
  }

  return { rows, sources: loadedSources, errors };
}

function mergeStationPair(a, b) {
  const sourceLinks = [...stationSourceLinksFor(a), ...stationSourceLinksFor(b)];
  const sourceNames = [...new Set([...stationSourcesFor(a), ...stationSourcesFor(b)])];
  const connections = [...(a.connections || []), ...(b.connections || [])];
  const latest = latestDateValue([a.updatedAt, b.updatedAt]);
  const isOperational = stationOperationalValue({
    isOperational: a.isOperational === true || b.isOperational === true ? true : (a.isOperational === false && b.isOperational === false ? false : null),
    connections,
  });

  return {
    ...a,
    title: a.title && a.title !== 'Colonnina' ? a.title : b.title,
    operator: a.operator || b.operator,
    address: a.address || b.address,
    town: a.town || b.town,
    province: a.province || b.province,
    postcode: a.postcode || b.postcode,
    status: a.status || b.status,
    isOperational,
    updatedAt: latest,
    updatedAtField: latest === a.updatedAt ? a.updatedAtField : b.updatedAtField,
    maxPowerKw: Math.max(Number(a.maxPowerKw || 0), Number(b.maxPowerKw || 0)) || null,
    connections,
    source: sourceNames.join(' + '),
    sources: sourceNames,
    sourceUrl: a.sourceUrl || b.sourceUrl,
    sourceLinks,
    mergedSourcesCount: sourceNames.length,
    usageCostText: a.usageCostText || b.usageCostText,
  };
}

function shouldMergeStations(a, b) {
  const distanceMeters = haversine(a.lat, a.lon, b.lat, b.lon) * 1000;
  if (distanceMeters <= 60) return true;
  const sameAddress = normalizeText(a.address) && normalizeText(a.address) === normalizeText(b.address);
  const sameTitle = normalizeText(a.title) && normalizeText(a.title) === normalizeText(b.title);
  return distanceMeters <= 180 && (sameAddress || sameTitle);
}

function mergeStations(stations) {
  const merged = [];
  for (const station of stations) {
    const index = merged.findIndex((candidate) => shouldMergeStations(candidate, station));
    if (index >= 0) {
      merged[index] = mergeStationPair(merged[index], station);
    } else {
      merged.push(station);
    }
  }
  return merged;
}

function buildExternalLookupLinks(center) {
  const label = center?.query || center?.label || `${center.lat},${center.lon}`;
  const encoded = encodeURIComponent(label);
  return [
    {
      name: 'PUN Maps',
      label: 'Verifica sulla mappa nazionale PUN',
      url: 'https://www.piattaformaunicanazionale.it/',
      note: 'Fonte istituzionale italiana: utile se OpenChargeMap non copre bene la zona.',
    },
    {
      name: 'Electromaps',
      label: 'Verifica su Electromaps',
      url: `https://www.electromaps.com/en/charging-stations?search=${encoded}`,
      note: 'Fonte community/commerciale: richiede verifica diretta sul sito o app.',
    },
    {
      name: 'Plenitude On the Road',
      label: 'Verifica su Plenitude On the Road',
      url: 'https://eniplenitude.eu/',
      note: 'Rete CPO: integrazione dati diretta solo con feed/API autorizzato.',
    },
  ];
}

function asArrayPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.tariffs)) return payload.tariffs;
  if (Array.isArray(payload?.results)) return payload.results;
  return [];
}

async function loadTariffs() {
  if (cache.tariffs.expiresAt > Date.now()) return cache.tariffs;

  const rows = [];
  const sources = [];

  if (process.env.EV_TARIFFS_JSON) {
    try {
      rows.push(...asArrayPayload(JSON.parse(process.env.EV_TARIFFS_JSON)));
      sources.push('EV_TARIFFS_JSON');
    } catch (err) {
      console.warn('EV_TARIFFS_JSON non valido:', err.message);
    }
  }

  const urls = String(process.env.EV_TARIFFS_URL || process.env.EV_TARIFFS_URLS || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

  for (const url of urls) {
    try {
      const payload = await fetchJson(url);
      rows.push(...asArrayPayload(payload));
      sources.push(url);
    } catch (err) {
      console.warn(`Tariff feed non disponibile ${url}:`, err.message);
    }
  }

  const normalizedRows = rows
    .map(normalizeTariffRow)
    .filter((row) => row.operator && row.prices.length);

  cache.tariffs = {
    expiresAt: Date.now() + CACHE_TTL_MS,
    rows: normalizedRows,
    sources,
  };
  return cache.tariffs;
}

function normalizeTariffRow(row) {
  const prices = Array.isArray(row?.prices) ? row.prices : [row];
  const operator = String(row?.operator || row?.cpo || row?.provider || '').trim();
  const aliases = [operator, ...(row?.aliases || [])]
    .map(normalizeText)
    .filter(Boolean);

  return {
    operator,
    aliases,
    source: String(row?.source || row?.sourceName || 'Tariff feed').trim(),
    updatedAt: row?.updatedAt || row?.updated_at || null,
    prices: prices.map((price) => ({
      label: String(price?.label || price?.name || '').trim(),
      minPowerKw: Number.isFinite(Number(price?.minPowerKw)) ? Number(price.minPowerKw) : null,
      maxPowerKw: Number.isFinite(Number(price?.maxPowerKw)) ? Number(price.maxPowerKw) : null,
      connectorTypes: Array.isArray(price?.connectorTypes)
        ? price.connectorTypes.map(normalizeText).filter(Boolean)
        : [],
      eurPerKwh: Number.isFinite(Number(price?.eurPerKwh)) ? Number(price.eurPerKwh) : null,
      eurPerMinute: Number.isFinite(Number(price?.eurPerMinute)) ? Number(price.eurPerMinute) : null,
      fixedFee: Number.isFinite(Number(price?.fixedFee)) ? Number(price.fixedFee) : null,
      parkingFee: price?.parkingFee ?? null,
      note: String(price?.note || row?.note || '').trim(),
    })).filter((price) => price.eurPerKwh || price.eurPerMinute || price.fixedFee || price.note),
  };
}

function tariffOperatorMatches(tariff, operatorName) {
  const normalizedOperator = normalizeText(operatorName);
  if (!normalizedOperator) return false;
  return tariff.aliases.some((alias) => alias && (normalizedOperator.includes(alias) || alias.includes(normalizedOperator)));
}

function priceMatchesConnection(price, connection) {
  const powerKw = Number(connection.powerKw || 0);
  if (price.minPowerKw !== null && powerKw && powerKw < price.minPowerKw) return false;
  if (price.maxPowerKw !== null && powerKw && powerKw > price.maxPowerKw) return false;
  if (price.connectorTypes.length) {
    const text = normalizeText(`${connection.type} ${connection.currentType}`);
    return price.connectorTypes.some((connector) => text.includes(connector) || connector.includes(text));
  }
  return true;
}

function buildTariffCandidates(station, tariffs) {
  const candidates = [];
  const operatorName = station.operator || station.title || '';

  for (const tariff of tariffs) {
    if (!tariffOperatorMatches(tariff, operatorName)) continue;
    for (const price of tariff.prices) {
      const matchingConnections = station.connections.filter((connection) => priceMatchesConnection(price, connection));
      if (!matchingConnections.length && station.connections.length) continue;
      candidates.push({
        source: tariff.source,
        operator: tariff.operator,
        label: price.label || tariff.operator,
        eurPerKwh: price.eurPerKwh,
        eurPerMinute: price.eurPerMinute,
        fixedFee: price.fixedFee,
        parkingFee: price.parkingFee,
        note: price.note,
        updatedAt: tariff.updatedAt,
        confidence: 'matched-operator',
      });
    }
  }

  return candidates;
}

function hasStructuredPrice(candidates) {
  return candidates.some((candidate) => (
    Number.isFinite(candidate.eurPerKwh) && candidate.eurPerKwh > 0
  ) || (
    Number.isFinite(candidate.eurPerMinute) && candidate.eurPerMinute > 0
  ));
}

function classifyStationPower(station) {
  const maxPowerKw = Number(station.maxPowerKw || 0);
  const hasDcConnector = (station.connections || []).some((connection) => {
    const text = normalizeText(`${connection.type} ${connection.currentType} ${connection.level}`);
    return /ccs|combo|chademo|dc|supercharger|tesla/.test(text);
  });

  if (maxPowerKw >= 150) return 'hpc';
  if (maxPowerKw >= 50 || hasDcConnector) return 'dc';
  return 'ac';
}

function buildMarketAverageCandidate(station) {
  const tier = classifyStationPower(station);
  const price = MARKET_AVERAGE_PRICES[tier] || MARKET_AVERAGE_PRICES.ac;
  return {
    source: MARKET_AVERAGE_SOURCE,
    operator: station.operator || null,
    label: price.label,
    eurPerKwh: price.eurPerKwh,
    eurPerMinute: null,
    fixedFee: null,
    parkingFee: null,
    note: 'Stima media nazionale: non e un prezzo live della singola colonnina.',
    updatedAt: '2025-04-01',
    confidence: 'estimated-market-average',
  };
}

function summarizePrice(candidates, estimateKwh) {
  const eurPerKwh = candidates
    .map((x) => x.eurPerKwh)
    .filter((x) => Number.isFinite(x) && x > 0)
    .sort((a, b) => a - b);
  const eurPerMinute = candidates
    .map((x) => x.eurPerMinute)
    .filter((x) => Number.isFinite(x) && x > 0)
    .sort((a, b) => a - b);

  if (eurPerKwh.length) {
    const min = eurPerKwh[0];
    const max = eurPerKwh[eurPerKwh.length - 1];
    const bestCandidate = candidates.find((x) => Number.isFinite(x.eurPerKwh) && x.eurPerKwh === min);
    const price = {
      unit: 'EUR/kWh',
      min,
      max,
      fixedFee: Number.isFinite(bestCandidate?.fixedFee) ? bestCandidate.fixedFee : null,
      display: min === max ? `${min.toFixed(2)} €/kWh` : `${min.toFixed(2)}-${max.toFixed(2)} €/kWh`,
      confidence: candidates.some((x) => x.confidence === 'matched-operator')
        ? 'indicative'
        : candidates.some((x) => x.confidence === 'estimated-market-average')
          ? 'estimated'
          : 'low',
      label: bestCandidate?.label || null,
      source: bestCandidate?.source || null,
      updatedAt: bestCandidate?.updatedAt || null,
    };
    price.estimate = buildCostEstimate(price, estimateKwh);
    return price;
  }

  if (eurPerMinute.length) {
    const min = eurPerMinute[0];
    const max = eurPerMinute[eurPerMinute.length - 1];
    const bestCandidate = candidates.find((x) => Number.isFinite(x.eurPerMinute) && x.eurPerMinute === min);
    return {
      unit: 'EUR/min',
      min,
      max,
      display: min === max ? `${min.toFixed(2)} €/min` : `${min.toFixed(2)}-${max.toFixed(2)} €/min`,
      confidence: 'low',
      label: bestCandidate?.label || null,
      source: bestCandidate?.source || null,
      updatedAt: bestCandidate?.updatedAt || null,
      estimate: null,
    };
  }

  if (candidates.length) {
    return {
      unit: 'text',
      display: candidates[0].note || candidates[0].label || 'Prezzo non strutturato',
      confidence: 'text-only',
      label: candidates[0].label || null,
      source: candidates[0].source || null,
      updatedAt: candidates[0].updatedAt || null,
      estimate: null,
    };
  }

  return {
    unit: null,
    min: null,
    max: null,
    display: 'Prezzo non disponibile via API pubblica',
    confidence: 'missing',
    estimate: null,
  };
}

function transformOcmStation(row, center, connectorFilters) {
  const address = row?.AddressInfo || {};
  const rawConnections = Array.isArray(row?.Connections) ? row.Connections : [];
  const connections = rawConnections.map((connection) => ({
    id: connection.ID || null,
    type: connection.ConnectionType?.Title || null,
    currentType: connection.CurrentType?.Title || null,
    status: connection.StatusType?.Title || null,
    isOperational: connection.StatusType?.IsOperational ?? null,
    level: connection.Level?.Title || null,
    amps: connection.Amps || null,
    voltage: connection.Voltage || null,
    powerKw: Number.isFinite(Number(connection.PowerKW)) ? Number(connection.PowerKW) : null,
    quantity: connection.Quantity || null,
  })).filter((connection) => connectorMatches(connection, connectorFilters));

  if (!connections.length) return null;

  const lat = Number(address.Latitude);
  const lon = Number(address.Longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const title = String(address.Title || row?.OperatorInfo?.Title || 'Colonnina').trim();
  const updateInfo = openChargeMapUpdateInfo(row);
  return {
    id: `ocm:${row.ID}`,
    ocmId: row.ID,
    uuid: row.UUID || null,
    title,
    operator: row?.OperatorInfo?.Title || null,
    usageCostText: row?.UsageCost || null,
    updatedAt: updateInfo?.value || null,
    updatedAtField: updateInfo?.field || null,
    verifiedAt: row?.DateLastVerified || null,
    statusUpdatedAt: row?.DateLastStatusUpdate || null,
    createdAt: row?.DateCreated || null,
    address: [address.AddressLine1, address.Town, address.StateOrProvince, address.Postcode]
      .filter(Boolean)
      .join(', '),
    town: address.Town || null,
    province: address.StateOrProvince || null,
    postcode: address.Postcode || null,
    lat,
    lon,
    distanceKm: Number(haversine(center.lat, center.lon, lat, lon).toFixed(2)),
    status: row?.StatusType?.Title || null,
    isOperational: row?.StatusType?.IsOperational ?? null,
    maxPowerKw: connections.reduce((max, connection) => Math.max(max, Number(connection.powerKw || 0)), 0) || null,
    connections,
    source: 'OpenChargeMap',
    sourceUrl: row.ID ? `https://openchargemap.org/site/poi/details/${row.ID}` : null,
  };
}

function sortResults(results, sort) {
  const mode = String(sort || 'recommended').toLowerCase();
  const numericPriceForSort = (station) => Number.isFinite(station.price?.min) ? station.price.min : Number.POSITIVE_INFINITY;
  const updatedTs = (station) => dateTimestamp(station.updatedAt);

  if (mode === 'distance') {
    results.sort((a, b) => a.distanceKm - b.distanceKm || numericPriceForSort(a) - numericPriceForSort(b));
  } else if (mode === 'power') {
    results.sort((a, b) => (b.maxPowerKw || 0) - (a.maxPowerKw || 0) || a.distanceKm - b.distanceKm);
  } else if (mode === 'freshness') {
    results.sort((a, b) => updatedTs(b) - updatedTs(a) || a.distanceKm - b.distanceKm);
  } else if (mode === 'price') {
    results.sort((a, b) => numericPriceForSort(a) - numericPriceForSort(b) || a.distanceKm - b.distanceKm);
  } else {
    results.sort((a, b) => (b.recommendationScore || 0) - (a.recommendationScore || 0) || a.distanceKm - b.distanceKm);
  }
  return results;
}

function buildEvResults(ocmRows, externalStations, center, filters, tariffRows, radiusKm, estimateKwh) {
  const ocmStations = ocmRows
    .map((row) => transformOcmStation(row, center, filters.connectorFilters))
    .filter(Boolean);

  const rows = mergeStations([
    ...ocmStations,
    ...externalStations.filter((station) => (station.connections || []).some((connection) => connectorMatches(connection, filters.connectorFilters)) || !filters.connectorFilters.size),
  ])
    .map((station) => {
      const stationWithOps = {
        ...station,
        isOperational: stationOperationalValue(station),
      };
      const dataQuality = buildDataQuality(stationWithOps);
      return { ...stationWithOps, dataQuality };
    })
    .filter((station) => station.distanceKm <= radiusKm)
    .filter((station) => !filters.operationalOnly || station.isOperational === true)
    .filter((station) => stationMatchesPowerBands(station, filters.powerBands))
    .map((station) => {
      const tariffCandidates = [
        ...buildTariffCandidates(station, tariffRows),
        ...parseUsageCostText(station.usageCostText),
      ];
      if (!hasStructuredPrice(tariffCandidates)) {
        tariffCandidates.push(buildMarketAverageCandidate(station));
      }
      const price = summarizePrice(tariffCandidates, estimateKwh);
      return { ...station, price, tariffCandidates };
    });

  return applyRecommendationScores(rows);
}

export default async function handler(req, res) {
  try {
    const q = String(req.query.q || req.query.cap || '').trim();
    const latParam = Number(req.query.lat);
    const lonParam = Number(req.query.lon);
    const requestedRadiusKm = clampNumber(req.query.radius || req.query.raggio, 1, MAX_RADIUS_KM, 10);
    const maxResults = clampNumber(req.query.maxResults, 1, MAX_RESULTS, 75);
    const connectorFilters = parseConnectorFilters(req.query.connectors || req.query.connector);
    const powerBands = parseConnectorFilters(req.query.power || req.query.powerBands || req.query.power_band);
    const operationalOnly = parseBooleanFlag(req.query.operational || req.query.onlyOperational || req.query.soloOperative);
    const estimateKwh = clampNumber(req.query.kwh || req.query.estimateKwh, 5, 120, 30);

    let center;
    if (Number.isFinite(latParam) && Number.isFinite(lonParam)) {
      center = { lat: latParam, lon: lonParam, label: `${latParam}, ${lonParam}`, query: null, type: 'coordinates' };
    } else {
      if (!q) return json(res, 400, { ok: false, error: 'Inserisci un CAP, un indirizzo o lat/lon' });
      center = await geocodePlace(q);
    }

    const tariffData = await loadTariffs();
    const radiusPlan = buildRadiusSearchPlan(requestedRadiusKm);
    const externalData = await loadExternalStations(center);
    let results = [];
    let radiusKm = requestedRadiusKm;
    let ocmRows = [];

    for (const radiusCandidate of radiusPlan) {
      radiusKm = radiusCandidate;
      ocmRows = await fetchOpenChargeMap({ lat: center.lat, lon: center.lon, radiusKm: radiusCandidate, maxResults });
      results = buildEvResults(
        ocmRows,
        externalData.rows,
        center,
        { connectorFilters, powerBands, operationalOnly },
        tariffData.rows,
        radiusCandidate,
        estimateKwh
      );
      if (results.length || radiusCandidate === radiusPlan[radiusPlan.length - 1]) break;
    }

    sortResults(results, req.query.sort);
    const latestStationsUpdatedAt = latestDateValue(results.map((station) => station.updatedAt));
    const autoExpanded = radiusKm > requestedRadiusKm;

    return json(res, 200, {
      ok: true,
      query: q || null,
      center,
      radiusKm,
      requestedRadiusKm,
      autoExpanded,
      connectors: [...connectorFilters],
      filters: {
        powerBands: [...powerBands],
        operationalOnly,
        estimateKwh,
        sort: String(req.query.sort || 'recommended'),
      },
      count: results.length,
      updatedAt: latestStationsUpdatedAt,
      sources: {
        stations: [...new Set(['OpenChargeMap', ...externalData.sources])],
        stationFeedErrors: externalData.errors,
        stationsUpdatedAt: latestStationsUpdatedAt,
        prices: [MARKET_AVERAGE_SOURCE, 'OpenChargeMap UsageCost', ...tariffData.sources],
      },
      externalLookupLinks: buildExternalLookupLinks(center),
      pricingNote: 'Prezzi, stato e disponibilità EV sono indicativi: verifica sempre in app o sul provider prima di avviare la ricarica.',
      cache: {
        evStations: {
          ttlSeconds: Math.round(CACHE_TTL_MS / 1000),
          scope: externalData.sources.length ? 'openchargemap-plus-external-feeds' : 'openchargemap-poi'
        },
        tariffs: {
          ttlSeconds: Math.round(CACHE_TTL_MS / 1000),
          configuredSources: tariffData.sources.length
        }
      },
      results,
    });
  } catch (err) {
    return json(res, 502, {
      ok: false,
      error: publicError(err, 'Errore ricerca colonnine'),
      debug: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
}
