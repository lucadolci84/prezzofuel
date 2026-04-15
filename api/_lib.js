const DATA_URLS = {
  stations: "https://www.mimit.gov.it/images/exportCSV/anagrafica_impianti_attivi.csv",
  prices: "https://www.mimit.gov.it/images/exportCSV/prezzo_alle_8.csv",
};

const globalCache = globalThis.__prezzofuel_cache ?? {
  dataset: {
    expiresAt: 0,
    stations: [],
    prices: [],
  },
  geocode: new Map(),
};

globalThis.__prezzofuel_cache = globalCache;

const TTL_MS = 15 * 60 * 1000;

export function json(res, status, payload) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.send(JSON.stringify(payload));
}

export function csvToRows(text) {
  const lines = String(text || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean);

  if (!lines.length) return [];

  let start = 0;
  if (/^Estrazione del /i.test(lines[0])) start = 1;

  const dataLines = lines.slice(start);
  if (!dataLines.length) return [];

  const delimiter = dataLines[0].includes("|") ? "|" : ";";
  return dataLines.map(line => line.split(delimiter).map(x => x.trim()));
}

export function normalizeHeaderName(x) {
  return String(x || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "_");
}

export function parseStationCsv(csvText) {
  const rows = csvToRows(csvText);
  if (rows.length < 2) return [];

  const headers = rows[0].map(normalizeHeaderName);
  const idx = name => headers.indexOf(name);

  const idIdx = idx("idimpianto");
  const gestoreIdx = idx("gestore");
  const bandieraIdx = idx("bandiera");
  const tipoIdx = idx("tipo_impianto");
  const nomeIdx = idx("nome_impianto");
  const indirizzoIdx = idx("indirizzo");
  const comuneIdx = idx("comune");
  const provIdx = idx("provincia");
  const latIdx = idx("latitudine");
  const lonIdx = idx("longitudine");

  const out = [];

  for (let i = 1; i < rows.length; i++) {
    const c = rows[i];
    const lat = parseFloat(String(c[latIdx] || "").replace(",", "."));
    const lon = parseFloat(String(c[lonIdx] || "").replace(",", "."));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    out.push({
      id: String(c[idIdx] || "").trim(),
      gestore: String(c[gestoreIdx] || "").trim(),
      bandiera: String(c[bandieraIdx] || "").trim(),
      tipoImpianto: String(c[tipoIdx] || "").trim(),
      nome: String(c[nomeIdx] || "").trim(),
      indirizzo: String(c[indirizzoIdx] || "").trim(),
      comune: String(c[comuneIdx] || "").trim(),
      provincia: String(c[provIdx] || "").trim(),
      lat,
      lon,
    });
  }

  return out;
}

export function parsePriceCsv(csvText) {
  const rows = csvToRows(csvText);
  if (rows.length < 2) return [];

  const headers = rows[0].map(normalizeHeaderName);
  const idx = name => headers.indexOf(name);

  const idIdx = idx("idimpianto");
  const carbIdx = idx("desccarburante");
  const prezzoIdx = idx("prezzo");
  const selfIdx = idx("isself");
  const dtIdx = idx("dtcomu");

  const out = [];

  for (let i = 1; i < rows.length; i++) {
    const c = rows[i];
    const prezzo = parseFloat(String(c[prezzoIdx] || "").replace(",", "."));
    if (!Number.isFinite(prezzo) || prezzo <= 0) continue;

    out.push({
      id: String(c[idIdx] || "").trim(),
      carburante: String(c[carbIdx] || "").trim(),
      prezzo,
      self: String(c[selfIdx] || "").trim() === "1",
      aggiornatoAl: String(c[dtIdx] || "").trim(),
    });
  }

  return out;
}

export function normalizeFuel(raw) {
  const s = String(raw || "").toLowerCase();
  if (/benzina/.test(s)) return "benzina";
  if (/gasolio|diesel/.test(s)) return "diesel";
  if (/gpl/.test(s)) return "gpl";
  if (/metano/.test(s)) return "metano";
  if (/hvo/.test(s)) return "hvo";
  return null;
}

export function parseDateFlexible(input) {
  if (!input) return 0;
  const p = String(input).trim().replace(",", "");
  if (p.includes("/")) {
    const [date, time = "00:00:00"] = p.split(" ");
    const [d, m, y] = date.split("/");
    return new Date(`${y}-${m}-${d}T${time}`).getTime() || 0;
  }
  return new Date(p).getTime() || 0;
}

