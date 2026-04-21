import { json } from './_lib.js';

const TRACKING_TAG = process.env.AMAZON_ASSOCIATE_TAG || 'webvolu-21';
const AMAZON_PRODUCTS_MODE = String(process.env.AMAZON_PRODUCTS_MODE || 'static').toLowerCase();

const CREATOR_TOKEN_CACHE = globalThis.__amazon_creators_token_cache ?? {
    accessToken: null,
    expiresAt: 0,
    cacheKey: null
};

globalThis.__amazon_creators_token_cache = CREATOR_TOKEN_CACHE;

const CREATOR_DEFAULTS = {
    eu: {
        marketplace: 'www.amazon.it',
        apiBaseUrl: 'https://creatorsapi.amazon/catalog/v1',
        tokenUrl: 'https://api.amazon.co.uk/auth/o2/token',
        credentialVersion: '3.2',
        tokenScope: 'creatorsapi::default'
    },
    na: {
        marketplace: 'www.amazon.com',
        apiBaseUrl: 'https://creatorsapi.amazon/catalog/v1',
        tokenUrl: 'https://api.amazon.com/auth/o2/token',
        credentialVersion: '3.1',
        tokenScope: 'creatorsapi::default'
    },
    fe: {
        marketplace: 'www.amazon.co.jp',
        apiBaseUrl: 'https://creatorsapi.amazon/catalog/v1',
        tokenUrl: 'https://api.amazon.co.jp/auth/o2/token',
        credentialVersion: '3.3',
        tokenScope: 'creatorsapi::default'
    }
};

const GROUPS = {
    emergenza: {
        title: 'Kit emergenza auto',
        products: [
            {
                asin: 'B01KJTA3GW',
                label: 'Pressione gomme',
                title: 'Einhell CC-AC 12V Compressore per auto',
                description:
                    'Una soluzione semplice per chi vuole gestire i piccoli cali di pressione senza dover cercare subito un distributore o rimandare il problema.',
            },
            {
                asin: 'B0D6QRF1X3',
                label: 'Batteria',
                title: 'GOOLOO 3000A Avviatore con compressore',
                description:
                    'Una scelta più completa per chi preferisce avere un solo prodotto capace di aiutare sia in caso di batteria scarica sia nella gestione della pressione.',
            },
            {
                asin: 'B09G6M8JLK',
                label: 'Visibilità',
                title: 'Blukar Lampada Frontale LED ricaricabile',
                description:
                    'È utile quando devi avere le mani libere e vuoi controllare meglio una ruota, il baule o qualsiasi dettaglio dell’auto in condizioni di scarsa luce.',
            }
        ]
    },
    viaggi: {
        title: 'Accessori per viaggi lunghi',
        products: [
            {
                asin: 'B0CB3DRLCT',
                label: 'Navigazione',
                title: 'Miracase Supporto per Telefono Auto',
                description:
                    'Una scelta pratica per chi usa spesso le mappe e vuole avere lo schermo in una posizione più comoda, leggibile e stabile.',
            },
            {
                asin: 'B0BSVB93DK',
                label: 'Ricarica',
                title: 'Anker Caricatore Auto 67W a 3 porte',
                description:
                    'È indicato se in auto usi più dispositivi o vuoi una ricarica più solida durante navigazione, chiamate e giornate fuori casa.',
            },
            {
                asin: 'B07TZ42858',
                label: 'Soste',
                title: 'Navaris Telo Copriauto universale',
                description:
                    'Può avere senso se lasci spesso l’auto parcheggiata all’aperto durante weekend, vacanze o soste più lunghe del solito.',
            }
        ]
    },
    bagagliaio: {
        title: 'Organizzazione bagagliaio',
        products: [
            {
                asin: 'B0CVPRFYQ5',
                label: 'Taglia media',
                title: 'FORTEM Organizer bagagliaio 50L',
                description:
                    'È una scelta equilibrata se vuoi mettere ordine senza occupare troppo volume, soprattutto per l’uso quotidiano.',
            },
            {
                asin: 'B07N142RPC',
                label: 'Taglia grande',
                title: 'FORTEM Organizer bagagliaio 65L',
                description:
                    'Può essere più adatto se il bagagliaio lavora spesso tra spesa, viaggi, attrezzatura o oggetti più ingombranti.',
            },
            {
                asin: 'B09XXQC2K3',
                label: 'Luce bagagliaio',
                title: 'Blukar Lanterna ricaricabile',
                description:
                    'È comoda quando devi cercare qualcosa nel baule con poca luce o vuoi sistemare meglio gli oggetti durante una sosta serale.',
            }
        ]
    }
};

