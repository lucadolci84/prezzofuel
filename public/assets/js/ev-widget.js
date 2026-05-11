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
    const mapWrap = document.getElementById('mapWrap');

    if (!panel || !fuelRow || !capEl || !radiusEl || !searchBtn || !geoBtn || !statusEl || !noticeEl || !resultsEl) return;
    if (document.getElementById('evUnifiedToggle')) return;

    const originalSearchText = searchBtn.textContent;
    const originalSortOptions = sortSelect ? sortSelect.innerHTML : '';
    let evMode = false;
    let lastEvParams = null;

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

    function setEvMode(enabled) {
      evMode = Boolean(enabled);
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
        if (data.pricingNote) setNotice(data.pricingNote, 'warn');
      } catch (err) {
        clearStatus();
        setNotice(err.message || 'Errore durante la ricerca delle colonnine.', 'error');
        resultsEl.innerHTML = '';
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
      } else if (price.confidence === 'missing') {
        confidence = 'non disponibile';
        cls = 'danger';
      }

      return '\n        <div class="chip ' + cls + '">\n          <span>Prezzo ricarica</span>\n          <span class="val">' + escapeHtml(label) + '</span>\n          <span>' + escapeHtml(confidence) + '</span>\n        </div>\n      ';
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
      style.textContent = '\n        .fuel-toggle.active-cyan {\n          border-color: rgba(56, 189, 248, .55);\n          background: rgba(56, 189, 248, .16);\n          color: #fff;\n          box-shadow: 0 4px 12px rgba(56, 189, 248, .12);\n        }\n        .ev-unified-toggle {\n          border-color: rgba(56, 189, 248, .28);\n        }\n        .ev-connectors-panel {\n          margin: -6px 0 22px;\n          padding: 14px;\n          border: 1px solid rgba(56, 189, 248, .16);\n          border-radius: 16px;\n          background: rgba(15, 23, 42, .38);\n        }\n        .ev-filter-title {\n          color: #e2e8f0;\n          font-weight: 800;\n          font-size: .85rem;\n          margin-bottom: 4px;\n        }\n        .ev-filter-help {\n          color: #94a3b8;\n          font-size: .78rem;\n          margin-bottom: 12px;\n        }\n        .ev-connector-row {\n          display: flex;\n          gap: 10px;\n          flex-wrap: wrap;\n        }\n        .ev-connector-chip {\n          border: 1px solid var(--line);\n          border-radius: 12px;\n          background: #0e1217;\n          color: #94a3b8;\n          padding: 10px 14px;\n          cursor: pointer;\n          display: inline-flex;\n          flex-direction: column;\n          gap: 2px;\n          min-width: 132px;\n          text-align: left;\n        }\n        .ev-connector-chip span {\n          font-weight: 800;\n          color: #e2e8f0;\n        }\n        .ev-connector-chip small {\n          color: #94a3b8;\n          font-size: .72rem;\n        }\n        .ev-connector-chip.is-active {\n          border-color: rgba(56, 189, 248, .45);\n          background: rgba(56, 189, 248, .12);\n          box-shadow: 0 4px 12px rgba(56, 189, 248, .08);\n        }\n        @media (max-width: 760px) {\n          .ev-connector-chip {\n            width: 100%;\n          }\n        }\n      ';
      document.head.appendChild(style);
    }
  });
})();
