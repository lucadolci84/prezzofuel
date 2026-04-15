import { geocodePlace, json } from "./_lib.js";

export default async function handler(req, res) {
    try {
        const q = String(req.query.q || req.query.cap || "").trim();

        if (!q) {
            return json(res, 400, { ok: false, error: "Inserisci un CAP o un indirizzo" });
        }

        const result = await geocodePlace(q);
        return json(res, 200, { ok: true, ...result });
    } catch (err) {
        return json(res, 502, { ok: false, error: err.message });
    }
}