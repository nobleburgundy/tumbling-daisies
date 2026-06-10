// --- Mobile menu ---
(function () {
  var toggle = document.getElementById('nav-toggle');
  var links = document.getElementById('nav-links');
  toggle.addEventListener('click', function () {
    links.classList.toggle('open');
  });
  links.querySelectorAll('a').forEach(function (a) {
    a.addEventListener('click', function () {
      links.classList.remove('open');
    });
  });
})();

// --- Shows from gigs.json ---
(function () {
  var container = document.getElementById('shows-list');
  if (!container) return;

  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function formatTime(isoString) {
    var d = new Date(isoString);
    var h = d.getHours();
    var m = d.getMinutes();
    var ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return h + (m ? ':' + (m < 10 ? '0' : '') + m : '') + ' ' + ampm;
  }

  function renderGig(gig) {
    var d = new Date(gig.date);
    var month = MONTHS[d.getMonth()];
    var day = String(d.getDate()).padStart(2, '0');
    var title = gig.title || '';
    var timeStr = gig.startTime ? formatTime(gig.startTime) : '';

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

    return div;
  }

  fetch('gigs.json')
    .then(function (res) { return res.json(); })
    .then(function (data) {
      var now = new Date();
      now.setHours(0, 0, 0, 0);
      var upcoming = (data.gigs || []).filter(function (g) {
        return new Date(g.date) >= now && g.status !== 'hold';
      });

      container.innerHTML = '';
      if (upcoming.length === 0) {
        container.innerHTML = '<p class="shows-empty">No upcoming shows — check back soon!</p>';
        return;
      }
      upcoming.forEach(function (gig) {
        container.appendChild(renderGig(gig));
      });
    })
    .catch(function () {
      container.innerHTML = '<p class="shows-empty">Could not load shows.</p>';
    });
})();
