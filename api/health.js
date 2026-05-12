import { json } from './_lib.js';

function hasValue(value) {
  return String(value || '').trim().length > 0;
}

export default async function handler(req, res) {
  return json(res, 200, {
    ok: true,
    runtime: 'local-or-vercel',
    ocmApiKeyLoaded: hasValue(process.env.OCM_API_KEY),
    openChargeMapAliasLoaded: hasValue(process.env.OPENCHARGEMAP_API_KEY) || hasValue(process.env.OPEN_CHARGE_MAP_API_KEY),
  });
}
