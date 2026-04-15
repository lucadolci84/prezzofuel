import { geocodePlace, loadDataset, buildResults, json } from "./_lib.js";

export default async function handler(req, res) {
    try {
        const q = String(req.query.q || req.query.cap || "").trim();
        const radiusKm = Math.max(1, Math.min(80, Number(req.query.radius || 5)));
        const fuels = String(req.query.fuels || "benzina,diesel,gpl,metano")
            .split(",")
            .map(x => x.trim())
            .filter(Boolean);

        if (!q) {
            return json(res, 400, { ok: false, error: "Inserisci un CAP o un indirizzo" });
        }

        const geo = await geocodePlace(q);
        const dataset = await loadDataset();
        const results = buildResults({
            stations: dataset.stations,
            prices: dataset.prices,
            lat: geo.lat,
            lon: geo.lon,
            radiusKm,
            fuels,
        });

        results.sort((a, b) => a.migliorPrezzo - b.migliorPrezzo || a.distanzaKm - b.distanzaKm);

        return json(res, 200, {
            ok: true,
            query: q,
            position: geo,
            radiusKm,
            fuels,
            count: results.length,
            source: "MIMIT + Nominatim",
            results,
        });
    } catch (err) {
        return json(res, 502, { ok: false, error: err.message });
    }
}