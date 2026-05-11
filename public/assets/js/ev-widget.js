(function () {
  const firstPanel = document.querySelector('.panel');
  if (!firstPanel || document.getElementById('evPanel')) return;

  const html = `
    <section class="panel" id="evPanel" style="margin-top:24px">
      <div class="eyebrow">Auto elettriche</div>
      <h2 style="margin:8px 0 10px;color:#fff;font-size:1.35rem">Trova colonnine e prezzi ricarica</h2>
      <p style="margin:0 0 18px;color:#94a3b8;line-height:1.55">Ricerca colonnine vicine usando OpenChargeMap e, se configurati, feed tariffari esterni.</p>
      <div class="grid">
        <div>
          <label for="ev-q">Dove ti trovi?</label>
          <input id="ev-q" type="text" placeholder="Es. 20121 oppure Via Roma 10, Milano" />
        </div>
        <div>
          <label for="ev-radius">Distanza (Km)</label>
          <input id="ev-radius" type="number" min="1" max="80" step="1" value="10" />
        </div>
      </div>
      <div class="fuel-row" id="ev-connectors" style="margin-top:18px">
        <div class="fuel-toggle active-blue" data-connector="type2"><span class="dot"></span>Type 2</div>
        <div class="fuel-toggle active-green" data-connector="ccs"><span class="dot"></span>CCS</div>
        <div class="fuel-toggle active-amber" data-connector="chademo"><span class="dot"></span>CHAdeMO</div>
      </div>
      <div class="actions">
        <button class="primary" id="evSearchBtn">Trova colonnine</button>
        <button class="secondary" id="evGeoBtn">Usa la mia posizione</button>
      </div>
      <div id="evStatus" class="status"><div class="status-line"></div></div>
      <div id="evNotice" class="notice"></div>
    </section>
    <div class="sortbar" id="evSortBar" style="display:none">
      <div class="count" id="evCountBadge"></div>
      <div>
        <select id="evSortSelect">
          <option value="price">Prezzo migliore</option>
          <option value="distance">Distanza</option>
          <option value="power">Potenza massima</option>
        </select>
      </div>
    </div>
    <div class="results" id="evResults"></div>
  `;

  firstPanel.insertAdjacentHTML('afterend', html);

  const qEl = document.getElementById('ev-q');
  const radiusEl = document.getElementById('ev-radius');
  const statusEl = document.getElementById('evStatus');
  const noticeEl = document.getElementById('evNotice');
  const resultsEl = document.getElementById('evResults');
  const countEl = document.getElementById('evCountBadge');
  const sortBar = document.getElementById('evSortBar');
  const sortSelect = document.getElementById('evSortSelect');
  const searchBtn = document.getElementById('evSearchBtn');
  const geoBtn = document.getElementById('evGeoBtn');
  const connectorRoot = document.getElementById('ev-connectors');

  let lastParams = null;

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function setStatus(message, type) {
    statusEl.classList.toggle('show', Boolean(message));
    statusEl.querySelector('.status-line').innerHTML = message || '';
    noticeEl.className = `notice ${type || ''}`.trim();
    noticeEl.textContent = '';
  }

  function setNotice(message, type) {
    noticeEl.className = `notice show ${type || ''}`.trim();
    noticeEl.textContent = message || '';
  }

  function activeConnectors() {
    return Array.from(connectorRoot.querySelectorAll('.fuel-toggle'))
      .filter((el) => el.className.includes('active'))
      .map((el) => el.getAttribute('data-connector'));
  }

  function formatPower(value) {
    return Number.isFinite(Number(value)) && Number(value) > 0 ? `${Number(value).toFixed(0)} kW` : 'n.d.';
  }

  function renderConnections(station) {
    return (station.connections || []).slice(0, 4).map((connection) => `
      <div class="chip blue">
        <span>${escapeHtml(connection.type || 'Connettore')}</span>
        <span class="val">${escapeHtml(formatPower(connection.powerKw))}</span>
        <span>${escapeHtml(connection.status || '')}</span>
      </div>
    `).join('');
  }

  function renderPrice(station) {
    const price = station.price || {};
    const label = price.display || 'Prezzo non disponibile';
    const confidence = price.confidence === 'indicative'
      ? 'indicativo'
      : price.confidence === 'missing'
        ? 'non disponibile'
        : 'da verificare';
    const cls = price.confidence === 'missing' ? 'danger' : 'green';
    return `
      <div class="chip ${cls}">
        <span>Prezzo</span>
        <span class="val">${escapeHtml(label)}</span>
        <span>${escapeHtml(confidence)}</span>
      </div>
    `;
  }

  function renderResults(data) {
    const items = Array.isArray(data.results) ? data.results : [];
    sortBar.style.display = items.length ? 'flex' : 'none';
    countEl.textContent = `${items.length} colonnine trovate`;

    if (!items.length) {
      resultsEl.innerHTML = '<div class="empty">Nessuna colonnina trovata nel raggio selezionato.</div>';
      return;
    }

    resultsEl.innerHTML = items.map((station, index) => {
      const maps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${station.lat},${station.lon}`)}`;
      const operator = station.operator ? `<span class="pill">${escapeHtml(station.operator)}</span>` : '';
      return `
        <div class="card ${index === 0 ? 'best' : ''}">
          <div>
            <div class="name">${escapeHtml(station.title)} ${operator}</div>
            <div class="addr">${escapeHtml(station.address || '')}</div>
            <div class="meta">Fonte: ${escapeHtml(station.source)} · Stato: ${escapeHtml(station.status || 'n.d.')} · Potenza max: ${escapeHtml(formatPower(station.maxPowerKw))}</div>
            <div class="prices">${renderPrice(station)}${renderConnections(station)}</div>
            ${station.usageCostText ? `<div class="meta">Nota costo: ${escapeHtml(station.usageCostText)}</div>` : ''}
          </div>
          <div class="right">
            <div class="dist">${Number(station.distanceKm || 0).toFixed(1)} <span>km</span></div>
            <a class="map" href="${maps}" target="_blank" rel="noopener">Mappa</a>
          </div>
        </div>
      `;
    }).join('');
  }

  async function runSearch(params) {
    const query = new URLSearchParams({
      radius: String(params.radius || radiusEl.value || 10),
      connectors: activeConnectors().join(','),
      sort: sortSelect.value,
    });

    if (params.lat && params.lon) {
      query.set('lat', String(params.lat));
      query.set('lon', String(params.lon));
    } else {
      const q = String(params.q || qEl.value || '').trim();
      if (!q) {
        setNotice('Inserisci un CAP, un indirizzo o usa la geolocalizzazione.', 'warn');
        return;
      }
      query.set('q', q);
    }

    lastParams = params;
    resultsEl.innerHTML = '';
    setNotice('', '');
    setStatus('<span class="spinner"></span>Ricerca colonnine in corso…');

    try {
      const response = await fetch(`/api/ev-stations?${query.toString()}`, { headers: { Accept: 'application/json' } });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'Errore ricerca colonnine');
      setStatus('');
      if (data.pricingNote) setNotice(data.pricingNote, data.sources?.prices?.length > 1 ? 'warn' : '');
      renderResults(data);
    } catch (err) {
      setStatus('');
      setNotice(err.message || 'Errore ricerca colonnine.', 'error');
      resultsEl.innerHTML = '';
    }
  }

  connectorRoot.addEventListener('click', (event) => {
    const item = event.target.closest('.fuel-toggle');
    if (!item) return;
    const activeClass = item.getAttribute('data-connector') === 'ccs' ? 'active-green' : item.getAttribute('data-connector') === 'type2' ? 'active-blue' : 'active-amber';
    item.classList.toggle(activeClass);
  });

  searchBtn.addEventListener('click', () => runSearch({ q: qEl.value, radius: radiusEl.value }));
  sortSelect.addEventListener('change', () => lastParams && runSearch(lastParams));
  qEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') runSearch({ q: qEl.value, radius: radiusEl.value });
  });

  geoBtn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      setNotice('Geolocalizzazione non supportata dal browser.', 'warn');
      return;
    }
    setStatus('<span class="spinner"></span>Rilevamento posizione…');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setStatus('');
        runSearch({
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          radius: radiusEl.value,
        });
      },
      () => {
        setStatus('');
        setNotice('Non riesco ad accedere alla posizione. Inserisci un CAP o indirizzo.', 'warn');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });

  const pageParams = new URLSearchParams(window.location.search);
  if (pageParams.get('ev') === '1') {
    const inherited = pageParams.get('cap') || pageParams.get('q');
    if (inherited) {
      qEl.value = inherited;
      runSearch({ q: inherited, radius: radiusEl.value });
    }
  }
})();
