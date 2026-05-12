import * as lib from './_lib.js';

function hasValue(value) {
  return String(value || '').trim().length > 0;
}

function mask(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  return text.length <= 8 ? '***' : text.slice(0, 4) + '...' + text.slice(-4);
}

function getFuelCacheMeta() {
  if (typeof lib.datasetMeta === 'function') {
    return lib.datasetMeta();
  }
  return {
    scope: 'fuel-dataset',
    available: false,
    note: 'Cache carburanti non disponibile: api/_lib.js non aggiornato alla v5.1.',
  };
}

export default async function handler(req, res) {
  const ocmKey = process.env.OCM_API_KEY || process.env.OPENCHARGEMAP_API_KEY || process.env.OPEN_CHARGE_MAP_API_KEY || '';
  const deep = ['1', 'true', 'yes'].includes(String(req.query?.deep || '').toLowerCase());

  const payload = {
    ok: true,
    app: 'prezzofuel',
    version: '5.1',
    runtime: process.env.VERCEL ? 'vercel' : 'local-or-node',
    node: process.version,
    environment: process.env.NODE_ENV || 'development',
    ocmApiKeyLoaded: hasValue(ocmKey),
    ocmApiKeyPreview: mask(ocmKey),
    openChargeMapAliasLoaded: hasValue(process.env.OPENCHARGEMAP_API_KEY) || hasValue(process.env.OPEN_CHARGE_MAP_API_KEY),
    evTariffFeedConfigured: hasValue(process.env.EV_TARIFFS_JSON) || hasValue(process.env.EV_TARIFFS_URL) || hasValue(process.env.EV_TARIFFS_URLS),
    evStationFeedConfigured: hasValue(process.env.EV_STATIONS_URL) || hasValue(process.env.EV_STATIONS_URLS) || hasValue(process.env.PUN_STATIONS_URL) || hasValue(process.env.PLENITUDE_STATIONS_URL) || hasValue(process.env.ELECTROMAPS_STATIONS_URL),
    fuelCache: getFuelCacheMeta(),
  };

  if (deep) {
    payload.note = 'Controllo leggero: verifica configurazione e stato cache, senza forzare chiamate esterne.';
  }

  return lib.json(res, 200, payload);
}
