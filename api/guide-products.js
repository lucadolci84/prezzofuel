(function () {
    const root = document.querySelector('[data-amazon-group]');
    if (!root) return;

    const group = root.getAttribute('data-amazon-group');
    const endpoint = `/api/amazon-products?group=${encodeURIComponent(group)}`;
    const listEl = root.querySelector('[data-products-list]');
    const statusEl = root.querySelector('[data-products-status]');
    const countEl = root.querySelector('[data-products-count]');

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function renderProducts(items) {
        listEl.innerHTML = items.map((item) => `
      <article class="product-card">
        <div class="product-image">
          <img src="${escapeHtml(item.imageUrl || '/assets/images/amazon-product-placeholder.svg')}"
               alt="${escapeHtml(item.title)}"
               loading="lazy"
               onerror="this.onerror=null;this.src='/assets/images/amazon-product-placeholder.svg'" />
        </div>
        <div class="product-body">
          <span class="product-tag">${escapeHtml(item.label)}</span>
          <h3>${escapeHtml(item.title)}</h3>
          <p>${escapeHtml(item.description)}</p>
          <div class="product-actions">
            <a class="btn" href="${escapeHtml(item.amazonUrl)}" target="_blank" rel="nofollow sponsored noopener">Vedi su Amazon</a>
          </div>
        </div>
      </article>
    `).join('');
    }

    async function loadProducts() {
        statusEl.textContent = 'Caricamento prodotti…';

        try {
            const response = await fetch(endpoint, { headers: { 'Accept': 'application/json' } });
            const data = await response.json();

            if (!response.ok || !data.ok || !Array.isArray(data.products)) {
                throw new Error(data && data.error ? data.error : 'Impossibile caricare i prodotti');
            }

            renderProducts(data.products);
            statusEl.textContent = '';

            if (countEl) {
                countEl.textContent = `${data.products.length} prodotti selezionati`;
            }
        } catch (err) {
            statusEl.textContent = 'Prodotti non disponibili in questo momento.';
            listEl.innerHTML = '';
            if (countEl) countEl.textContent = '';
            console.error(err);
        }
    }

    loadProducts();
})();