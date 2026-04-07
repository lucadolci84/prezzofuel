import { geocodeCap, json } from "./_lib.js";

export default async function handler(req, res) {
  try {
    const cap = String(req.query.cap || "").trim();
    if (!/^\d{5}$/.test(cap)) {
      return json(res, 400, { ok: false, error: "CAP non valido" });
    }

    const result = await geocodeCap(cap);
    return json(res, 200, { ok: true, ...result });
  } catch (err) {
    return json(res, 502, { ok: false, error: err.message });
  }
}