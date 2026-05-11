import { geocodePlace, haversine, json } from './_lib.js';

const OCM_BASE_URL = 'https://api.openchargemap.io/v3/poi/';
const CACHE_TTL_MS = 10 * 60 * 1000;
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
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Risposta JSON non valida da ${url}`);
  }
  if (!response.ok) {
    const message = data?.message || data?.error || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}

async function fetchOpenChargeMap({ lat, lon, radiusKm, maxResults }) {
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
  });

  if (process.env.OCM_API_KEY) {
    params.set('key', process.env.OCM_API_KEY);
  }

  const url = `${OCM_BASE_URL}?${params.toString()}`;
  const cached = cache.ocm.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.rows;

  const rows = await fetchJson(url);
  if (!Array.isArray(rows)) throw new Error('OpenChargeMap: risposta inattesa');
  cache.ocm.set(url, { expiresAt: Date.now() + CACHE_TTL_MS, rows });
  return rows;
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
    updatedAt: '2025-04',
    confidence: 'estimated-market-average',
  };
}

function summarizePrice(candidates) {
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
    return {
      unit: 'EUR/kWh',
      min,
      max,
      display: min === max ? `${min.toFixed(2)} €/kWh` : `${min.toFixed(2)}-${max.toFixed(2)} €/kWh`,
      confidence: candidates.some((x) => x.confidence === 'matched-operator')
        ? 'indicative'
        : candidates.some((x) => x.confidence === 'estimated-market-average')
          ? 'estimated'
          : 'low',
      label: candidates.find((x) => Number.isFinite(x.eurPerKwh) && x.eurPerKwh === min)?.label || null,
      source: candidates.find((x) => Number.isFinite(x.eurPerKwh) && x.eurPerKwh === min)?.source || null,
    };
  }

  if (eurPerMinute.length) {
    const min = eurPerMinute[0];
    const max = eurPerMinute[eurPerMinute.length - 1];
    return {
      unit: 'EUR/min',
      min,
      max,
      display: min === max ? `${min.toFixed(2)} €/min` : `${min.toFixed(2)}-${max.toFixed(2)} €/min`,
      confidence: 'low',
    };
  }

  if (candidates.length) {
    return {
      unit: 'text',
      display: candidates[0].note || candidates[0].label || 'Prezzo non strutturato',
      confidence: 'text-only',
    };
  }

  return {
    unit: null,
    min: null,
    max: null,
    display: 'Prezzo non disponibile via API pubblica',
    confidence: 'missing',
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
  return {
    id: `ocm:${row.ID}`,
    ocmId: row.ID,
    uuid: row.UUID || null,
    title,
    operator: row?.OperatorInfo?.Title || null,
    usageCostText: row?.UsageCost || null,
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
  };
}

function sortResults(results, sort) {
  const mode = String(sort || 'price').toLowerCase();
  const numericPrice = (station) => Number.isFinite(station.price?.min) ? station.price.min : Number.POSITIVE_INFINITY;
  if (mode === 'distance') {
    results.sort((a, b) => a.distanceKm - b.distanceKm || numericPrice(a) - numericPrice(b));
  } else if (mode === 'power') {
    results.sort((a, b) => (b.maxPowerKw || 0) - (a.maxPowerKw || 0) || a.distanceKm - b.distanceKm);
  } else {
    results.sort((a, b) => numericPrice(a) - numericPrice(b) || a.distanceKm - b.distanceKm);
  }
  return results;
}

export default async function handler(req, res) {
  try {
    const q = String(req.query.q || req.query.cap || '').trim();
    const latParam = Number(req.query.lat);
    const lonParam = Number(req.query.lon);
    const radiusKm = clampNumber(req.query.radius || req.query.raggio, 1, MAX_RADIUS_KM, 10);
    const maxResults = clampNumber(req.query.maxResults, 1, MAX_RESULTS, 50);
    const connectorFilters = parseConnectorFilters(req.query.connectors || req.query.connector);

    let center;
    if (Number.isFinite(latParam) && Number.isFinite(lonParam)) {
      center = { lat: latParam, lon: lonParam, label: `${latParam}, ${lonParam}`, query: null, type: 'coordinates' };
    } else {
      if (!q) return json(res, 400, { ok: false, error: 'Inserisci un CAP, un indirizzo o lat/lon' });
      center = await geocodePlace(q);
    }

    const [ocmRows, tariffData] = await Promise.all([
      fetchOpenChargeMap({ lat: center.lat, lon: center.lon, radiusKm, maxResults }),
      loadTariffs(),
    ]);

    const results = ocmRows
      .map((row) => transformOcmStation(row, center, connectorFilters))
      .filter(Boolean)
      .map((station) => {
        const tariffCandidates = [
          ...buildTariffCandidates(station, tariffData.rows),
          ...parseUsageCostText(station.usageCostText),
        ];
        if (!hasStructuredPrice(tariffCandidates)) {
          tariffCandidates.push(buildMarketAverageCandidate(station));
        }
        const price = summarizePrice(tariffCandidates);
        return { ...station, price, tariffCandidates };
      })
      .filter((station) => station.distanceKm <= radiusKm);

    sortResults(results, req.query.sort);

    return json(res, 200, {
      ok: true,
      query: q || null,
      center,
      radiusKm,
      connectors: [...connectorFilters],
      count: results.length,
      sources: {
        stations: ['OpenChargeMap'],
        prices: [MARKET_AVERAGE_SOURCE, 'OpenChargeMap UsageCost', ...tariffData.sources],
      },
      pricingNote: null,
      results,
    });
  } catch (err) {
    return json(res, 502, { ok: false, error: err.message || 'Errore ricerca colonnine' });
  }
}
