(function () {
  function onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  onReady(function () {
    const panel = document.querySelector('.panel');
    const fuelRow = document.querySelector('.fuel-row');
    const capEl = document.getElementById('cap');
    const radiusEl = document.getElementById('raggio');
    const searchBtn = document.getElementById('searchBtn');
    const geoBtn = document.getElementById('geoBtn');
    const statusEl = document.getElementById('status');
    const noticeEl = document.getElementById('notice');
    const resultsEl = document.getElementById('results');
    const sortBar = document.getElementById('sortBar');
    const sortSelect = document.getElementById('sortSelect');
    const countBadge = document.getElementById('countBadge');
    let mapWrap = document.getElementById('mapWrap');
    const fuelExtraRow = document.getElementById('fuelExtraRow');

    if (!panel || !fuelRow || !capEl || !radiusEl || !searchBtn || !geoBtn || !statusEl || !noticeEl || !resultsEl) return;
    if (document.getElementById('evUnifiedToggle')) return;

    const originalSearchHtml = searchBtn.innerHTML;
    const evSearchHtml = '\u26a1 Trova colonnine';
    const originalSortOptions = sortSelect ? sortSelect.innerHTML : '';
    const fuelActiveClasses = ['active-green', 'active-blue', 'active-amber', 'active-cyan'];
    let evMode = false;
    let evBusy = false;
    let lastEvParams = null;
    let evMap = null;
    let evMarkerLayer = null;
    let evMapTarget = null;
    let leafletPromise = null;
    const originalResultsMap = document.getElementById('resultsMap');
    const originalMapWrapDisplay = mapWrap ? mapWrap.style.display : '';
    const EV_PREF_KEY = 'prezzofuel.ev.preferences.v3';

    function readEvPreferences() {
      try {
        return JSON.parse(localStorage.getItem(EV_PREF_KEY) || '{}');
      } catch {
        return {};
      }
    }

    function writeEvPreferences(patch) {
      try {
        const current = readEvPreferences();
        const next = Object.assign({}, current, patch || {}, {
          connectors: activeConnectors(),
          powerBands: activePowerBands(),
          operationalOnly: operationalOnlyEnabled(),
          kwh: selectedKwhEstimate(),
          sort: selectedSort(),
          radius: radiusEl.value,
          lastQuery: capEl.value.trim()
        });
        localStorage.setItem(EV_PREF_KEY, JSON.stringify(next));
      } catch {
        // Preferenze non disponibili: non bloccare la ricerca.
      }
    }

    function setChipState(selector, values) {
      const selected = new Set(Array.isArray(values) ? values : []);
      if (!selected.size) return;
      connectorRow.querySelectorAll(selector).forEach(function (chip) {
        const value = chip.getAttribute('data-connector') || chip.getAttribute('data-power');
        chip.classList.toggle('is-active', selected.has(value));
      });
    }

    function restoreEvPreferences() {
      const prefs = readEvPreferences();
      setChipState('.ev-connector-chip', prefs.connectors);
      setChipState('.ev-power-chip', prefs.powerBands);
      const operational = document.getElementById('evOperationalOnly');
      if (operational && typeof prefs.operationalOnly === 'boolean') operational.checked = prefs.operationalOnly;
      const kwh = document.getElementById('evKwhEstimate');
      if (kwh && prefs.kwh) kwh.value = prefs.kwh;
      if (prefs.radius && radiusEl) radiusEl.value = prefs.radius;
      const hasUrlQuery = new URLSearchParams(window.location.search).has('cap') || new URLSearchParams(window.location.search).has('q');
      if (!hasUrlQuery && prefs.lastQuery && !capEl.value) capEl.value = prefs.lastQuery;
    }

    function restoreEvSortPreference() {
      const prefs = readEvPreferences();
      if (!sortSelect || !prefs.sort) return;
      if (Array.from(sortSelect.options).some(function (option) { return option.value === prefs.sort; })) {
        sortSelect.value = prefs.sort;
      }
    }

    function friendlyEvError(message) {
      const raw = String(message || '').trim();
      const lower = raw.toLowerCase();
      if (!raw) return 'Errore durante la ricerca delle colonnine.';
      if (lower.includes('api key') || lower.includes('ocm_api_key') || lower.includes('chiave openchargemap')) {
        return 'Chiave OpenChargeMap mancante o non valida. Controlla .env.local e riavvia npm run dev.';
      }
      if (lower.includes('failed to fetch') || lower.includes('network') || lower.includes('errore di rete')) {
        return 'Non riesco a contattare il servizio dati delle colonnine. Controlla la connessione e riprova.';
      }
      if (lower.includes('non json') || lower.includes('risposta non valida')) {
        return 'Il servizio colonnine ha risposto in modo non valido. Riprova tra qualche minuto.';
      }
      if (lower.includes('429') || lower.includes('rate')) {
        return 'OpenChargeMap ha limitato temporaneamente le richieste. Attendi qualche minuto e riprova.';
      }
      return raw;
    }

    async function readJsonResponse(response) {
      const text = await response.text();
      try {
        return text ? JSON.parse(text) : {};
      } catch {
        throw new Error('Risposta non valida dal server locale');
      }
    }

    injectStyles();
    addElectricToggle();
    addConnectorFilters();

    const evToggle = document.getElementById('evUnifiedToggle');
    const connectorRow = document.getElementById('evConnectorFilters');
    restoreEvPreferences();

    evToggle.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setEvMode(!evMode);
    }, true);

    fuelRow.addEventListener('click', function (event) {
      const normalFuel = event.target.closest('.fuel-toggle[data-fuel]:not([data-fuel="elettrico"])');
      if (!normalFuel || !evMode) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      switchFromEvToFuel(normalFuel);
    }, true);

    connectorRow.addEventListener('click', function (event) {
      const chip = event.target.closest('.ev-connector-chip, .ev-power-chip');
      if (!chip) return;
      chip.classList.toggle('is-active');
      writeEvPreferences();
    });

    connectorRow.addEventListener('change', function (event) {
      if (event.target && event.target.matches('#evOperationalOnly, #evKwhEstimate')) {
        writeEvPreferences();
      }
    });

    searchBtn.addEventListener('click', function (event) {
      if (!evMode) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      runEvSearch({ q: capEl.value, radius: radiusEl.value });
    }, true);

    geoBtn.addEventListener('click', function (event) {
      if (!evMode) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      runEvGeoSearch();
    }, true);

    capEl.addEventListener('keydown', function (event) {
      if (!evMode || event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      runEvSearch({ q: capEl.value, radius: radiusEl.value });
    }, true);

    if (sortSelect) {
      sortSelect.addEventListener('change', function (event) {
        if (!evMode) return;
        event.preventDefault();
        event.stopPropagation();
        writeEvPreferences();
        if (lastEvParams) runEvSearch(lastEvParams);
      }, true);
    }

    function addElectricToggle() {
      fuelRow.insertAdjacentHTML('beforeend', '\n        <div class="fuel-toggle ev-unified-toggle" id="evUnifiedToggle" data-fuel="elettrico" title="Cerca colonnine di ricarica elettrica">\n          <span class="dot"></span>Elettrico\n        </div>\n      ');
    }

    function addConnectorFilters() {
      fuelRow.insertAdjacentHTML('afterend', '\n        <div class="ev-connectors-panel" id="evConnectorFilters" hidden>\n          <div class="ev-filter-grid">\n            <div>\n              <div class="ev-filter-title">Tipo di connettore</div>\n              <div class="ev-filter-help">Puoi lasciare selezionati Type 2 e CCS se non sai quale scegliere.</div>\n              <div class="ev-connector-row">\n                <button type="button" class="ev-connector-chip is-active" data-connector="type2">\n                  <span>AC / Type 2</span><small>ricarica normale</small>\n                </button>\n                <button type="button" class="ev-connector-chip is-active" data-connector="ccs">\n                  <span>DC rapida / CCS</span><small>auto moderne</small>\n                </button>\n                <button type="button" class="ev-connector-chip" data-connector="chademo">\n                  <span>CHAdeMO</span><small>alcuni modelli datati</small>\n                </button>\n              </div>\n            </div>\n            <div>\n              <div class="ev-filter-title">Potenza</div>\n              <div class="ev-filter-help">Se non selezioni nulla, vengono mostrate tutte le potenze.</div>\n              <div class="ev-connector-row">\n                <button type="button" class="ev-power-chip" data-power="ac">\n                  <span>AC</span><small>fino a 49 kW</small>\n                </button>\n                <button type="button" class="ev-power-chip" data-power="dc">\n                  <span>DC</span><small>50-149 kW</small>\n                </button>\n                <button type="button" class="ev-power-chip" data-power="hpc">\n                  <span>HPC</span><small>150+ kW</small>\n                </button>\n                <button type="button" class="ev-power-chip" data-power="ultra300">\n                  <span>300+</span><small>viaggi lunghi</small>\n                </button>\n              </div>\n            </div>\n          </div>\n          <div class="ev-extra-row">\n            <label class="ev-check"><input type="checkbox" id="evOperationalOnly" checked> Solo colonnine indicate come operative</label>\n            <label class="ev-kwh-label">Stima costo per <input id="evKwhEstimate" class="ev-kwh-input" type="number" min="5" max="120" step="5" value="30"> kWh</label>\n          </div>\n        </div>\n      ');
    }

    function fuelButtons() {
      return Array.from(fuelRow.querySelectorAll('.fuel-toggle[data-fuel]:not([data-fuel="elettrico"])'));
    }

    function hideFuelActiveState() {
      fuelButtons().forEach(function (button) {
        if (!button.hasAttribute('data-ev-prev-class')) {
          button.setAttribute('data-ev-prev-class', button.className);
        }
        fuelActiveClasses.forEach(function (className) {
          button.classList.remove(className);
        });
      });
    }

    function restoreFuelActiveState() {
      fuelButtons().forEach(function (button) {
        const previousClass = button.getAttribute('data-ev-prev-class');
        if (previousClass) {
          button.className = previousClass;
          button.removeAttribute('data-ev-prev-class');
        }
      });
    }

    function isFuelClassActive(className) {
      return /\bactive-(green|blue|amber|cyan)\b/.test(className || '');
    }

    function activeClassForFuel(fuel) {
      const map = {
        benzina: 'active-green',
        diesel: 'active-blue',
        gpl: 'active-amber',
        metano: 'active-amber',
        hvo: 'active-blue'
      };
      return map[fuel] || 'active-green';
    }

    function switchFromEvToFuel(selectedButton) {
      const buttons = fuelButtons();
      const selectedFuel = selectedButton.getAttribute('data-fuel');
      const wasActive = {};

      buttons.forEach(function (button) {
        const fuel = button.getAttribute('data-fuel');
        const previousClass = button.getAttribute('data-ev-prev-class') || button.className;
        wasActive[fuel] = isFuelClassActive(previousClass);
      });

      setEvMode(false);

      buttons.forEach(function (button) {
        const fuel = button.getAttribute('data-fuel');
        const shouldBeActive = fuel === selectedFuel;
        if (Boolean(wasActive[fuel]) !== shouldBeActive) button.click();
      });

      buttons.forEach(function (button) {
        const fuel = button.getAttribute('data-fuel');
        button.className = fuel === selectedFuel
          ? 'fuel-toggle ' + activeClassForFuel(fuel)
          : 'fuel-toggle';
      });
    }

    function setEvMode(enabled) {
      const nextEvMode = Boolean(enabled);
      if (nextEvMode && !evMode) {
        hideFuelActiveState();
      } else if (!nextEvMode && evMode) {
        restoreFuelActiveState();
      }

      evMode = nextEvMode;
      evToggle.classList.toggle('active-cyan', evMode);
      connectorRow.hidden = !evMode;
      if (fuelExtraRow) fuelExtraRow.hidden = evMode;
      if (!evBusy) searchBtn.innerHTML = evMode ? evSearchHtml : originalSearchHtml;
      capEl.placeholder = evMode ? 'Es. 20121 oppure Via Roma 10, Milano' : 'Es. 20121 oppure Via Roma 10, Milano';

      if (sortSelect) {
        if (evMode) {
          sortSelect.innerHTML = '\n            <option value="recommended">Consigliate</option>\n            <option value="price">Prezzo migliore</option>\n            <option value="distance">Distanza</option>\n            <option value="power">Potenza massima</option>\n            <option value="freshness">Dati più recenti</option>\n          ';
          restoreEvSortPreference();
        } else {
          sortSelect.innerHTML = originalSortOptions;
          lastEvParams = null;
          clearStatus();
          clearNotice();
          restoreOriginalMap();
        }
      }
    }

    function activeConnectors() {
      return Array.from(connectorRow.querySelectorAll('.ev-connector-chip.is-active'))
        .map(function (el) { return el.getAttribute('data-connector'); })
        .filter(Boolean);
    }

    function activePowerBands() {
      return Array.from(connectorRow.querySelectorAll('.ev-power-chip.is-active'))
        .map(function (el) { return el.getAttribute('data-power'); })
        .filter(Boolean);
    }

    function operationalOnlyEnabled() {
      const input = document.getElementById('evOperationalOnly');
      return !input || input.checked;
    }

    function selectedKwhEstimate() {
      const input = document.getElementById('evKwhEstimate');
      const value = Number(input && input.value);
      if (!Number.isFinite(value) || value <= 0) return 30;
      return Math.max(5, Math.min(120, value));
    }

    function clearStatus() {
      statusEl.classList.remove('show');
      const line = statusEl.querySelector('.status-line');
      if (line) line.innerHTML = '';
    }

    function setStatus(message) {
      const line = statusEl.querySelector('.status-line');
      statusEl.classList.toggle('show', Boolean(message));
      if (line) line.innerHTML = message || '';
    }

    function clearNotice() {
      noticeEl.className = 'notice';
      noticeEl.textContent = '';
    }

    function setNotice(message, type) {
      noticeEl.className = ['notice', message ? 'show' : '', type || ''].filter(Boolean).join(' ');
      noticeEl.textContent = message || '';
    }

    function escapeHtml(value) {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function formatPower(value) {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? n.toFixed(0) + ' kW' : 'n.d.';
    }

    function formatEvDateTime(value) {
      if (!value) return '';
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) return '';
      return date.toLocaleString('it-IT', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    }

    function renderEvUpdateText(value) {
      const formatted = formatEvDateTime(value);
      return formatted ? 'Aggiornamento dati: ' + formatted : 'Aggiornamento dati: n.d.';
    }

    function selectedSort() {
      return sortSelect ? sortSelect.value : 'recommended';
    }

    function setEvBusy(busy, label) {
      evBusy = Boolean(busy);
      searchBtn.disabled = evBusy;
      geoBtn.disabled = evBusy;

      if (evBusy) {
        searchBtn.innerHTML = '<span class="spinner"></span> ' + escapeHtml(label || 'Cerco colonnine...');
      } else {
        searchBtn.innerHTML = evMode ? evSearchHtml : originalSearchHtml;
      }
    }

    async function runEvSearch(params) {
      const connectors = activeConnectors();
      if (!connectors.length) {
        setNotice('Seleziona almeno un tipo di connettore, oppure lascia attivi AC/Type 2 e CCS.', 'warn');
        setEvBusy(false);
        return;
      }

      const radius = String(params.radius || radiusEl.value || 10);
      const powerBands = activePowerBands();
      const query = new URLSearchParams({
        radius: radius,
        connectors: connectors.join(','),
        sort: selectedSort(),
        operational: operationalOnlyEnabled() ? '1' : '0',
        kwh: String(selectedKwhEstimate())
      });
      if (powerBands.length) query.set('power', powerBands.join(','));

      if (params.lat && params.lon) {
        query.set('lat', String(params.lat));
        query.set('lon', String(params.lon));
      } else {
        const q = String(params.q || capEl.value || '').trim();
        if (!q) {
          setNotice('Inserisci un CAP, un indirizzo o usa la tua posizione.', 'warn');
          setEvBusy(false);
          return;
        }
        query.set('q', q);
      }

      lastEvParams = Object.assign({}, params, { radius: radius });
      writeEvPreferences();
      resultsEl.innerHTML = '';
      clearNotice();
      setEvBusy(true, 'Cerco colonnine...');
      setStatus('<span class="spinner"></span> Ricerca colonnine in corso...');
      if (sortBar) sortBar.style.display = 'none';
      if (mapWrap) mapWrap.style.display = 'none';

      try {
        const response = await fetch('/api/ev-stations?' + query.toString(), {
          headers: { Accept: 'application/json' }
        });
        const data = await readJsonResponse(response);
        if (!response.ok || !data.ok) throw new Error(data.error || 'Errore durante la ricerca delle colonnine');
        clearStatus();
        if (data.autoExpanded) {
          setNotice('Non ho trovato risultati nel raggio iniziale: ricerca estesa automaticamente a ' + data.radiusKm + ' km.', 'warn');
        }
        renderEvResults(data);
        renderEvMap(data);
      } catch (err) {
        clearStatus();
        setNotice(friendlyEvError(err.message), 'error');
        resultsEl.innerHTML = '';
        hideEvMap();
      } finally {
        setEvBusy(false);
      }
    }

    function runEvGeoSearch() {
      if (!navigator.geolocation) {
        setNotice('Geolocalizzazione non supportata dal browser.', 'warn');
        return;
      }
      clearNotice();
      setEvBusy(true, 'Rilevo posizione...');
      setStatus('<span class="spinner"></span> Rilevamento posizione...');
      navigator.geolocation.getCurrentPosition(
        function (position) {
          runEvSearch({
            lat: position.coords.latitude,
            lon: position.coords.longitude,
            radius: radiusEl.value
          });
        },
        function () {
          clearStatus();
          setNotice('Non riesco ad accedere alla posizione. Inserisci un CAP o indirizzo.', 'warn');
          setEvBusy(false);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
      );
    }

    function removeEvMapInstance() {
      if (evMarkerLayer) {
        try { evMarkerLayer.clearLayers(); } catch (err) {}
        evMarkerLayer = null;
      }
      if (evMap) {
        try { evMap.remove(); } catch (err) {}
        evMap = null;
      }
      if (evMapTarget) {
        evMapTarget.remove();
        evMapTarget = null;
      }
    }

    function restoreOriginalMap() {
      if (!mapWrap) return;
      removeEvMapInstance();
      if (originalResultsMap) originalResultsMap.style.display = '';
      mapWrap.style.display = originalMapWrapDisplay || 'none';
    }

    function hideEvMap() {
      if (!mapWrap) return;
      mapWrap.style.display = 'none';
    }

    function ensureEvMapShell() {
      if (!mapWrap) {
        resultsEl.insertAdjacentHTML('beforebegin', '<div id="mapWrap" class="map-wrap"><div id="resultsMap" class="results-map"></div></div>');
        mapWrap = document.getElementById('mapWrap');
      }
      if (!mapWrap) return null;
      if (originalResultsMap) originalResultsMap.style.display = 'none';

      evMapTarget = document.getElementById('evResultsMap');
      if (!evMapTarget) {
        evMapTarget = document.createElement('div');
        evMapTarget.id = 'evResultsMap';
        evMapTarget.className = 'results-map';
        mapWrap.appendChild(evMapTarget);
      }

      evMapTarget.style.display = 'block';
      mapWrap.style.display = 'block';
      return evMapTarget;
    }

    function loadLeaflet() {
      if (window.L) return Promise.resolve(window.L);
      if (leafletPromise) return leafletPromise;

      leafletPromise = new Promise(function (resolve, reject) {
        if (!document.querySelector('link[href*="leaflet.css"]')) {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
          document.head.appendChild(link);
        }

        const existing = document.querySelector('script[src*="leaflet.js"]');
        if (existing) {
          existing.addEventListener('load', function () { resolve(window.L); });
          existing.addEventListener('error', reject);
          return;
        }

        const script = document.createElement('script');
        script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
        script.async = true;
        script.onload = function () { resolve(window.L); };
        script.onerror = function () { reject(new Error('Mappa non caricata')); };
        document.head.appendChild(script);
      });

      return leafletPromise;
    }

    function popupHtml(station) {
      const maps = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(String(station.lat) + ',' + String(station.lon));
      const price = station.price && station.price.display ? localizeEuroText(station.price.display) : 'Prezzo non disponibile';
      const title = station.title || 'Colonnina di ricarica';
      const meta = [station.address || '', Number(station.distanceKm || 0).toFixed(1) + ' km']
        .filter(Boolean)
        .map(escapeHtml)
        .join('<br>');
      const power = formatPower(station.maxPowerKw);
      const score = Number.isFinite(Number(station.recommendationScore)) ? ' · score ' + station.recommendationScore : '';
      return '\n        <div class="map-popup">\n          <div class="title">' + escapeHtml(title) + '</div>\n          <div class="meta">' + meta + '</div>\n          <div class="price">' + escapeHtml(price) + ' · ' + escapeHtml(power) + escapeHtml(score) + '</div>\n          <div class="meta"><a href="' + maps + '" target="_blank" rel="noopener">Apri navigatore</a></div>\n        </div>\n      ';
    }

    function numericEvPrice(station) {
      const price = station && station.price ? station.price : null;
      const n = Number(price && price.min);
      return Number.isFinite(n) ? n : null;
    }

    function buildEvMapColorIndex(items) {
      const prices = items
        .map(numericEvPrice)
        .filter(function (value) { return Number.isFinite(value); });
      return {
        min: prices.length ? Math.min.apply(null, prices) : null,
        max: prices.length ? Math.max.apply(null, prices) : null
      };
    }

    function markerClassForStation(station, colorIndex) {
      const price = numericEvPrice(station);
      if (Number(station.recommendationScore || 0) >= 75) return 'best';
      if (!Number.isFinite(price) || colorIndex.min == null || colorIndex.max == null) return 'normal';
      if (price === colorIndex.min) return 'best';
      if (price === colorIndex.max && colorIndex.max > colorIndex.min) return 'worst';
      return 'normal';
    }

    function createEvDivIcon(type) {
      return L.divIcon({
        className: '',
        html: '<div class="price-pin ' + type + '"></div>',
        iconSize: [18, 18],
        iconAnchor: [9, 9],
        popupAnchor: [0, -10]
      });
    }

    async function renderEvMap(data) {
      const items = Array.isArray(data.results) ? data.results.filter(function (station) {
        return Number.isFinite(Number(station.lat)) && Number.isFinite(Number(station.lon));
      }) : [];

      if (!items.length) {
        hideEvMap();
        return;
      }

      const target = ensureEvMapShell();
      if (!target) return;

      try {
        const L = await loadLeaflet();
        if (!L) return;

        if (!evMap) {
          evMap = L.map(target, { scrollWheelZoom: true });
          L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; OpenStreetMap'
          }).addTo(evMap);
          evMarkerLayer = L.layerGroup().addTo(evMap);
        } else {
          evMarkerLayer.clearLayers();
        }

        const bounds = [];
        const colorIndex = buildEvMapColorIndex(items);

        if (data.center && Number.isFinite(Number(data.center.lat)) && Number.isFinite(Number(data.center.lon))) {
          const centerLat = Number(data.center.lat);
          const centerLon = Number(data.center.lon);
          const centerMarker = L.circleMarker([centerLat, centerLon], {
            radius: 8,
            weight: 3,
            color: '#111827',
            fillColor: '#ffffff',
            fillOpacity: 1
          }).bindPopup('\n            <div class="map-popup">\n              <div class="title">Centro ricerca</div>\n            </div>\n          ');
          centerMarker.addTo(evMarkerLayer);
          bounds.push([centerLat, centerLon]);
        }

        items.forEach(function (station) {
          const lat = Number(station.lat);
          const lon = Number(station.lon);
          const markerType = markerClassForStation(station, colorIndex);
          const marker = L.marker([lat, lon], {
            icon: createEvDivIcon(markerType)
          }).bindPopup(popupHtml(station));
          marker.addTo(evMarkerLayer);
          bounds.push([lat, lon]);
        });

        if (!bounds.length) {
          hideEvMap();
          return;
        }

        if (bounds.length === 1) {
          evMap.setView(bounds[0], 14);
        } else {
          evMap.fitBounds(bounds, { padding: [30, 30] });
        }

        setTimeout(function () { evMap.invalidateSize(); }, 0);
      } catch (err) {
        hideEvMap();
      }
    }

    function formatEvDateShort(value) {
      if (!value) return '';
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) return '';
      return date.toLocaleDateString('it-IT', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
      });
    }

    function formatDistanceKm(value) {
      const n = Number(value);
      return Number.isFinite(n) ? n.toFixed(n < 10 ? 1 : 0) : 'n.d.';
    }

    function localizeEuroText(value) {
      return String(value || '')
        .replace(/\bEUR\b/g, '€')
        .replace(/(\d+)\.(\d{2})(?=[^\d]|$)/g, '$1,$2');
    }

    function uniqueList(values) {
      const seen = new Set();
      return values
        .map(function (value) { return String(value || '').trim(); })
        .filter(function (value) {
          if (!value) return false;
          const key = value.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    }

    function priceMeta(price) {
      const p = price || {};
      if (p.confidence === 'indicative') {
        return {
          badge: 'Tariffa indicativa',
          label: 'Tariffa operatore',
          detail: 'prezzo confrontabile',
          tone: 'good'
        };
      }
      if (p.confidence === 'estimated') {
        return {
          badge: 'Stima media',
          label: 'Media di mercato',
          detail: 'non è prezzo live',
          tone: 'estimate'
        };
      }
      if (p.confidence === 'low') {
        return {
          badge: 'Community',
          label: 'Dato community',
          detail: 'da verificare',
          tone: 'community'
        };
      }
      if (p.confidence === 'text-only') {
        return {
          badge: 'Nota costo',
          label: 'Nota non strutturata',
          detail: 'non confrontabile',
          tone: 'community'
        };
      }
      return {
        badge: 'Prezzo n.d.',
        label: 'Prezzo non disponibile',
        detail: 'verifica in app',
        tone: 'missing'
      };
    }

    function statusMeta(station) {
      if (station.isOperational === true) return { label: 'Operativa', tone: 'good' };
      if (station.isOperational === false) return { label: 'Non operativa', tone: 'bad' };
      return { label: 'Stato da verificare', tone: 'unknown' };
    }

    function renderEvBadge(label, tone, title) {
      return '<span class="ev-badge ev-badge-' + escapeHtml(tone || 'neutral') + '"' + (title ? ' title="' + escapeHtml(title) + '"' : '') + '>' + escapeHtml(label) + '</span>';
    }

    function renderEvBadges(station, index) {
      const badges = [];
      const score = Number(station.recommendationScore);
      const reasons = Array.isArray(station.recommendationReasons) ? station.recommendationReasons : [];
      if (index === 0 && Number.isFinite(score)) {
        const title = reasons.length ? 'Perché: ' + reasons.join(', ') : 'Punteggio basato su prezzo, distanza, potenza, aggiornamento e stato';
        badges.push(renderEvBadge('Consigliata', 'recommended', title));
      }

      const status = statusMeta(station);
      badges.push(renderEvBadge(status.label, status.tone));

      const quality = station.dataQuality || {};
      const qualityTone = quality.level === 'recent' ? 'good' : quality.level === 'verify' ? 'warn' : 'bad';
      badges.push(renderEvBadge(quality.label || 'Dato da verificare', qualityTone, quality.detail || ''));

      const price = priceMeta(station.price);
      if (price.tone === 'missing' || price.tone === 'estimate' || price.tone === 'community') {
        badges.push(renderEvBadge(price.badge, price.tone));
      }

      return '<div class="ev-badges">' + badges.join('') + '</div>';
    }

    function renderEvMetric(label, value, sub, tone) {
      return '\n        <div class="ev-metric ev-metric-' + escapeHtml(tone || 'neutral') + '">\n          <div class="ev-metric-label">' + escapeHtml(label) + '</div>\n          <div class="ev-metric-value">' + escapeHtml(value || 'n.d.') + '</div>\n          ' + (sub ? '<div class="ev-metric-sub">' + escapeHtml(sub) + '</div>' : '') + '\n        </div>\n      ';
    }

    function renderEvSummaryMetrics(station) {
      const price = station.price || {};
      const meta = priceMeta(price);
      const priceUpdated = formatEvDateShort(price.updatedAt);
      const priceSub = [meta.label, priceUpdated ? 'agg. ' + priceUpdated : ''].filter(Boolean).join(' · ');
      const estimate = price.estimate || null;
      const updateDate = formatEvDateShort(station.updatedAt);
      const updateSub = station.updatedAtField ? 'fonte OCM: ' + station.updatedAtField.replace(/^Date/, '') : 'fonte OpenChargeMap';

      return '<div class="ev-summary-grid">'
        + renderEvMetric('Prezzo energia', localizeEuroText(price.display || 'Non disponibile'), priceSub || meta.detail, meta.tone)
        + renderEvMetric('Stima ricarica', estimate && estimate.display ? localizeEuroText(estimate.display) : 'Non calcolabile', estimate ? estimate.note : 'serve un prezzo €/kWh', 'estimate')
        + renderEvMetric('Potenza max', formatPower(station.maxPowerKw), powerBandLabel(station.maxPowerKw), 'power')
        + renderEvMetric('Dati aggiornati', updateDate || 'n.d.', updateDate ? updateSub : 'aggiornamento non disponibile', station.dataQuality && station.dataQuality.level === 'recent' ? 'good' : 'warn')
        + '</div>';
    }

    function powerBandLabel(value) {
      const power = Number(value);
      if (!Number.isFinite(power) || power <= 0) return 'potenza non dichiarata';
      if (power >= 300) return 'ultra rapida 300+ kW';
      if (power >= 150) return 'HPC ultrarapida';
      if (power >= 50) return 'DC rapida';
      return 'AC / ricarica normale';
    }

    function renderConnectorSummary(station) {
      const connections = Array.isArray(station.connections) ? station.connections : [];
      if (!connections.length) return '';
      const types = uniqueList(connections.map(function (connection) { return connection.type || 'Connettore'; }));
      const currentTypes = uniqueList(connections.map(function (connection) { return connection.currentType; }));
      const totalQuantity = connections.reduce(function (sum, connection) {
        const qty = Number(connection.quantity);
        return sum + (Number.isFinite(qty) && qty > 0 ? qty : 1);
      }, 0);
      const status = statusMeta(station).label.toLowerCase();
      const title = types.slice(0, 3).join(', ') + (types.length > 3 ? ' +' + (types.length - 3) : '');
      const sub = [
        totalQuantity + (totalQuantity === 1 ? ' punto' : ' punti'),
        formatPower(station.maxPowerKw) + ' max',
        currentTypes.slice(0, 2).join(' / '),
        status
      ].filter(Boolean).join(' · ');

      return '\n        <div class="ev-connector-summary">\n          <span class="ev-connector-label">Connettori</span>\n          <span class="ev-connector-title">' + escapeHtml(title || 'Connettori disponibili') + '</span>\n          <span class="ev-connector-sub">' + escapeHtml(sub) + '</span>\n        </div>\n      ';
    }

    function renderEvSourceLine(station) {
      const price = station.price || {};
      const parts = [];
      parts.push('Dati stazione: ' + (station.source || 'OpenChargeMap'));
      if (station.updatedAt) parts.push('agg. ' + formatEvDateTime(station.updatedAt));
      if (price.source) parts.push('prezzo: ' + price.source);
      return '<div class="ev-source-line">' + escapeHtml(parts.join(' · ')) + '</div>';
    }

    function renderEvResults(data) {
      const items = Array.isArray(data.results) ? data.results : [];
      if (sortBar) sortBar.style.display = items.length ? 'flex' : 'none';
      if (countBadge) {
        const latestUpdate = formatEvDateShort(data.updatedAt || (data.sources && data.sources.stationsUpdatedAt));
        const radiusText = data.autoExpanded ? ' · raggio esteso a ' + data.radiusKm + ' km' : ' · entro ' + data.radiusKm + ' km';
        countBadge.textContent = items.length
          ? items.length + ' colonnine' + radiusText + (latestUpdate ? ' · dati OCM: ' + latestUpdate : '')
          : '';
      }

      if (!items.length) {
        resultsEl.innerHTML = '<div class="empty">Nessuna colonnina trovata con i filtri selezionati. Prova ad aumentare il raggio, disattivare "solo operative" o rimuovere il filtro potenza.</div>';
        return;
      }

      const noteHtml = renderEvResultNote(data);
      resultsEl.innerHTML = noteHtml + items.map(function (station, index) {
        const maps = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(String(station.lat) + ',' + String(station.lon));
        const operator = station.operator ? '<span class="pill ev-operator-pill">' + escapeHtml(station.operator) + '</span>' : '';
        const title = station.title || 'Colonnina di ricarica';
        const detailsHtml = renderEvDetails(station);
        const sourceLine = renderEvSourceLine(station);
        const costNote = station.usageCostText ? '<div class="ev-cost-note"><strong>Nota costo OCM:</strong> ' + escapeHtml(station.usageCostText) + '</div>' : '';

        return '\n          <div class="card ev-card ' + (index === 0 ? 'best' : '') + '">\n            <div class="ev-card-head">\n              <div class="ev-card-titleblock">\n                <div class="name">' + escapeHtml(title) + ' ' + operator + '</div>\n                <div class="addr">' + escapeHtml(station.address || 'Indirizzo non disponibile') + '</div>\n                ' + renderEvBadges(station, index) + '\n              </div>\n              <div class="ev-card-actions">\n                <div class="dist">' + formatDistanceKm(station.distanceKm) + ' <span>km</span></div>\n                <a class="map" href="' + maps + '" target="_blank" rel="noopener">Mappa</a>\n              </div>\n            </div>\n            ' + renderEvSummaryMetrics(station) + '\n            ' + renderConnectorSummary(station) + '\n            ' + costNote + '\n            ' + sourceLine + '\n            ' + detailsHtml + '\n          </div>\n        ';
      }).join('');
    }

    function renderEvResultNote(data) {
      const parts = [];
      if (data.autoExpanded) {
        parts.push('Ricerca estesa automaticamente da ' + data.requestedRadiusKm + ' a ' + data.radiusKm + ' km.');
      }
      if (data.filters && data.filters.operationalOnly) {
        parts.push('Filtro attivo: solo colonnine indicate come operative. Lo stato non è necessariamente live.');
      }
      if (data.pricingNote) parts.push(data.pricingNote);
      if (!parts.length) return '';
      return '<div class="ev-result-note">' + escapeHtml(parts.join(' ')) + '</div>';
    }

    function renderOperationalLabel(station) {
      if (station.isOperational === true) return 'operativa';
      if (station.isOperational === false) return 'non operativa';
      return station.status || 'da verificare';
    }

    function renderRecommendation(station, index) {
      const score = Number(station.recommendationScore);
      const reasons = Array.isArray(station.recommendationReasons) ? station.recommendationReasons : [];
      if (!Number.isFinite(score)) return '';
      const label = index === 0 ? 'Consigliata' : 'Score';
      const reasonText = reasons.length ? ' · ' + reasons.join(', ') : '';
      return '<span class="ev-score-badge" title="Punteggio basato su prezzo, distanza, potenza, aggiornamento e stato">' + escapeHtml(label + ' ' + score + '/100' + reasonText) + '</span>';
    }

    function renderEvQuality(station) {
      const quality = station.dataQuality || {};
      const level = quality.level || 'incomplete';
      const label = quality.label || 'Dato da verificare';
      const detail = quality.detail ? ' · ' + quality.detail : '';
      return '<span class="ev-quality ev-quality-' + escapeHtml(level) + '" title="' + escapeHtml(label + detail) + '">' + escapeHtml(label) + '</span>';
    }

    function renderEvPrice(station) {
      const price = station.price || {};
      const label = price.display || 'Prezzo non disponibile';
      let confidence = 'da verificare';
      let cls = 'amber';
      if (price.confidence === 'indicative') {
        confidence = 'indicativo';
        cls = 'green';
      } else if (price.confidence === 'estimated') {
        confidence = 'stima media';
        cls = 'amber';
      } else if (price.confidence === 'missing') {
        confidence = 'non disponibile';
        cls = 'danger';
      } else if (price.confidence === 'low' || price.confidence === 'text-only') {
        confidence = 'community';
        cls = 'amber';
      }

      const title = price.label || 'Prezzo ricarica';
      const priceUpdated = formatEvDateTime(price.updatedAt);
      const chipTitle = [price.source || '', priceUpdated ? 'Aggiornato: ' + priceUpdated : ''].filter(Boolean).join(' · ');
      const estimate = price.estimate && price.estimate.display
        ? '\n        <div class="chip cyan" title="' + escapeHtml(price.estimate.note || '') + '">\n          <span>Stima sessione</span>\n          <span class="val">' + escapeHtml(price.estimate.display.replace('EUR', '\u20ac')) + '</span>\n          <span>' + escapeHtml(price.estimate.note || 'stima') + '</span>\n        </div>\n      '
        : '';

      return '\n        <div class="chip ' + cls + '" title="' + escapeHtml(chipTitle) + '">\n          <span>' + escapeHtml(title) + '</span>\n          <span class="val">' + escapeHtml(label) + '</span>\n          <span>' + escapeHtml(confidence) + (priceUpdated ? ' · agg. ' + escapeHtml(priceUpdated) : '') + '</span>\n        </div>\n      ' + estimate;
    }

    function renderEvConnections(station) {
      const connections = Array.isArray(station.connections) ? station.connections : [];
      return connections.slice(0, 4).map(function (connection) {
        return '\n          <div class="chip blue">\n            <span>' + escapeHtml(connection.type || 'Connettore') + '</span>\n            <span class="val">' + escapeHtml(formatPower(connection.powerKw)) + '</span>\n            <span>' + escapeHtml(connection.status || '') + '</span>\n          </div>\n        ';
      }).join('') + (connections.length > 4 ? '<div class="chip blue"><span>Altri connettori</span><span class="val">+' + (connections.length - 4) + '</span><span>vedi dettagli</span></div>' : '');
    }

    function renderEvDetails(station) {
      const connections = Array.isArray(station.connections) ? station.connections : [];
      const rows = connections.map(function (connection) {
        return '\n          <tr>\n            <td>' + escapeHtml(connection.type || 'Connettore') + '</td>\n            <td>' + escapeHtml(formatPower(connection.powerKw)) + '</td>\n            <td>' + escapeHtml(connection.currentType || 'n.d.') + '</td>\n            <td>' + escapeHtml(connection.status || 'stato n.d.') + '</td>\n          </tr>\n        ';
      }).join('');
      const source = station.sourceUrl ? '<a href="' + escapeHtml(station.sourceUrl) + '" target="_blank" rel="noopener">Scheda OpenChargeMap</a>' : '';
      const verified = station.verifiedAt ? 'Ultima verifica: ' + formatEvDateTime(station.verifiedAt) : '';
      const statusUpdate = station.statusUpdatedAt ? 'Aggiornamento stato: ' + formatEvDateTime(station.statusUpdatedAt) : '';
      const meta = [verified, statusUpdate, source].filter(Boolean).join(' · ');
      return '\n        <details class="ev-details">\n          <summary>Vedi dettagli tecnici e fonte dati</summary>\n          <div class="ev-details-body">\n            ' + (rows ? '<table class="ev-details-table"><thead><tr><th>Tipo</th><th>Potenza</th><th>Corrente</th><th>Stato</th></tr></thead><tbody>' + rows + '</tbody></table>' : '<div class="meta">Nessun dettaglio connettore disponibile.</div>') + '\n            ' + (meta ? '<div class="meta">' + meta + '</div>' : '') + '\n          </div>\n        </details>\n      ';
    }

    function injectStyles() {
      const style = document.createElement('style');
      style.id = 'evUnifiedStyles';
      style.textContent = `
        .fuel-toggle.active-cyan {
          border-color: rgba(56, 189, 248, .55);
          background: rgba(56, 189, 248, .16);
          color: #fff;
          box-shadow: 0 4px 12px rgba(56, 189, 248, .12);
        }
        .ev-unified-toggle {
          border-color: rgba(56, 189, 248, .28);
        }
        .ev-connectors-panel {
          margin: -6px 0 22px;
          padding: 14px;
          border: 1px solid rgba(56, 189, 248, .16);
          border-radius: 16px;
          background: rgba(15, 23, 42, .38);
        }
        .ev-filter-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
        }
        .ev-filter-title {
          color: #e2e8f0;
          font-weight: 800;
          font-size: .85rem;
          margin-bottom: 4px;
        }
        .ev-filter-help {
          color: #94a3b8;
          font-size: .78rem;
          margin-bottom: 12px;
        }
        .ev-connector-row {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }
        .ev-connector-chip,
        .ev-power-chip {
          border: 1px solid var(--line);
          border-radius: 12px;
          background: #0e1217;
          color: #94a3b8;
          padding: 10px 14px;
          cursor: pointer;
          display: inline-flex;
          flex-direction: column;
          gap: 2px;
          min-width: 118px;
          text-align: left;
        }
        .ev-connector-chip span,
        .ev-power-chip span {
          font-weight: 800;
          color: #e2e8f0;
        }
        .ev-connector-chip small,
        .ev-power-chip small {
          color: #94a3b8;
          font-size: .72rem;
        }
        .ev-connector-chip.is-active,
        .ev-power-chip.is-active {
          border-color: rgba(56, 189, 248, .45);
          background: rgba(56, 189, 248, .12);
          box-shadow: 0 4px 12px rgba(56, 189, 248, .08);
        }
        .ev-extra-row {
          display: flex;
          align-items: center;
          gap: 14px;
          flex-wrap: wrap;
          margin-top: 14px;
          padding-top: 14px;
          border-top: 1px solid rgba(255,255,255,.06);
          color: #cbd5e1;
          font-size: .86rem;
        }
        .ev-check,
        .ev-kwh-label {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          margin: 0;
          color: #cbd5e1;
          font-weight: 700;
        }
        .ev-kwh-input {
          width: 78px !important;
          padding: 8px 10px !important;
          min-height: 0;
          border-radius: 10px !important;
        }
        .ev-result-note {
          padding: 0 0 12px;
          border-bottom: 1px solid rgba(255,255,255,.07);
          color: #94a3b8;
          line-height: 1.5;
          font-size: .86rem;
        }
        .ev-mini-badges {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-top: 10px;
        }
        .ev-score-badge,
        .ev-quality {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 7px 10px;
          border-radius: 999px;
          font-size: .72rem;
          font-weight: 800;
          border: 1px solid rgba(255,255,255,.10);
        }
        .ev-score-badge,
        .ev-quality-recent,
        .ev-quality-verify,
        .ev-quality-stale,
        .ev-quality-incomplete {
          background: transparent;
          color: #cbd5e1;
          border-color: rgba(255,255,255,.11);
        }
        .chip.cyan {
          background: rgba(15,23,42,.38);
          border-color: rgba(255,255,255,.09);
        }
        .ev-details {
          margin-top: 12px;
          color: #94a3b8;
          font-size: .82rem;
        }
        .ev-details summary {
          cursor: pointer;
          color: #bae6fd;
          font-weight: 800;
        }
        .ev-details ul {
          margin: 10px 0 0;
          padding-left: 18px;
          line-height: 1.7;
        }
        .ev-details a {
          color: #bae6fd;
          text-decoration: none;
          font-weight: 800;
        }
        #evResultsMap.results-map {
          width: 100%;
          height: 420px;
        }
        .leaflet-popup-content {
          color: #111827;
          font-size: 13px;
          line-height: 1.4;
        }

        .ev-card.card {
          display: block;
          padding: 22px;
          border-radius: 22px;
        }
        .ev-card.card.best {
          border-width: 1px;
          box-shadow: 0 8px 28px rgba(0,0,0,.18);
        }
        .ev-card .ev-operator-pill {
          animation: none;
          background: transparent;
          color: #94a3b8;
          border: 1px solid rgba(255,255,255,.10);
          box-shadow: none;
          font-size: .66rem;
          letter-spacing: .04em;
        }
        .ev-card-head {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 16px;
          align-items: start;
        }
        .ev-card-titleblock {
          min-width: 0;
        }
        .ev-card-actions {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 10px;
          min-width: 92px;
        }
        .ev-card-actions .map {
          margin-top: 0;
        }
        .ev-card .dist {
          font-size: 1.18rem;
        }
        .ev-badges {
          display: flex;
          flex-wrap: wrap;
          gap: 7px;
          margin-top: 11px;
        }
        .ev-badge {
          display: inline-flex;
          align-items: center;
          min-height: 24px;
          padding: 4px 8px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,.11);
          background: transparent;
          color: #cbd5e1;
          font-size: .7rem;
          line-height: 1;
          font-weight: 750;
          white-space: nowrap;
        }
        .ev-badge-recommended {
          color: #bae6fd;
          border-color: rgba(56,189,248,.34);
          background: rgba(56,189,248,.07);
        }
        .ev-badge-good,
        .ev-badge-score,
        .ev-badge-estimate,
        .ev-badge-community,
        .ev-badge-warn,
        .ev-badge-bad,
        .ev-badge-missing,
        .ev-badge-unknown {
          background: transparent;
          color: #cbd5e1;
          border-color: rgba(255,255,255,.11);
        }
        .ev-summary-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 14px 28px;
          margin-top: 16px;
          padding-top: 16px;
          border-top: 1px solid rgba(255,255,255,.08);
        }
        .ev-metric {
          min-width: 0;
          padding: 0;
          border: 0;
          background: transparent;
        }
        .ev-metric-label {
          color: #94a3b8;
          font-size: .68rem;
          font-weight: 800;
          letter-spacing: .045em;
          text-transform: uppercase;
        }
        .ev-metric-value {
          margin-top: 5px;
          color: #f8fafc;
          font-size: 1.02rem;
          line-height: 1.2;
          font-weight: 850;
          overflow-wrap: anywhere;
        }
        .ev-metric-sub {
          margin-top: 4px;
          color: #94a3b8;
          font-size: .74rem;
          line-height: 1.35;
        }
        .ev-metric-good,
        .ev-metric-estimate,
        .ev-metric-community,
        .ev-metric-warn,
        .ev-metric-power,
        .ev-metric-missing {
          border-color: transparent;
          background: transparent;
        }
        .ev-connector-summary {
          display: flex;
          flex-wrap: wrap;
          gap: 6px 8px;
          align-items: baseline;
          margin-top: 14px;
          padding-top: 12px;
          border-top: 1px solid rgba(255,255,255,.07);
          color: #94a3b8;
          font-size: .78rem;
          line-height: 1.45;
        }
        .ev-connector-label {
          color: #94a3b8;
          font-size: .68rem;
          font-weight: 800;
          letter-spacing: .045em;
          text-transform: uppercase;
        }
        .ev-connector-title {
          color: #e2e8f0;
          font-size: .86rem;
          font-weight: 800;
        }
        .ev-connector-sub {
          color: #94a3b8;
          font-size: .78rem;
          line-height: 1.4;
        }
        .ev-cost-note,
        .ev-source-line {
          margin-top: 10px;
          color: #94a3b8;
          font-size: .76rem;
          line-height: 1.45;
        }
        .ev-cost-note {
          padding: 0;
          border-radius: 0;
          background: transparent;
          border: 0;
        }
        .ev-details {
          margin-top: 14px;
          color: #94a3b8;
          font-size: .82rem;
        }
        .ev-details summary {
          cursor: pointer;
          color: #cbd5e1;
          font-weight: 750;
          list-style-position: inside;
        }
        .ev-details-body {
          margin-top: 10px;
          padding-top: 12px;
          border-top: 1px solid rgba(255,255,255,.07);
          border-radius: 0;
          background: transparent;
        }
        .ev-details-table {
          width: 100%;
          border-collapse: collapse;
          color: #cbd5e1;
          font-size: .78rem;
        }
        .ev-details-table th,
        .ev-details-table td {
          padding: 8px 6px;
          border-bottom: 1px solid rgba(255,255,255,.06);
          text-align: left;
          vertical-align: top;
        }
        .ev-details-table th {
          color: #94a3b8;
          font-size: .7rem;
          text-transform: uppercase;
          letter-spacing: .04em;
        }
        .ev-details a {
          color: #bae6fd;
          text-decoration: none;
          font-weight: 800;
        }

        @media (max-width: 760px) {
          .ev-card-head {
            grid-template-columns: 1fr;
          }
          .ev-card-actions {
            align-items: flex-start;
            flex-direction: row;
            justify-content: space-between;
            width: 100%;
            padding-top: 14px;
            border-top: 1px solid rgba(255,255,255,.08);
          }
          .ev-summary-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
          .ev-details-table {
            min-width: 520px;
          }
          .ev-details-body {
            overflow-x: auto;
          }
          .ev-filter-grid {
            grid-template-columns: 1fr;
          }
          .ev-connector-chip,
          .ev-power-chip {
            width: 100%;
          }
          .ev-extra-row {
            align-items: stretch;
            flex-direction: column;
          }
        }
        @media (max-width: 520px) {
          .ev-summary-grid {
            grid-template-columns: 1fr;
          }
        }
      `;
      document.head.appendChild(style);
    }
  });
})();
