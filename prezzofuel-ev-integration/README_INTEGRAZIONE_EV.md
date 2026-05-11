# Integrazione colonnine elettriche per PrezzoFuel

Questa integrazione aggiunge:

- endpoint Vercel `/api/ev-stations` per cercare colonnine in Italia per CAP/indirizzo o lat/lon;
- dati anagrafici da OpenChargeMap;
- prezzi quando disponibili da `UsageCost` OpenChargeMap e/o da feed tariffari configurati;
- widget frontend opzionale da includere in `public/index.html`.

## File da copiare

Copia nel repository:

```text
api/ev-stations.js
public/assets/js/ev-widget.js
public/ev-tariffs.example.json
```

## Modifica a `public/index.html`

Aggiungi prima di `</body>`:

```html
<script src="/assets/js/ev-widget.js" defer></script>
```

Il widget si inietta dopo il primo blocco `.panel` esistente, quindi non richiede di riscrivere la home.

## Variabili ambiente Vercel

Consigliata:

```bash
OCM_API_KEY=la_tua_chiave_openchargemap
```

Opzionale per prezzi strutturati:

```bash
EV_TARIFFS_URL=https://tuodominio.it/ev-tariffs.json
```

oppure:

```bash
EV_TARIFFS_JSON='{"tariffs":[...]}'
```

Lo schema del feed tariffario è mostrato in `public/ev-tariffs.example.json`. I valori presenti sono dimostrativi: sostituiscili con fonti reali oppure non esporre quel file.

## Endpoint

Esempi:

```bash
/api/ev-stations?q=20121&radius=10&connectors=type2,ccs&sort=price
/api/ev-stations?lat=45.4642&lon=9.1900&radius=15&connectors=ccs&sort=power
```

Risposta sintetica:

```json
{
  "ok": true,
  "count": 12,
  "sources": {
    "stations": ["OpenChargeMap"],
    "prices": ["OpenChargeMap UsageCost", "EV_TARIFFS_JSON"]
  },
  "results": [
    {
      "title": "Nome colonnina",
      "operator": "Operatore",
      "distanceKm": 1.2,
      "maxPowerKw": 150,
      "price": {
        "unit": "EUR/kWh",
        "min": 0.69,
        "max": 0.89,
        "display": "0.69-0.89 €/kWh",
        "confidence": "indicative"
      },
      "connections": []
    }
  ]
}
```

## Nota sui prezzi

I prezzi reali di ricarica dipendono da CPO/eMSP, app, roaming, abbonamento, potenza, tempo di occupazione e condizioni commerciali. Senza feed ufficiali o accordi OCPI, l'endpoint mostra solo prezzi testuali/indicativi quando disponibili.
