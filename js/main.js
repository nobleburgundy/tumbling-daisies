// ============================================
// Tumbling Daisies — main.js
// SPA-style navigation + persistent audio player
// ============================================

(function () {
  'use strict';

  // --- Persistent audio state (survives page swaps) ---
  var audio = new Audio();
  var tracks = [];
  var currentIndex = -1;
  var playerVisible = false;
  var tracksLoaded = false;

  // --- Create sticky player bar ---
  var playerBar = document.createElement('div');
  playerBar.id = 'player-bar';
  playerBar.className = 'player-bar';
  playerBar.innerHTML =
    '<div class="player-bar-inner">' +
      '<div class="player-bar-progress" id="player-bar-progress">' +
        '<div class="player-bar-progress-fill" id="player-bar-progress-fill"></div>' +
      '</div>' +
      '<div class="player-bar-row">' +
        '<span class="player-bar-title" id="player-bar-title">&mdash;</span>' +
        '<div class="player-bar-controls">' +
          '<button class="player-bar-btn" id="pb-prev" aria-label="Previous track">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>' +
          '</button>' +
          '<button class="player-bar-btn" id="pb-play" aria-label="Play">' +
            '<svg class="icon-play" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>' +
            '<svg class="icon-pause" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="display:none"><path d="M6 19h4V5H6zm8-14v14h4V5z"/></svg>' +
          '</button>' +
          '<button class="player-bar-btn" id="pb-next" aria-label="Next track">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zm10-12v12h2V6z"/></svg>' +
          '</button>' +
        '</div>' +
        '<span class="player-bar-time" id="pb-time">0:00 / 0:00</span>' +
      '</div>' +
    '</div>';
  document.body.appendChild(playerBar);

  var pbTitle = document.getElementById('player-bar-title');
  var pbPlay = document.getElementById('pb-play');
  var pbPrev = document.getElementById('pb-prev');
  var pbNext = document.getElementById('pb-next');
  var pbProgressBar = document.getElementById('player-bar-progress');
  var pbProgressFill = document.getElementById('player-bar-progress-fill');
  var pbTime = document.getElementById('pb-time');
  var pbIconPlay = pbPlay.querySelector('.icon-play');
  var pbIconPause = pbPlay.querySelector('.icon-pause');

  function formatTime(sec) {
    if (!sec || isNaN(sec)) return '0:00';
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function titleCase(str) {
    var small = ['a','an','the','and','but','or','nor','for','yet','so','at','by','in','of','on','to','up','with'];
    return str.replace(/\S+/g, function (word, i) {
      if (i === 0 || small.indexOf(word.toLowerCase()) === -1) {
        return word.charAt(0).toUpperCase() + word.slice(1);
      }
      return word.toLowerCase();
    });
  }

  function showPlayer() {
    if (!playerVisible) {
      playerBar.classList.add('visible');
      document.body.classList.add('has-player');
      playerVisible = true;
    }
  }

  function setPlaying(playing) {
    pbIconPlay.style.display = playing ? 'none' : '';
    pbIconPause.style.display = playing ? '' : 'none';
  }

  function highlightTrackInList() {
    var list = document.getElementById('tracks-list');
    if (!list) return;
    list.querySelectorAll('.track').forEach(function (el, i) {
      el.classList.toggle('is-active', i === currentIndex);
    });
  }

  function loadTrack(index, autoplay) {
    if (index < 0 || index >= tracks.length) return;
    currentIndex = index;
    var t = tracks[index];
    audio.src = t.src;
    pbTitle.textContent = t.name;
    pbProgressFill.style.width = '0%';
    pbTime.textContent = '0:00 / ' + (t.duration ? formatTime(t.duration) : '0:00');
    highlightTrackInList();
    showPlayer();
    if (autoplay) {
      audio.play();
      setPlaying(true);
    } else {
      setPlaying(false);
    }
  }

  // Load track metadata from music.json (once)
  function loadTracks() {
    if (tracksLoaded) return Promise.resolve();
    tracksLoaded = true;
    return fetch('music.json')
      .then(function (r) { return r.json(); })
      .then(function (files) {
        files.forEach(function (filename, i) {
          var src = 'assets/music/' + filename;
          var name = titleCase(filename.replace(/\.\w+$/, ''));
          var t = { src: src, name: name, duration: 0 };
          tracks.push(t);

          var probe = new Audio();
          probe.preload = 'metadata';
          probe.src = src;
          probe.addEventListener('loadedmetadata', function () {
            t.duration = probe.duration;
            // Update track list if visible
            var metaEl = document.querySelector('[data-track-index="' + i + '"] .track-meta');
            if (metaEl) metaEl.textContent = formatTime(probe.duration);
          });
        });
      });
  }

  // Build the track list in the #tracks-list element (home page)
  function renderTrackList() {
    var tracksList = document.getElementById('tracks-list');
    if (!tracksList) return;

    loadTracks().then(function () {
      tracksList.innerHTML = '';
      tracks.forEach(function (t, i) {
        var div = document.createElement('div');
        div.className = 'track';
        div.setAttribute('data-track-index', i);
        div.innerHTML =
          '<span class="track-num">' + String(i + 1).padStart(2, '0') + '</span>' +
          '<div class="track-info">' +
            '<span class="track-name">' + t.name + '</span>' +
          '</div>' +
          '<span class="track-meta">' + (t.duration ? formatTime(t.duration) : '\u2026') + '</span>' +
          '<a class="track-download" href="' + t.src + '" download aria-label="Download ' + t.name + '">' +
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
          '</a>';
        div.addEventListener('click', function (e) {
          if (e.target.closest('.track-download')) return;
          loadTrack(i, true);
        });
        tracksList.appendChild(div);
      });
      highlightTrackInList();
    }).catch(function () {
      tracksList.innerHTML = '<p class="shows-empty">Could not load tracks.</p>';
    });
  }

  // Player bar controls
  pbPlay.addEventListener('click', function () {
    if (currentIndex === -1 && tracks.length > 0) {
      loadTrack(0, true);
      return;
    }
    if (audio.paused) {
      audio.play();
      setPlaying(true);
    } else {
      audio.pause();
      setPlaying(false);
    }
  });

  pbPrev.addEventListener('click', function () {
    if (tracks.length === 0) return;
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
    } else {
      loadTrack((currentIndex - 1 + tracks.length) % tracks.length, !audio.paused);
    }
  });

  pbNext.addEventListener('click', function () {
    if (tracks.length === 0) return;
    loadTrack((currentIndex + 1) % tracks.length, !audio.paused);
  });

  audio.addEventListener('timeupdate', function () {
    if (!audio.duration) return;
    var pct = (audio.currentTime / audio.duration) * 100;
    pbProgressFill.style.width = pct + '%';
    pbTime.textContent = formatTime(audio.currentTime) + ' / ' + formatTime(audio.duration);
  });

  audio.addEventListener('loadedmetadata', function () {
    pbTime.textContent = formatTime(audio.currentTime) + ' / ' + formatTime(audio.duration);
  });

  audio.addEventListener('ended', function () {
    if (currentIndex < tracks.length - 1) {
      loadTrack(currentIndex + 1, true);
    } else {
      setPlaying(false);
      pbProgressFill.style.width = '0%';
    }
  });

  pbProgressBar.addEventListener('click', function (e) {
    if (!audio.duration) return;
    var rect = pbProgressBar.getBoundingClientRect();
    var pct = (e.clientX - rect.left) / rect.width;
    audio.currentTime = pct * audio.duration;
  });

  // --- Shows from gigs.json ---
  function initShows() {
    var container = document.getElementById('shows-list');
    if (!container) return;

    var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    function fmtTime(isoString) {
      var d = new Date(isoString);
      var h = d.getHours();
      var m = d.getMinutes();
      var ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      return h + (m ? ':' + (m < 10 ? '0' : '') + m : '') + ' ' + ampm;
    }

    fetch('gigs.json')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var now = new Date();
        var todayStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
        var upcoming = (data.gigs || []).filter(function (g) {
          return g.date >= todayStr && g.status === 'confirmed';
        });

        container.innerHTML = '';
        if (upcoming.length === 0) {
          container.innerHTML = '<p class="shows-empty">No upcoming shows — check back soon!</p>';
          return;
        }
        upcoming.forEach(function (gig) {
          var d = new Date(gig.date);
          var month = MONTHS[d.getUTCMonth()];
          var day = String(d.getUTCDate()).padStart(2, '0');
          var title = gig.title || '';
          var timeStr = gig.startTime ? fmtTime(gig.startTime) : '';

          var div = document.createElement('div');
          div.className = 'show-item';
          div.innerHTML =
            '<div class="show-date">' +
              '<span class="show-month">' + month + '</span>' +
              '<span class="show-day">' + day + '</span>' +
            '</div>' +
            '<div class="show-info">' +
              '<span class="show-title">' + title + '</span>' +
              (timeStr ? '<span class="show-detail">' + timeStr + '</span>' : '') +
            '</div>';
          container.appendChild(div);
        });
      })
      .catch(function () {
        container.innerHTML = '<p class="shows-empty">Could not load shows.</p>';
      });
  }

  // --- Press kit photo gallery ---
  function initGallery() {
    var gallery = document.getElementById('photo-gallery');
    if (!gallery) return;

    var downloadSvg = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';

    fetch('press-photos.json')
      .then(function (r) { return r.json(); })
      .then(function (photos) {
        gallery.innerHTML = '';
        photos.forEach(function (filename) {
          var originalPath = 'assets/' + filename;
          var thumbName = filename.replace(/\.\w+$/, '') + '.jpg';
          var thumbPath = 'assets/press-thumbs/' + thumbName;
          var label = filename
            .replace(/^press-\d+-/, '')
            .replace(/\.\w+$/, '')
            .replace(/[-_]/g, ' ');
          label = label.charAt(0).toUpperCase() + label.slice(1);

          var div = document.createElement('div');
          div.className = 'photo-item photo-half';

          var img = document.createElement('img');
          img.src = thumbPath;
          img.alt = label;
          img.loading = 'lazy';

          var a = document.createElement('a');
          a.href = originalPath;
          a.download = '';
          a.className = 'photo-download';
          a.setAttribute('aria-label', 'Download full resolution photo');
          a.innerHTML = downloadSvg;

          div.appendChild(img);
          div.appendChild(a);
          gallery.appendChild(div);
        });
      })
      .catch(function () {
        gallery.innerHTML = '<p class="shows-empty">Unable to load photos.</p>';
      });
  }

  // --- Mobile menu ---
  function initMobileMenu() {
    var toggle = document.getElementById('nav-toggle');
    var links = document.getElementById('nav-links');
    if (!toggle || !links) return;
    toggle.addEventListener('click', function () {
      links.classList.toggle('open');
    });
    links.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () {
        links.classList.remove('open');
      });
    });
  }

  // --- SPA navigation ---
  function isInternalLink(a) {
    if (!a || !a.href) return false;
    if (a.target === '_blank') return false;
    if (a.hasAttribute('download')) return false;
    var url;
    try { url = new URL(a.href, location.origin); } catch (e) { return false; }
    if (url.origin !== location.origin) return false;
    // Only handle .html pages and root
    var path = url.pathname;
    if (path === '/' || path.endsWith('.html') || path.endsWith('/')) return true;
    return false;
  }

  function navigateTo(href, pushState) {
    var url = new URL(href, location.origin);

    return fetch(url.pathname)
      .then(function (res) { return res.text(); })
      .then(function (html) {
        var parser = new DOMParser();
        var doc = parser.parseFromString(html, 'text/html');
        var newContent = doc.getElementById('page-content');
        var oldContent = document.getElementById('page-content');

        if (newContent && oldContent) {
          oldContent.innerHTML = newContent.innerHTML;
        }

        // Update title
        var newTitle = doc.querySelector('title');
        if (newTitle) document.title = newTitle.textContent;

        if (pushState) {
          history.pushState(null, '', url.pathname + url.hash);
        }

        // Re-init page features
        initPage();

        // Scroll to hash or top
        if (url.hash) {
          var target = document.querySelector(url.hash);
          if (target) {
            target.scrollIntoView({ behavior: 'smooth' });
            return;
          }
        }
        window.scrollTo(0, 0);
      });
  }

  // Intercept clicks
  document.addEventListener('click', function (e) {
    var a = e.target.closest('a');
    if (!a) return;
    if (!isInternalLink(a)) return;

    var url = new URL(a.href, location.origin);

    // Hash-only links on the same page — let the browser handle scroll
    if (url.pathname === location.pathname && url.hash) return;

    e.preventDefault();
    navigateTo(a.href, true);
  });

  // Handle back/forward
  window.addEventListener('popstate', function () {
    navigateTo(location.href, false);
  });

  // --- Init page-specific features ---
  function initPage() {
    initMobileMenu();
    initShows();
    renderTrackList();
    initGallery();
  }

  // First load
  initPage();
})();
