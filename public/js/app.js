document.addEventListener('DOMContentLoaded', async () => {
  const loginSection = document.getElementById('login-section');
  const dashboardSection = document.getElementById('dashboard-section');
  const loginBtn = document.getElementById('login-btn');
  const logoutBtn = document.querySelector('.logout-btn');
  const linkInput = document.getElementById('link-input');
  const qualitySelect = document.getElementById('quality-select');
  const resultsContainer = document.getElementById('results-container');
  const queueContainer = document.getElementById('queue-container');
  const loginModal = document.getElementById('login-modal');
  const deviceLink = document.getElementById('device-link');
  const deviceCode = document.getElementById('device-code');

  let eventSource = null;
  const queueItems = new Map();

  function showDashboard() {
    loginSection.style.display = 'none';
    dashboardSection.style.display = 'flex';
    connectQueueStream();
  }

  function showLogin() {
    loginSection.style.display = 'flex';
    dashboardSection.style.display = 'none';
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  }

  async function checkSession() {
    try {
      const res = await fetch('/api/session');
      const data = await res.json();
      if (data.authenticated) showDashboard();
      else showLogin();
    } catch {
      showLogin();
    }
  }

  async function pollLogin() {
    try {
      const res = await fetch('/auth/tidal/poll');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        loginModal.classList.remove('active');
        if (typeof showToast === 'function') showToast(data.error || 'Connexion échouée.', 'error');
        return;
      }
      if (data.done) {
        loginModal.classList.remove('active');
        showDashboard();
        return;
      }
      setTimeout(pollLogin, 2500);
    } catch {
      setTimeout(pollLogin, 2500);
    }
  }

  loginBtn?.addEventListener('click', async () => {
    try {
      const res = await fetch('/auth/tidal/login', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Impossible de démarrer la connexion.');

      deviceLink.href = data.verificationUrl;
      deviceLink.textContent = data.verificationUrl.replace(/^https?:\/\//, '');
      deviceCode.textContent = data.userCode;
      loginModal.classList.add('active');

      setTimeout(pollLogin, (data.interval || 2) * 1000);
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.message, 'error');
    }
  });

  logoutBtn?.addEventListener('click', async () => {
    try {
      await fetch('/auth/logout', { method: 'POST' });
    } finally {
      showLogin();
    }
  });

  function formatDuration(seconds) {
    if (!seconds && seconds !== 0) return '';
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function coverUrl(cover, size = '160') {
    if (!cover) return '';
    return `https://resources.tidal.com/images/${cover.replace(/-/g, '/')}/${size}x${size}.jpg`;
  }

  function renderResultCard({ type, id, title, sub, cover }) {
    const card = document.createElement('div');
    card.className = 'result-card';
    card.innerHTML = `
      <div class="result-image">${cover ? `<img src="${cover}" alt="">` : ''}</div>
      <div class="result-info">
        <div class="result-title"></div>
        <div class="result-sub"></div>
      </div>
      <span class="result-type-chip"></span>
      <button class="download-btn" type="button">Télécharger</button>
    `;
    card.querySelector('.result-title').textContent = title;
    card.querySelector('.result-sub').textContent = sub || '';
    card.querySelector('.result-type-chip').textContent = type;
    card.querySelector('.download-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      downloadItem(type, id);
    });
    return card;
  }

  async function downloadItem(type, id) {
    try {
      const res = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, id, quality: qualitySelect.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Échec du téléchargement.');
      if (typeof showToast === 'function') showToast('Ajouté à la file de téléchargement.', 'success');
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.message, 'error');
    }
  }

  function renderSearchResults(data) {
    resultsContainer.innerHTML = '';
    const groups = [
      ['tracks', 'track'],
      ['albums', 'album'],
      ['playlists', 'playlist'],
    ];
    let any = false;
    for (const [key, type] of groups) {
      for (const item of data[key]?.items || []) {
        any = true;
        const sub = type === 'track' || type === 'album'
          ? (item.artists || []).map((a) => a.name).join(', ')
          : `${item.numberOfTracks || 0} titres`;
        resultsContainer.appendChild(
          renderResultCard({
            type,
            id: type === 'playlist' ? item.uuid : item.id,
            title: item.title,
            sub,
            cover: coverUrl(item.album?.cover || item.cover || item.image),
          }),
        );
      }
    }
    if (!any) resultsContainer.innerHTML = '<div class="empty-state">Aucun résultat.</div>';
  }

  function renderPreview(resolved) {
    resultsContainer.innerHTML = '';
    const { type, data } = resolved;
    const sub = type === 'playlist'
      ? `${data.numberOfTracks || 0} titres`
      : (data.artists || [data.artist]).filter(Boolean).map((a) => a.name).join(', ');
    resultsContainer.appendChild(
      renderResultCard({
        type,
        id: type === 'playlist' ? data.uuid : data.id,
        title: data.title,
        sub,
        cover: coverUrl(data.cover || data.image),
      }),
    );
  }

  let debounceTimer;
  linkInput?.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    clearTimeout(debounceTimer);

    if (!val) {
      resultsContainer.innerHTML = '';
      return;
    }

    debounceTimer = setTimeout(async () => {
      try {
        if (val.includes('tidal.com')) {
          const res = await fetch('/api/resolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: val }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Lien non reconnu.');
          renderPreview(data);
        } else if (val.length > 1) {
          const res = await fetch(`/api/search?q=${encodeURIComponent(val)}`);
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Recherche impossible.');
          renderSearchResults(data);
        }
      } catch (err) {
        resultsContainer.innerHTML = `<div class="empty-state">${err.message}</div>`;
      }
    }, 400);
  });

  function renderQueueItem(item) {
    let el = queueItems.get(item.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'queue-item';
      el.innerHTML = `
        <div class="queue-item-image"></div>
        <div class="queue-item-info">
          <div class="queue-item-title"></div>
          <div class="queue-item-sub"></div>
          <div class="progress-track"><div class="progress-fill" style="width:0%"></div></div>
        </div>
        <span class="queue-item-status"></span>
      `;
      queueItems.set(item.id, el);
      queueContainer.prepend(el);
    }

    const emptyState = queueContainer.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    el.querySelector('.queue-item-title').textContent = item.title;
    el.querySelector('.queue-item-sub').textContent = item.error || item.artist || '';
    el.querySelector('.progress-fill').style.width = `${item.progress || 0}%`;
    const statusEl = el.querySelector('.queue-item-status');
    statusEl.className = `queue-item-status ${item.status}`;
    statusEl.textContent = {
      queued: 'En attente',
      downloading: 'Téléchargement',
      decrypting: 'Déchiffrement',
      tagging: 'Étiquetage',
      done: 'Terminé',
      error: 'Erreur',
    }[item.status] || item.status;
  }

  function connectQueueStream() {
    if (eventSource) eventSource.close();
    eventSource = new EventSource('/api/queue/stream');
    eventSource.onmessage = (evt) => {
      const payload = JSON.parse(evt.data);
      if (payload.items) payload.items.forEach(renderQueueItem);
      if (payload.item) renderQueueItem(payload.item);
    };
  }

  checkSession();
});
