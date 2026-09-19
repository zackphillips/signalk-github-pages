// Tab bar wiring for the S.V. Mermug tracker.
//
// Owns switching between the five top-level tabs (map / voyages /
// environment / data / polars). Deliberately kept separate from app.js:
// it only touches DOM visibility and layout-refresh glue, never the data
// pipeline. Panels are never removed from the DOM — only shown/hidden via
// a `.active` class — so every existing render function in app.js keeps
// targeting the same element IDs regardless of which tab is open.
(function () {
  var TAB_IDS = ['map', 'voyages', 'environment', 'data', 'polars'];
  var DEFAULT_TAB = 'map';
  var STORAGE_KEY = 'mermug-active-tab';

  var tabBar = document.getElementById('tab-bar');
  var panels = document.querySelectorAll('.tab-panel');
  var buttons = document.querySelectorAll('.tab-btn');

  function isValidTab(id) {
    return TAB_IDS.indexOf(id) !== -1;
  }

  function tabFromHash() {
    var id = (window.location.hash || '').replace(/^#/, '');
    return isValidTab(id) ? id : null;
  }

  function tabFromStorage() {
    try {
      var id = localStorage.getItem(STORAGE_KEY);
      return isValidTab(id) ? id : null;
    } catch (e) {
      return null;
    }
  }

  function activateTab(tabId, opts) {
    if (!isValidTab(tabId)) tabId = DEFAULT_TAB;
    opts = opts || {};

    panels.forEach(function (panel) {
      var active = panel.dataset.tabPanel === tabId;
      panel.classList.toggle('active', active);
    });

    buttons.forEach(function (btn) {
      var active = btn.dataset.tab === tabId;
      btn.classList.toggle('active', active);
      if (active) {
        btn.setAttribute('aria-current', 'page');
      } else {
        btn.removeAttribute('aria-current');
      }
    });

    // The map tab is full-bleed: the container stretches to the viewport and
    // the footer steps aside so #map can claim every remaining pixel.
    document.body.classList.toggle('map-fills', tabId === 'map');

    try { localStorage.setItem(STORAGE_KEY, tabId); } catch (e) {}

    if (opts.updateHash !== false && window.location.hash !== '#' + tabId) {
      history.replaceState(null, '', '#' + tabId);
    }

    // Leaflet and Chart.js both miscalculate size for anything drawn while
    // their container was `display:none`. Fix up on every switch instead
    // of touching every chart-creation call site in app.js.
    if (tabId === 'map' && window.mermugMap) {
      // Let the display:block + .map-fills reflow land before measuring.
      requestAnimationFrame(function () { window.mermugMap.invalidateSize(); });
    }
    window.dispatchEvent(new Event('resize'));
  }

  // app.js needs this to honour "Show on main map" from a voyage detail card.
  window.mermugActivateTab = activateTab;

  if (tabBar) {
    tabBar.addEventListener('click', function (e) {
      var btn = e.target.closest('.tab-btn');
      if (!btn) return;
      activateTab(btn.dataset.tab);
    });
  }

  window.addEventListener('hashchange', function () {
    var id = tabFromHash();
    if (id) activateTab(id, { updateHash: false });
  });

  // Voyage rows expand in place on the Voyages tab (see app.js); no cross-tab
  // navigation happens here any more.

  activateTab(tabFromHash() || tabFromStorage() || DEFAULT_TAB, { updateHash: false });
})();