export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function safeFetchText(url, label) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 PrezzoFuel/1.0",
        "Accept": "text/csv,text/plain,*/*",
      },
    });
  } catch {
    throw new Error(`${label}: errore di rete`);
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  if (!text || text.length < 50) throw new Error(`${label}: risposta vuota o sospetta`);

  return text;
}

export async function loadDataset() {
  if (
    Date.now() < globalCache.dataset.expiresAt &&
    globalCache.dataset.stations.length &&
    globalCache.dataset.prices.length
  ) {
    return globalCache.dataset;
  }

  const [stationsCsv, pricesCsv] = await Promise.all([
    safeFetchText(DATA_URLS.stations, "CSV impianti"),
    safeFetchText(DATA_URLS.prices, "CSV prezzi"),
  ]);

  const stations = parseStationCsv(stationsCsv);
  const prices = parsePriceCsv(pricesCsv);

  if (!stations.length || !prices.length) {
    throw new Error("Dataset vuoto o non valido");
  }

  globalCache.dataset = {
    expiresAt: Date.now() + TTL_MS,
    stations,
    prices,
  };

  return globalCache.dataset;
}

export async function geocodePlace(input) {
    const raw = String(input || "").trim();
    if (!raw) {
        throw new Error("Inserisci un CAP o un indirizzo");
    }

    const cacheKey = raw.toLowerCase();
    const cached = globalCache.geocode.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const isCap = /^\d{5}$/.test(raw);

    const params = new URLSearchParams({
        format: "jsonv2",
        limit: "1",
        countrycodes: "it",
        "accept-language": "it",
    });

    if (isCap) {
        params.set("postalcode", raw);
        params.set("country", "Italy");
    } else {
        params.set("q", raw);
    }

    const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;

    let res;
    try {
        res = await fetch(url, {
            headers: {
                "Accept": "application/json",
                "Accept-Language": "it",
                "User-Agent": "Mozilla/5.0 PrezzoFuel/1.0",
            },
        });
    } catch {
        throw new Error("Geocoding: errore di rete");
    }

    if (!res.ok) throw new Error(`Geocoding: HTTP ${res.status}`);

    const data = await res.json();
    if (!Array.isArray(data) || !data.length) {
        throw new Error(isCap ? "CAP non trovato" : "Indirizzo non trovato");
    }

    const value = {
        lat: parseFloat(data[0].lat),
        lon: parseFloat(data[0].lon),
        label: data[0].display_name || raw,
        query: raw,
        type: isCap ? "cap" : "address",
    };

    globalCache.geocode.set(cacheKey, {
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        value,
    });

    return value;
}

export function buildResults({ stations, prices, lat, lon, radiusKm, fuels }) {
  const activeFuels = new Set(
    (fuels?.length ? fuels : ["benzina", "diesel", "gpl", "metano"]).map(x =>
      String(x).toLowerCase()
    )
  );

  const nearby = stations
    .map(s => ({ ...s, distanzaKm: haversine(lat, lon, s.lat, s.lon) }))
    .filter(s => s.distanzaKm <= radiusKm)
    .sort((a, b) => a.distanzaKm - b.distanzaKm);

  const priceMap = new Map();
  for (const p of prices) {
    const tipo = normalizeFuel(p.carburante);
    if (!tipo || !activeFuels.has(tipo)) continue;
    const list = priceMap.get(p.id) || [];
    list.push({
      tipo,
      prezzo: p.prezzo,
      self: p.self,
      aggiornatoAl: p.aggiornatoAl,
      timestamp: parseDateFlexible(p.aggiornatoAl),
      carburanteOriginale: p.carburante,
    });
    priceMap.set(p.id, list);
  }

  return nearby
    .filter(s => priceMap.has(s.id))
    .map(s => {
      const prezziStazione = priceMap.get(s.id).sort((a, b) => a.prezzo - b.prezzo);
      return {
        id: s.id,
        nome: s.bandiera || s.gestore || s.nome || "Impianto",
        indirizzo: s.indirizzo,
        comune: s.comune,
        provincia: s.provincia,
        lat: s.lat,
        lon: s.lon,
        distanzaKm: Number(s.distanzaKm.toFixed(2)),
        migliorPrezzo: prezziStazione[0]?.prezzo ?? null,
        aggiornamentoPiuRecente: Math.max(...prezziStazione.map(x => x.timestamp)),
        prezzi: prezziStazione,
      };
    });
}