function amazonDetailUrl(asin) {
    return `https://www.amazon.it/dp/${encodeURIComponent(asin)}?tag=${encodeURIComponent(TRACKING_TAG)}`;
}

function readEnv(...keys) {
    for (const key of keys) {
        const value = process.env[key];
        if (value !== undefined && value !== null && String(value).trim() !== '') {
            return String(value).trim();
        }
    }
    return '';
}

function getCreatorConfig() {
    const region = readEnv('AMAZON_CREATOR_REGION') || 'eu';
    const defaults = CREATOR_DEFAULTS[region] || CREATOR_DEFAULTS.eu;

    const config = {
        region,

        // compatibilità con i nomi che hai già su Vercel
        applicationId: readEnv('AMAZON_CREATORS_APPLICATION_ID'),
        publicKey: readEnv('AMAZON_CREATORS_PUBLIC_KEY'),
        privateKey: readEnv('AMAZON_CREATORS_PRIVATE_KEY'),

        // compatibilità sia con i miei nomi sia con i tuoi
        clientId: readEnv('AMAZON_CREATOR_CLIENT_ID', 'AMAZON_CREATORS_PUBLIC_KEY'),
        clientSecret: readEnv('AMAZON_CREATOR_CLIENT_SECRET', 'AMAZON_CREATORS_PRIVATE_KEY'),

        credentialVersion: readEnv('AMAZON_CREATOR_CREDENTIAL_VERSION') || defaults.credentialVersion,
        marketplace: readEnv('AMAZON_CREATOR_MARKETPLACE', 'AMAZON_MARKETPLACE') || defaults.marketplace,
        apiBaseUrl: (readEnv('AMAZON_CREATOR_API_BASE_URL') || defaults.apiBaseUrl).replace(/\/$/, ''),
        tokenUrl: readEnv('AMAZON_CREATOR_TOKEN_URL') || defaults.tokenUrl,
        tokenScope: readEnv('AMAZON_CREATOR_SCOPE') || defaults.tokenScope,
        timeoutMs: Number.parseInt(readEnv('AMAZON_CREATOR_TIMEOUT_MS') || '9000', 10),
    };

    if (!config.clientId || !config.clientSecret) {
        throw new Error(
            'Mancano credenziali Amazon: usa AMAZON_CREATORS_PUBLIC_KEY e AMAZON_CREATORS_PRIVATE_KEY oppure AMAZON_CREATOR_CLIENT_ID e AMAZON_CREATOR_CLIENT_SECRET'
        );
    }

    if (!TRACKING_TAG) {
        throw new Error('Manca AMAZON_ASSOCIATE_TAG');
    }

    return config;
}

function isV2Credential(version) {
    return String(version || '').startsWith('2.');
}

async function fetchWithTimeout(url, init, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(url, {
            ...init,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeoutId);
    }
}

