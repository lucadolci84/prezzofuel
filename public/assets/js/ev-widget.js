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

    if (!panel || !fuelRow || !capEl || !radiusEl || !searchBtn || !geoBtn || !statusEl || !noticeEl || !resultsEl) return;
    if (document.getElementById('evUnifiedToggle')) return;

    const originalSearchText = searchBtn.textContent;
    const originalSortOptions = sortSelect ? sortSelect.innerHTML : '';
    const fuelActiveClasses = ['active-green', 'active-blue', 'active-amber', 'active-cyan'];
    let evMode = false;
    let lastEvParams = null;
    let evMap = null;
    let evMarkerLayer = null;
    let evMapTarget = null;
    let leafletPromise = null;
    const originalResultsMap = document.getElementById('resultsMap');
    const originalMapWrapDisplay = mapWrap ? mapWrap.style.display : '';

    injectStyles();
    addElectricToggle();
    addConnectorFilters();

    const evToggle = document.getElementById('evUnifiedToggle');
    const connectorRow = document.getElementById('evConnectorFilters');

    evToggle.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setEvMode(!evMode);
    }, true);

    fuelRow.addEventListener('click', function (event) {
      const normalFuel = event.target.closest('.fuel-toggle[data-fuel]:not([data-fuel="elettrico"])');
      if (normalFuel && evMode) setEvMode(false);
    }, true);

    connectorRow.addEventListener('click', function (event) {
      const item = event.target.closest('.ev-connector-chip');
      if (!item) return;
      item.classList.toggle('is-active');
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
        if (lastEvParams) runEvSearch(lastEvParams);
      }, true);
    }

    function addElectricToggle() {
      fuelRow.insertAdjacentHTML('beforeend', '\n        <div class="fuel-toggle ev-unified-toggle" id="evUnifiedToggle" data-fuel="elettrico" title="Cerca colonnine di ricarica elettrica">\n          <span class="dot"></span>Elettrico\n        </div>\n      ');
    }

    function addConnectorFilters() {
      fuelRow.insertAdjacentHTML('afterend', '\n        <div class="ev-connectors-panel" id="evConnectorFilters" hidden>\n          <div class="ev-filter-title">Tipo di ricarica</div>\n          <div class="ev-filter-help">Puoi lasciare selezionati tutti i tipi se non sai quale scegliere.</div>\n          <div class="ev-connector-row">\n            <button type="button" class="ev-connector-chip is-active" data-connector="type2">\n              <span>AC / Type 2</span><small>ricarica normale</small>\n            </button>\n            <button type="button" class="ev-connector-chip is-active" data-connector="ccs">\n              <span>DC rapida / CCS</span><small>auto moderne</small>\n            </button>\n            <button type="button" class="ev-connector-chip" data-connector="chademo">\n              <span>CHAdeMO</span><small>alcuni modelli datati</small>\n            </button>\n          </div>\n        </div>\n      ');
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
      searchBtn.textContent = evMode ? ' Trova colonnine' : originalSearchText;
      capEl.placeholder = evMode ? 'Es. 20121 oppure Via Roma 10, Milano' : 'Es. 20121 oppure Via Roma 10, Milano';

      if (sortSelect) {
        if (evMode) {
          sortSelect.innerHTML = '\n            <option value="price">Prezzo migliore</option>\n            <option value="distance">Distanza</option>\n            <option value="power">Potenza massima</option>\n          ';
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

    function selectedSort() {
      return sortSelect ? sortSelect.value : 'price';
    }

    async function runEvSearch(params) {
      const connectors = activeConnectors();
      if (!connectors.length) {
        setNotice('Seleziona almeno un tipo di ricarica, oppure lascia attivi AC/Type 2 e CCS.', 'warn');
        return;
      }

      const radius = String(params.radius || radiusEl.value || 10);
      const query = new URLSearchParams({
        radius: radius,
        connectors: connectors.join(','),
        sort: selectedSort()
      });

      if (params.lat && params.lon) {
        query.set('lat', String(params.lat));
        query.set('lon', String(params.lon));
      } else {
        const q = String(params.q || capEl.value || '').trim();
        if (!q) {
          setNotice('Inserisci un CAP, un indirizzo o usa la tua posizione.', 'warn');
          return;
        }
        query.set('q', q);
      }

      lastEvParams = Object.assign({}, params, { radius: radius });
      resultsEl.innerHTML = '';
      clearNotice();
      setStatus('<span class="spinner"></span> Ricerca colonnine in corso...');
      if (sortBar) sortBar.style.display = 'none';
      if (mapWrap) mapWrap.style.display = 'none';

      try {
        const response = await fetch('/api/ev-stations?' + query.toString(), {
          headers: { Accept: 'application/json' }
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || 'Errore durante la ricerca delle colonnine');
        clearStatus();
        renderEvResults(data);
        renderEvMap(data);
      } catch (err) {
        clearStatus();
        setNotice(err.message || 'Errore durante la ricerca delle colonnine.', 'error');
        resultsEl.innerHTML = '';
        hideEvMap();
      }
    }

    function runEvGeoSearch() {
      if (!navigator.geolocation) {
        setNotice('Geolocalizzazione non supportata dal browser.', 'warn');
        return;
      }
      clearNotice();
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

      // Manteniamo lo stesso involucro grafico usato per benzina/diesel/GPL/metano.
      // Usiamo solo un div mappa separato per non interferire con l'istanza Leaflet
      // originale, che vive nella closure dello script principale.
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
      const price = station.price && station.price.display ? station.price.display : 'Prezzo non disponibile';
      const title = station.title || 'Colonnina di ricarica';
      const meta = [station.address || '', Number(station.distanceKm || 0).toFixed(1) + ' km']
        .filter(Boolean)
        .map(escapeHtml)
        .join('<br>');
      const power = formatPower(station.maxPowerKw);
      return '\n        <div class="map-popup">\n          <div class="title">' + escapeHtml(title) + '</div>\n          <div class="meta">' + meta + '</div>\n          <div class="price">' + escapeHtml(price) + ' · ' + escapeHtml(power) + '</div>\n          <div class="meta"><a href="' + maps + '" target="_blank" rel="noopener">Apri navigatore</a></div>\n        </div>\n      ';
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

    function renderEvResults(data) {
      const items = Array.isArray(data.results) ? data.results : [];
      if (sortBar) sortBar.style.display = items.length ? 'flex' : 'none';
      if (countBadge) countBadge.textContent = items.length ? items.length + ' colonnine trovate' : '';

      if (!items.length) {
        resultsEl.innerHTML = '<div class="empty">Nessuna colonnina trovata nel raggio selezionato.</div>';
        return;
      }

      resultsEl.innerHTML = items.map(function (station, index) {
        const maps = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(String(station.lat) + ',' + String(station.lon));
        const operator = station.operator ? '<span class="pill">' + escapeHtml(station.operator) + '</span>' : '';
        const priceHtml = renderEvPrice(station);
        const connectorHtml = renderEvConnections(station);
        const status = station.status || 'n.d.';
        const power = formatPower(station.maxPowerKw);
        const title = station.title || 'Colonnina di ricarica';

        return '\n          <div class="card ' + (index === 0 ? 'best' : '') + '">\n            <div>\n              <div class="name">' + escapeHtml(title) + ' ' + operator + '</div>\n              <div class="addr">' + escapeHtml(station.address || '') + '</div>\n              <div class="meta">Fonte: ' + escapeHtml(station.source || 'OpenChargeMap') + ' · Stato: ' + escapeHtml(status) + ' · Potenza max: ' + escapeHtml(power) + '</div>\n              <div class="prices">' + priceHtml + connectorHtml + '</div>\n              ' + (station.usageCostText ? '<div class="meta">Nota costo: ' + escapeHtml(station.usageCostText) + '</div>' : '') + '\n            </div>\n            <div class="right">\n              <div class="dist">' + Number(station.distanceKm || 0).toFixed(1) + ' <span>km</span></div>\n              <a class="map" href="' + maps + '" target="_blank" rel="noopener">Mappa</a>\n            </div>\n          </div>\n        ';
      }).join('');
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
      }

      const title = price.label || 'Prezzo ricarica';
      return '\n        <div class="chip ' + cls + '" title="' + escapeHtml(price.source || '') + '">\n          <span>' + escapeHtml(title) + '</span>\n          <span class="val">' + escapeHtml(label) + '</span>\n          <span>' + escapeHtml(confidence) + '</span>\n        </div>\n      ';
    }

    function renderEvConnections(station) {
      const connections = Array.isArray(station.connections) ? station.connections : [];
      return connections.slice(0, 4).map(function (connection) {
        return '\n          <div class="chip blue">\n            <span>' + escapeHtml(connection.type || 'Connettore') + '</span>\n            <span class="val">' + escapeHtml(formatPower(connection.powerKw)) + '</span>\n            <span>' + escapeHtml(connection.status || '') + '</span>\n          </div>\n        ';
      }).join('');
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
        .ev-connector-chip {
          border: 1px solid var(--line);
          border-radius: 12px;
          background: #0e1217;
          color: #94a3b8;
          padding: 10px 14px;
          cursor: pointer;
          display: inline-flex;
          flex-direction: column;
          gap: 2px;
          min-width: 132px;
          text-align: left;
        }
        .ev-connector-chip span {
          font-weight: 800;
          color: #e2e8f0;
        }
        .ev-connector-chip small {
          color: #94a3b8;
          font-size: .72rem;
        }
        .ev-connector-chip.is-active {
          border-color: rgba(56, 189, 248, .45);
          background: rgba(56, 189, 248, .12);
          box-shadow: 0 4px 12px rgba(56, 189, 248, .08);
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
        @media (max-width: 760px) {
          .ev-connector-chip {
            width: 100%;
          }
        }
      `;
      document.head.appendChild(style);
    }

  });
})();
