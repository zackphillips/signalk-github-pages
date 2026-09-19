(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.vesselUtils = factory();
  }
}(typeof self !== 'undefined' ? self : this, () => {
  const EARTH_RADIUS_KM = 6371;
  const DIRECTIONS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

  const toRadians = degrees => degrees * Math.PI / 180;

  function haversine(lat1, lon1, lat2, lon2) {
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRadians(lat1)) *
        Math.cos(toRadians(lat2)) *
        Math.sin(dLon / 2) ** 2;
    return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function resolveTheme(theme) {
    if (theme) {
      return theme;
    }
    if (typeof document !== 'undefined') {
      return document.documentElement.getAttribute('data-theme') || 'light';
    }
    return 'light';
  }

  function getAnchorDistanceColor(isOutsideSafeRadius, theme) {
    const activeTheme = resolveTheme(theme);
    const isDark = activeTheme === 'dark';
    if (isOutsideSafeRadius) {
      return isDark ? '#ff6b6b' : '#e74c3c';
    }
    return isDark ? '#51cf66' : '#27ae60';
  }

  function getWindDirection(degrees) {
    if (typeof degrees !== 'number' || Number.isNaN(degrees)) {
      return 'N';
    }
    const normalized = ((degrees % 360) + 360) % 360;
    const index = Math.round(normalized / 22.5) % DIRECTIONS.length;
    return DIRECTIONS[index];
  }

  return {
    haversine,
    getAnchorDistanceColor,
    getWindDirection,
  };
}));
