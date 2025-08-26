/* Curator with headings, per-type saved, caching & rate-limit
   - Geolocation (10-min cache)
   - Nearby search by dropdown type
   - Results cache (5 min) by type + rounded lat/lng
   - Rate limit: one in-flight, min gap between calls
   - Drag/swipe cards with Hammer.js (pan + fling)
   - Saved list per type (saved:cafe, saved:restaurant, …)
   - Dark mode + active button state + dynamic heading/subtitle
*/
(() => {
  const CACHE_MINUTES = 10;           // location cache
  const RESULT_TTL = 5 * 60 * 1000;   // results cache
  const SEARCH_RADIUS_M = 1500;
  const REQUEST_GAP_MS = 2500;        // min gap to avoid spamming
  let placesService = null;
  let inFlight = false;
  let lastRequestAt = 0;

  // --- TYPE STATE & labels ---
  let currentType = localStorage.getItem('currentType') || 'cafe';
  const TYPE_INFO = {
    cafe:       { name: 'Cafés',       emoji: '☕' },
    restaurant: { name: 'Restaurants', emoji: '🍽️' },
    bakery:     { name: 'Bakeries',    emoji: '🥐' },
    bar:        { name: 'Bars',        emoji: '🍸' },
    library:    { name: 'Libraries',   emoji: '📚' },
    park:       { name: 'Parks',       emoji: '🌳' }
  };

  window.onTypeChange = function onTypeChange(val){
    currentType = val;
    localStorage.setItem('currentType', val);
    setActive('find');
    updateHeading('find');
    getLocation(); // trigger a fresh search for this type
  };

  // Init UI on load
  window.addEventListener('DOMContentLoaded', () => {
    const sel = document.getElementById('placeType');
    if (sel) sel.value = currentType;
    const lastView = localStorage.getItem('viewMode');
    if (lastView === 'saved') { setActive('saved'); updateHeading('saved'); showSaved(); }
    else { setActive('find'); updateHeading('find'); }
  });

  // ---------- THEME ----------
  initTheme();
  window.toggleTheme = function toggleTheme() {
    const mode = document.body.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.body.setAttribute('data-theme', mode);
    localStorage.setItem('theme', mode);
    const btn = document.getElementById('themeBtn');
    if (btn) btn.textContent = mode === 'dark' ? '☀️ Light mode' : '🌙 Dark mode';
  };
  function initTheme(){
    const saved = localStorage.getItem('theme') || 'light';
    document.body.setAttribute('data-theme', saved);
    const btn = document.getElementById('themeBtn');
    if (btn) btn.textContent = saved === 'dark' ? '☀️ Light mode' : '🌙 Dark mode';
  }

  // ---------- HEADINGS ----------
  function updateHeading(view = 'find') {
    const info = TYPE_INFO[currentType] || { name: 'Places', emoji: '📍' };
    const titleEl = document.getElementById('title');
    const subEl   = document.getElementById('subtitle');

    if (titleEl) titleEl.textContent =
      view === 'saved' ? `${info.emoji} Saved ${info.name}` : `${info.emoji} ${info.name} near you`;

    if (subEl) subEl.textContent =
      view === 'saved'
        ? `Your favorites in ${info.name.toLowerCase()}.`
        : `Find and save the best ${info.name.toLowerCase()} nearby.`;

    document.title = (view === 'saved')
      ? `Saved ${info.name} • Cafe Curator`
      : `${info.name} near you • Cafe Curator`;
  }

  // ---------- VIEW BUTTON STATES ----------
  function setActive(mode){
    const findBtn  = document.getElementById('findBtn');
    const savedBtn = document.getElementById('savedBtn');
    if(!findBtn || !savedBtn) return;
    if(mode === 'saved'){
      savedBtn.setAttribute('aria-pressed','true');
      findBtn.setAttribute('aria-pressed','false');
    }else{
      findBtn.setAttribute('aria-pressed','true');
      savedBtn.setAttribute('aria-pressed','false');
    }
    localStorage.setItem('viewMode', mode);
  }

  // ---------- GEO + SEARCH ----------
  window.getLocation = function getLocation() {
    setActive('find');
    updateHeading('find');

    // prevent rapid re-clicks
    if (inFlight || Date.now() - lastRequestAt < REQUEST_GAP_MS) return;

    const cache = JSON.parse(localStorage.getItem('cachedLocation') || '{}');
    const now = Date.now();

    if (cache.timestamp && now - cache.timestamp < CACHE_MINUTES * 60 * 1000) {
      useLocation(cache.lat, cache.lng);
      return;
    }

    if (!navigator.geolocation) return alert('Geolocation not supported by this browser.');

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        localStorage.setItem('cachedLocation', JSON.stringify({ lat, lng, timestamp: now }));
        useLocation(lat, lng);
      },
      (err) => {
        console.error('Geolocation error:', err);
        setBusy(false); // safety
        alert('Location access denied or unavailable.');
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  };

  function ensureGoogleReady() {
    return !!(window.google && google.maps && google.maps.places);
  }

  // Result cache helpers
  const cacheKey = (lat, lng, type) => {
    const rLat = lat.toFixed(3); // ~110m precision bucket
    const rLng = lng.toFixed(3);
    return `nearby:${type}:${rLat},${rLng}`;
  };
  function getCachedResults(key){
    const c = JSON.parse(localStorage.getItem(key) || '{}');
    if (c.ts && Date.now() - c.ts < RESULT_TTL) return c.data;
    return null;
  }
  function setCachedResults(key, data){
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data }));
  }

  function useLocation(lat, lng) {
    if (!ensureGoogleReady()) {
      setBusy(false); // safety
      alert('Maps SDK not loaded. Ensure the script tag has libraries=places and is before app.js');
      return;
    }

    // Try results cache first (free)
    const key = cacheKey(lat, lng, currentType);
    const cached = getCachedResults(key);
    if (cached) {
      displayCards(cached);
      setBusy(false); // ensure button is enabled
      return;
    }

    // Create service once (no visible map needed)
    if (!placesService) {
      const dummyMap = new google.maps.Map(document.createElement('div'), {
        center: { lat, lng }, zoom: 14
      });
      placesService = new google.maps.places.PlacesService(dummyMap);
    }

    // Rate limit + disable button
    if (inFlight || Date.now() - lastRequestAt < REQUEST_GAP_MS) return;
    inFlight = true;
    lastRequestAt = Date.now();
    setBusy(true);

    const request = { location: { lat, lng }, radius: SEARCH_RADIUS_M, type: currentType };

    placesService.nearbySearch(request, (results, status/*, pagination*/) => {
      // always re-enable button + clear inFlight
      inFlight = false;
      setBusy(false);

      if (status !== google.maps.places.PlacesServiceStatus.OK || !results?.length) {
        renderEmpty('No places found nearby. Try another type or try again.');
        return;
      }

      const sorted = results.slice().sort((a,b) => (b.rating||0) - (a.rating||0));
      setCachedResults(key, sorted);
      displayCards(sorted);

      // Save quota: don't auto page. Uncomment if you want more results.
      // if (pagination && pagination.hasNextPage) setTimeout(() => pagination.nextPage(), 900);
    });
  }

  // Disable/enable Find with a watchdog so it never gets stuck
  function setBusy(isBusy){
    const btn = document.getElementById('findBtn');
    if (!btn) return;
    btn.disabled = isBusy;

    if (isBusy) {
      clearTimeout(window.__busyTimer);
      window.__busyTimer = setTimeout(() => {
        console.warn('[Curator] Safety reset: re-enabling Find button.');
        btn.disabled = false;
        inFlight = false;
      }, 8000);
    } else {
      clearTimeout(window.__busyTimer);
    }
  }

  // ---------- RENDER ----------
  const $ = (s) => document.querySelector(s);

  function renderEmpty(msg){
    const container = $('.cards');
    if (container) container.innerHTML = `<p class="empty">${msg}</p>`;
  }

  function displayCards(places){
    const container = $('.cards');
    if (!container) return;
    container.innerHTML = '';

    places.forEach((place, i) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'swipe-wrapper';
      wrapper.style.zIndex = 200 - i;

      const card = document.createElement('div');
      card.className = 'location-card';

      const imgUrl = place.photos?.[0]?.getUrl
        ? place.photos[0].getUrl({ maxWidth: 520 })
        : 'https://via.placeholder.com/520x300?text=No+Image';

      const rating = place.rating ?? 'N/A';
      const addr = place.vicinity ?? '';

      card.innerHTML = `
        <img src="${imgUrl}" alt="${escapeHtml(place.name)}" />
        <div class="content">
          <h3>${escapeHtml(place.name)}</h3>
          <p class="muted">${escapeHtml(addr)}</p>
          <p><span class="badge">⭐ ${rating}</span></p>
          <p class="muted"><small>Drag or swipe → to save 💖</small></p>
        </div>
      `;

      wrapper.appendChild(card);
      container.appendChild(wrapper);

      attachSwipeHandlers(wrapper, {
        onSave: () => savePlace({ name: place.name, place_id: place.place_id, photo: imgUrl, rating })
      });
    });
  }

  function escapeHtml(s){
    return String(s)
      .replaceAll('&','&amp;').replaceAll('<','&lt;')
      .replaceAll('>','&gt;').replaceAll('"','&quot;')
      .replaceAll("'",'&#039;');
  }

  // ---------- SWIPE/DRAG (Hammer) ----------
  function attachSwipeHandlers(wrapper, { onSave }) {
    const manager = new Hammer.Manager(wrapper, { touchAction: 'pan-y' });
    const pan = new Hammer.Pan({ direction: Hammer.DIRECTION_HORIZONTAL, threshold: 0 });
    const swipe = new Hammer.Swipe({ direction: Hammer.DIRECTION_HORIZONTAL, velocity: 0.25, threshold: 10 });
    manager.add([pan, swipe]);

    let currentX = 0;

    manager.on('panstart', () => { wrapper.classList.add('dragging'); });
    manager.on('panmove', (ev) => {
      currentX = ev.deltaX;
      const rot = currentX / 20;
      wrapper.style.transform = `translateX(${currentX}px) rotate(${rot}deg)`;
      wrapper.style.opacity = String(Math.max(0.2, 1 - Math.abs(currentX) / 300));
    });
    manager.on('panend', () => {
      wrapper.classList.remove('dragging');
      if (Math.abs(currentX) > 120) {
        const dir = currentX > 0 ? 1 : -1;
        if (dir > 0 && typeof onSave === 'function') onSave(); // save on right
        wrapper.style.transform = `translateX(${dir * 500}px) rotate(${dir * 15}deg)`;
        wrapper.style.opacity = '0';
        setTimeout(() => wrapper.remove(), 280);
      } else {
        wrapper.style.transform = `translateX(0) rotate(0deg)`;
        wrapper.style.opacity = '1';
      }
      currentX = 0;
    });

    manager.on('swipeleft', () => {
      wrapper.classList.remove('dragging');
      wrapper.style.transform = 'translateX(-500px) rotate(-15deg)';
      wrapper.style.opacity = '0';
      setTimeout(() => wrapper.remove(), 280);
    });
    manager.on('swiperight', () => {
      wrapper.classList.remove('dragging');
      if (typeof onSave === 'function') onSave();
      wrapper.style.transform = 'translateX(500px) rotate(15deg)';
      wrapper.style.opacity = '0';
      setTimeout(() => wrapper.remove(), 280);
    });
  }

  // ---------- SAVED (per type) ----------
  const savedKey = (type = currentType) => `saved:${type}`;

  function savePlace(place){
    const key = savedKey();
    const saved = JSON.parse(localStorage.getItem(key) || '[]');
    if (!saved.find(p => p.place_id === place.place_id)) {
      saved.push(place);
      localStorage.setItem(key, JSON.stringify(saved));
      alert(`${place.name} saved to ${currentType}!`);
    } else {
      alert(`${place.name} is already saved in ${currentType}.`);
    }
  }

  window.showSaved = function showSaved(){
    setActive('saved');
    updateHeading('saved');

    const container = $('.cards');
    if (!container) return;

    const saved = JSON.parse(localStorage.getItem(savedKey()) || '[]');
    if (!saved.length) {
      container.innerHTML = `<p class="empty">No saved ${TYPE_INFO[currentType]?.name.toLowerCase() || 'places'} yet 😢</p>`;
      return;
    }

    container.innerHTML = '';
    saved.forEach((place, i) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'swipe-wrapper';
      wrapper.style.zIndex = 200 - i;

      const card = document.createElement('div');
      card.className = 'location-card';
      card.innerHTML = `
        <img src="${place.photo}" alt="${escapeHtml(place.name)}" />
        <div class="content">
          <h3>${escapeHtml(place.name)}</h3>
          <p><span class="badge">⭐ ${place.rating}</span></p>
          <p class="muted"><small>Drag left to remove from Saved</small></p>
        </div>
      `;

      wrapper.appendChild(card);
      container.appendChild(wrapper);

      // Remove from this type’s saved list on left fling
      const mgr = new Hammer.Manager(wrapper, { touchAction: 'pan-y' });
      mgr.add(new Hammer.Swipe({ direction: Hammer.DIRECTION_HORIZONTAL }));
      mgr.on('swipeleft', () => {
        let arr = JSON.parse(localStorage.getItem(savedKey()) || '[]');
        arr = arr.filter(p => p.place_id !== place.place_id);
        localStorage.setItem(savedKey(), JSON.stringify(arr));
        wrapper.style.transform = 'translateX(-500px) rotate(-15deg)';
        wrapper.style.opacity = '0';
        setTimeout(() => wrapper.remove(), 280);
      });

      // Add nice drag behavior (no right-save here)
      attachSwipeHandlers(wrapper, { onSave: null });
    });
  };
})();