async function getCreatorsAccessToken(config) {
    const safetyWindowMs = 60 * 1000;
    const cacheKey = [config.clientId, config.credentialVersion, config.marketplace, config.tokenUrl].join('|');

    if (
        CREATOR_TOKEN_CACHE.accessToken &&
        CREATOR_TOKEN_CACHE.cacheKey === cacheKey &&
        CREATOR_TOKEN_CACHE.expiresAt > Date.now() + safetyWindowMs
    ) {
        return CREATOR_TOKEN_CACHE.accessToken;
    }

    const v2 = isV2Credential(config.credentialVersion);
    const headers = {
        Accept: 'application/json'
    };

    let body;
    if (v2) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
        body = new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: config.clientId,
            client_secret: config.clientSecret,
            scope: config.tokenScope || 'creatorsapi/default'
        }).toString();
    } else {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify({
            grant_type: 'client_credentials',
            client_id: config.clientId,
            client_secret: config.clientSecret,
            scope: config.tokenScope || 'creatorsapi::default'
        });
    }

    const response = await fetchWithTimeout(
        config.tokenUrl,
        {
            method: 'POST',
            headers,
            body,
        },
        Math.min(config.timeoutMs, 8000)
    );

    const raw = await response.text();
    let payload = null;

    try {
        payload = raw ? JSON.parse(raw) : null;
    } catch {
        payload = null;
    }

    if (!response.ok) {
        throw new Error(`Token Amazon non valido (${response.status})`);
    }

    const accessToken = payload?.access_token;
    const expiresInSec = Number(payload?.expires_in || 3600);

    if (!accessToken) {
        throw new Error('Amazon non ha restituito access_token');
    }

    CREATOR_TOKEN_CACHE.accessToken = accessToken;
    CREATOR_TOKEN_CACHE.expiresAt = Date.now() + Math.max(300, expiresInSec - 60) * 1000;
    CREATOR_TOKEN_CACHE.cacheKey = cacheKey;

    return accessToken;
}

function creatorsAuthorizationHeader(accessToken, credentialVersion) {
    if (isV2Credential(credentialVersion)) {
        return `Bearer ${accessToken}, Version ${credentialVersion}`;
    }
    return `Bearer ${accessToken}`;
}

function firstDefined(...values) {
    for (const value of values) {
        if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
}

function normalizeCreatorsItem(item, fallbackProduct) {
    const listing = item?.offersV2?.listings?.[0];
    const money = listing?.price?.money;
    const primaryImage =
        item?.images?.primary?.large ||
        item?.images?.primary?.medium ||
        item?.images?.primary?.small;

    const title = firstDefined(
        item?.itemInfo?.title?.displayValue,
        item?.title,
        fallbackProduct.title
    );

    const brand = firstDefined(
        item?.itemInfo?.byLineInfo?.brand?.displayValue,
        item?.itemInfo?.byLineInfo?.manufacturer?.displayValue,
        item?.itemInfo?.manufactureInfo?.manufacturer?.displayValue,
    );

    const availability = firstDefined(
        listing?.availability?.message,
        listing?.availability?.type,
    );

    return {
        ...fallbackProduct,
        title,
        imageUrl: firstDefined(primaryImage?.url, fallbackProduct.imageUrl),
        amazonUrl: firstDefined(item?.detailPageUrl, fallbackProduct.amazonUrl),
        priceAmount: Number.isFinite(Number(money?.amount)) ? Number(money.amount) : null,
        priceCurrency: firstDefined(money?.currency, null),
        priceDisplay: firstDefined(money?.displayAmount, null),
        availability: availability || null,
        brand: brand || null,
        merchant: firstDefined(listing?.merchantInfo?.name, null),
        creatorsAsin: firstDefined(item?.asin, fallbackProduct.asin),
    };
}

async function fetchCreatorsProducts(baseProducts) {
    const config = getCreatorConfig();
    const accessToken = await getCreatorsAccessToken(config);

    const payload = {
        itemIds: baseProducts.map((item) => item.asin),
        itemIdType: 'ASIN',
        marketplace: config.marketplace,
        partnerTag: TRACKING_TAG,
        resources: [
            'images.primary.small',
            'images.primary.medium',
            'images.primary.large',
            'itemInfo.title',
            'itemInfo.byLineInfo',
            'offersV2.listings.price',
            'offersV2.listings.availability',
            'offersV2.listings.merchantInfo'
        ]
    };

    const response = await fetchWithTimeout(
        `${config.apiBaseUrl}/getItems`,
        {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                Authorization: creatorsAuthorizationHeader(accessToken, config.credentialVersion),
                'x-marketplace': config.marketplace,
            },
            body: JSON.stringify(payload),
        },
        config.timeoutMs
    );

    const raw = await response.text();
    let data = null;

    try {
        data = raw ? JSON.parse(raw) : null;
    } catch {
        data = null;
    }

    if (!response.ok) {
        throw new Error(`GetItems Amazon non valido (${response.status})`);
    }

    const items = Array.isArray(data?.itemsResult?.items)
        ? data.itemsResult.items
        : Array.isArray(data?.ItemsResult?.Items)
            ? data.ItemsResult.Items
            : [];

    const normalizedByAsin = new Map(
        items
            .map((item) => {
                const asin = String(firstDefined(item?.asin, item?.ASIN, '') || '').trim();
                return [asin, item];
            })
            .filter(([asin]) => Boolean(asin))
    );

    const products = baseProducts.map((fallbackProduct) => {
        const liveItem = normalizedByAsin.get(fallbackProduct.asin);
        return liveItem ? normalizeCreatorsItem(liveItem, fallbackProduct) : fallbackProduct;
    });

    return {
        mode: 'creators-live',
        products,
        missingAsins: baseProducts
            .map((item) => item.asin)
            .filter((asin) => !normalizedByAsin.has(asin))
    };
}

