import { json } from './_lib.js';

const TRACKING_TAG = process.env.AMAZON_ASSOCIATE_TAG || 'webvolu-21';
const AMAZON_PRODUCTS_MODE = String(process.env.AMAZON_PRODUCTS_MODE || 'static').toLowerCase();

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
                brand: 'Einhell',
                imageUrl: 'https://m.media-amazon.com/images/I/71I9TnOigCL._AC_SX679_.jpg', // INCOLLA QUI l\'URL immagine ufficiale Amazon
            },
            {
                asin: 'B0D6QRF1X3',
                label: 'Batteria',
                title: 'GOOLOO 3000A Avviatore con compressore',
                description:
                    'Una scelta più completa per chi preferisce avere un solo prodotto capace di aiutare sia in caso di batteria scarica sia nella gestione della pressione.',
                brand: 'GOOLOO',
                imageUrl: 'https://m.media-amazon.com/images/I/71d48Oif4AL._AC_SX679_.jpg', // INCOLLA QUI l\'URL immagine ufficiale Amazon
            },
            {
                asin: 'B09G6M8JLK',
                label: 'Visibilità',
                title: 'Blukar Lampada Frontale LED ricaricabile',
                description:
                    'È utile quando devi avere le mani libere e vuoi controllare meglio una ruota, il baule o qualsiasi dettaglio dell’auto in condizioni di scarsa luce.',
                brand: 'Blukar',
                imageUrl: 'https://m.media-amazon.com/images/I/612qyoa6fyL._AC_SX522_.jpg', // INCOLLA QUI l\'URL immagine ufficiale Amazon
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
                brand: 'Miracase',
                imageUrl: 'https://m.media-amazon.com/images/I/71nJvJcnI7L._AC_SX679_.jpg', // INCOLLA QUI l\'URL immagine ufficiale Amazon
            },
            {
                asin: 'B0BSVB93DK',
                label: 'Ricarica',
                title: 'Anker Caricatore Auto 67W a 3 porte',
                description:
                    'È indicato se in auto usi più dispositivi o vuoi una ricarica più solida durante navigazione, chiamate e giornate fuori casa.',
                brand: 'Anker',
                imageUrl: 'https://m.media-amazon.com/images/I/61sqwsfcLwL._AC_SX522_.jpg', // INCOLLA QUI l\'URL immagine ufficiale Amazon
            },
            {
                asin: 'B07TZ42858',
                label: 'Soste',
                title: 'Navaris Telo Copriauto universale',
                description:
                    'Può avere senso se lasci spesso l’auto parcheggiata all’aperto durante weekend, vacanze o soste più lunghe del solito.',
                brand: 'Navaris',
                imageUrl: 'https://m.media-amazon.com/images/I/61xLwi1pHcL._AC_SL1200_.jpg', // INCOLLA QUI l\'URL immagine ufficiale Amazon
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
                brand: 'FORTEM',
                imageUrl: 'https://m.media-amazon.com/images/I/71p4VkC3ByL._AC_SL1500_.jpg', // INCOLLA QUI l\'URL immagine ufficiale Amazon
            },
            {
                asin: 'B07N142RPC',
                label: 'Taglia grande',
                title: 'FORTEM Organizer bagagliaio 65L',
                description:
                    'Può essere più adatto se il bagagliaio lavora spesso tra spesa, viaggi, attrezzatura o oggetti più ingombranti.',
                brand: 'FORTEM',
                imageUrl: 'https://m.media-amazon.com/images/I/81bvuLCGeZL._AC_SL1500_.jpg', // INCOLLA QUI l\'URL immagine ufficiale Amazon
            },
            {
                asin: 'B09XXQC2K3',
                label: 'Luce bagagliaio',
                title: 'Blukar Lanterna ricaricabile',
                description:
                    'È comoda quando devi cercare qualcosa nel baule con poca luce o vuoi sistemare meglio gli oggetti durante una sosta serale.',
                brand: 'Blukar',
                imageUrl: 'https://m.media-amazon.com/images/I/71fT8jJ-1+L._AC_SL1500_.jpg', // INCOLLA QUI l\'URL immagine ufficiale Amazon
            }
        ]
    }
};

function amazonDetailUrl(asin) {
    return `https://www.amazon.it/dp/${encodeURIComponent(asin)}?tag=${encodeURIComponent(TRACKING_TAG)}`;
}

function normalizeManualProduct(item) {
    return {
        ...item,
        imageUrl: item.imageUrl || '/assets/images/amazon-product-placeholder.svg',
        amazonUrl: item.amazonUrl || amazonDetailUrl(item.asin),
        priceAmount: null,
        priceCurrency: null,
        priceDisplay: null,
        availability: null,
        merchant: null,
    };
}

async function tryCreatorsEnrichment(products) {
    if (AMAZON_PRODUCTS_MODE !== 'creators') {
        return {
            mode: 'manual-catalog',
            products,
            warnings: []
        };
    }

    // Piano B attivo:
    // finché l'account Amazon non è idoneo, usiamo il catalogo manuale
    // con immagini ufficiali e link affiliati normali.
    return {
        mode: 'manual-catalog-fallback',
        products,
        warnings: [
            'Catalogo manuale attivo: immagini/link affiliati Amazon disponibili, prezzi live non disponibili.'
        ]
    };
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

        const baseProducts = group.products.map((item) => normalizeManualProduct(item));
        const enriched = await tryCreatorsEnrichment(baseProducts);

        return json(res, 200, {
            ok: true,
            group: groupKey,
            title: group.title,
            apiMode: enriched.mode,
            count: enriched.products.length,
            warnings: enriched.warnings,
            products: enriched.products
        });
    } catch (err) {
        return json(res, 502, {
            ok: false,
            error: err.message || 'Errore Amazon products'
        });
    }
}