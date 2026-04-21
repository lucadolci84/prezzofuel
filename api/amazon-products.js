import { json } from './_lib.js';

const TRACKING_TAG = process.env.AMAZON_ASSOCIATE_TAG || 'webvolu-21';

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

async function tryCreatorsEnrichment(products) {
    const mode = String(process.env.AMAZON_PRODUCTS_MODE || 'static').toLowerCase();
    if (mode !== 'creators') {
        return { mode: 'static', products };
    }

    // Qui va il collegamento reale alla Creators API.
    // La pagina pubblica di Amazon rimanda a "View API references" per i dettagli tecnici completi
    // e la coppia public/private key resta nel tuo account.
    // Appena hai il sample ufficiale GetItems dalla tua area riservata, sostituisci questo blocco
    // mantenendo invariata la shape finale dell'array `products`.
    return { mode: 'static-fallback', products };
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
            amazonUrl: amazonDetailUrl(item.asin)
        }));

        const enriched = await tryCreatorsEnrichment(baseProducts);

        return json(res, 200, {
            ok: true,
            group: groupKey,
            title: group.title,
            apiMode: enriched.mode,
            count: enriched.products.length,
            products: enriched.products
        });
    } catch (err) {
        return json(res, 502, { ok: false, error: err.message || 'Errore Amazon products' });
    }
}