async function tryCreatorsEnrichment(products) {
    if (AMAZON_PRODUCTS_MODE !== 'creators') {
        return { mode: 'static', products, warnings: [] };
    }

    try {
        const enriched = await fetchCreatorsProducts(products);
        const warnings = [];

        if (enriched.missingAsins.length) {
            warnings.push(`ASIN non arricchiti via Creators API: ${enriched.missingAsins.join(', ')}`);
        }

        return {
            mode: enriched.mode,
            products: enriched.products,
            warnings,
        };
    } catch (error) {
        return {
            mode: 'creators-fallback',
            products,
            warnings: [error?.message || 'Fallback statico Amazon attivato']
        };
    }
}

export default async function handler(req, res) {
    try {
        const groupKey = String(req.query.group || '').trim().toLowerCase();
        const group = GROUPS[groupKey];

        if (!group) {
            return json(res, 400, {
                ok: false,
                error: 'Gruppo prodotti non valido. Usa: emergenza, viaggi, bagagliaio.'
            });
        }

        const baseProducts = group.products.map((item) => ({
            ...item,
            imageUrl: '/assets/images/amazon-product-placeholder.svg',
            amazonUrl: amazonDetailUrl(item.asin),
            priceAmount: null,
            priceCurrency: null,
            priceDisplay: null,
            availability: null,
            brand: null,
            merchant: null,
        }));

        const enriched = await tryCreatorsEnrichment(baseProducts);

        return json(res, 200, {
            ok: true,
            group: groupKey,
            title: group.title,
            apiMode: enriched.mode,
            count: enriched.products.length,
            warnings: enriched.warnings,
            debug: {
                productsModeRaw: process.env.AMAZON_PRODUCTS_MODE || null,
                productsModeNormalized: String(process.env.AMAZON_PRODUCTS_MODE || 'static').toLowerCase(),
                hasAssociateTag: Boolean(process.env.AMAZON_ASSOCIATE_TAG),
                hasPublicKey: Boolean(process.env.AMAZON_CREATORS_PUBLIC_KEY || process.env.AMAZON_CREATOR_CLIENT_ID),
                hasPrivateKey: Boolean(process.env.AMAZON_CREATORS_PRIVATE_KEY || process.env.AMAZON_CREATOR_CLIENT_SECRET),
                marketplace:
                    process.env.AMAZON_MARKETPLACE ||
                    process.env.AMAZON_CREATOR_MARKETPLACE ||
                    null,
                region: process.env.AMAZON_CREATOR_REGION || null,
                credentialVersion: process.env.AMAZON_CREATOR_CREDENTIAL_VERSION || null
            },
            products: enriched.products
        });
    } catch (err) {
        return json(res, 502, { ok: false, error: err.message || 'Errore Amazon products' });
    }
}