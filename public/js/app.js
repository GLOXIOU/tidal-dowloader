document.addEventListener('DOMContentLoaded', async () => {
  const loginSection = document.getElementById('login-section');
  const dashboardSection = document.getElementById('dashboard-section');
  const loginBtn = document.getElementById('login-btn');
  const logoutBtn = document.querySelector('.logout-btn');
  const profileEmail = document.querySelector('.profile-email');
  const linkInput = document.getElementById('link-input');
  const qualitySelect = document.getElementById('quality-select');
  const resultsContainer = document.getElementById('results-container');
  const playlistsContainer = document.getElementById('playlists-container');
  const queueContainer = document.getElementById('queue-container');
  const loginModal = document.getElementById('login-modal');
  const deviceLink = document.getElementById('device-link');
  const deviceCode = document.getElementById('device-code');

  let eventSource = null;
  const queueItems = new Map();

  function showDashboard(email) {
    profileEmail.textContent = email || 'Compte Tidal connecté';
    loginSection.style.display = 'none';
    dashboardSection.style.display = 'flex';
    connectQueueStream();
    fetchPlaylists();
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
      if (data.authenticated) showDashboard(data.email);
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
        checkSession();
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

  function coverUrl(cover, size = '160') {
    if (!cover) return '';
    return `https://resources.tidal.com/images/${cover.replace(/-/g, '/')}/${size}x${size}.jpg`;
  }

  function coverIdFor(type, item) {
    if (type === 'track' || type === 'video') return item.album?.cover;
    if (type === 'album') return item.cover;
    if (type === 'playlist') return item.squareImage || item.image;
    if (type === 'artist') return item.picture;
    return null;
  }

  function imgTag(cover) {
    if (!cover) return '';
    return `<img src="${cover}" alt="" onerror="this.remove()">`;
  }

  function renderCard(outerClass, prefix, { title, sub, cover }) {
    const card = document.createElement('div');
    card.className = outerClass;
    card.innerHTML = `
      <div class="${prefix}-image">${imgTag(cover)}</div>
      <div class="${prefix}-info">
        <div class="${prefix}-title"></div>
        <div class="${prefix}-sub"></div>
      </div>
    `;
    card.querySelector(`.${prefix}-title`).textContent = title;
    card.querySelector(`.${prefix}-sub`).textContent = sub || '';
    return card;
  }

  function downloadButton(type, id) {
    const btn = document.createElement('button');
    btn.className = 'download-btn';
    btn.type = 'button';
    btn.textContent = 'Télécharger';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      downloadItem(type, id);
    });
    return btn;
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
        const id = type === 'playlist' ? item.uuid : item.id;
        const sub = type === 'playlist' ? `${item.numberOfTracks || 0} titres` : (item.artists || []).map((a) => a.name).join(', ');
        const card = renderCard('result-card', 'result', {
          title: item.title,
          sub,
          cover: coverUrl(coverIdFor(type, item)),
        });
        const chip = document.createElement('span');
        chip.className = 'result-type-chip';
        chip.textContent = type;
        card.appendChild(chip);
        card.appendChild(downloadButton(type, id));
        resultsContainer.appendChild(card);
      }
    }
    if (!any) resultsContainer.innerHTML = '<div class="empty-state">Aucun résultat.</div>';
  }

  function renderPreview(resolved) {
    resultsContainer.innerHTML = '';
    const { type, data } = resolved;
    const id = type === 'playlist' ? data.uuid : data.id;
    const sub = type === 'playlist'
      ? `${data.numberOfTracks || 0} titres`
      : (data.artists || [data.artist]).filter(Boolean).map((a) => a.name).join(', ');

    const card = renderCard('result-card', 'result', { title: data.title, sub, cover: coverUrl(coverIdFor(type, data)) });
    const chip = document.createElement('span');
    chip.className = 'result-type-chip';
    chip.textContent = type;
    card.appendChild(chip);
    card.appendChild(downloadButton(type, id));
    resultsContainer.appendChild(card);
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

  async function fetchPlaylists() {
    playlistsContainer.innerHTML = '<div class="empty-state">Chargement de tes playlists...</div>';
    try {
      const res = await fetch('/api/playlists');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Impossible de charger tes playlists.');

      const playlists = data.playlists || [];
      if (!playlists.length) {
        playlistsContainer.innerHTML = '<div class="empty-state">Aucune playlist trouvée sur ton compte Tidal.</div>';
        return;
      }

      const grid = document.createElement('div');
      grid.className = 'playlists-grid';
      for (const pl of playlists) {
        const card = renderCard('playlist-card', 'playlist', {
          title: pl.title,
          sub: `${pl.numberOfTracks || 0} titres`,
          cover: coverUrl(coverIdFor('playlist', pl)),
        });
        card.appendChild(downloadButton('playlist', pl.uuid));
        grid.appendChild(card);
      }
      playlistsContainer.innerHTML = '';
      playlistsContainer.appendChild(grid);
    } catch (err) {
      playlistsContainer.innerHTML = `<div class="empty-state">${err.message}</div>`;
    }
  }

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
      el.querySelector('.queue-item-image').innerHTML = imgTag(coverUrl(item.cover));
    }

    const emptyState = queueContainer.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    el.querySelector('.queue-item-title').textContent = item.title;
    el.querySelector('.queue-item-sub').textContent = item.error || item.sub || '';
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
