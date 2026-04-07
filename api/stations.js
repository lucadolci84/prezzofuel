import { loadDataset, buildResults, json } from "./_lib.js";

export default async function handler(req, res) {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    const radiusKm = Math.max(1, Math.min(80, Number(req.query.radius || 5)));
    const fuels = String(req.query.fuels || "benzina,diesel,gpl,metano")
      .split(",")
      .map(x => x.trim())
      .filter(Boolean);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return json(res, 400, { ok: false, error: "lat/lon non validi" });
    }

    const dataset = await loadDataset();
    const results = buildResults({
      stations: dataset.stations,
      prices: dataset.prices,
      lat,
      lon,
      radiusKm,
      fuels,
    });

    results.sort((a, b) => a.migliorPrezzo - b.migliorPrezzo || a.distanzaKm - b.distanzaKm);

    return json(res, 200, {
      ok: true,
      center: { lat, lon },
      radiusKm,
      fuels,
      count: results.length,
      source: "MIMIT",
      results,
    });
  } catch (err) {
    return json(res, 502, { ok: false, error: err.message });
  }
}