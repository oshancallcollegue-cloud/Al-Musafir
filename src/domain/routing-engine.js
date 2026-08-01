const EARTH_RADIUS_KM = 6371;

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return number;
}

function positiveInteger(value, label) {
  const number = finiteNumber(value, label);
  if (!Number.isInteger(number) || number < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return number;
}

function coordinates(destination) {
  if (!destination || typeof destination !== "object") {
    throw new TypeError("destination must be an object");
  }

  const latitude = finiteNumber(destination.latitude, "latitude");
  const longitude = finiteNumber(destination.longitude, "longitude");

  if (latitude < -90 || latitude > 90) {
    throw new RangeError("latitude must be between -90 and 90");
  }
  if (longitude < -180 || longitude > 180) {
    throw new RangeError("longitude must be between -180 and 180");
  }

  return { latitude, longitude };
}

/** Great-circle distance used for fast itinerary ordering, not final road pricing. */
export function haversineKm(from, to) {
  const a = coordinates(from);
  const b = coordinates(to);
  const toRadians = (degrees) => degrees * Math.PI / 180;
  const deltaLatitude = toRadians(b.latitude - a.latitude);
  const deltaLongitude = toRadians(b.longitude - a.longitude);
  const fromLatitude = toRadians(a.latitude);
  const toLatitude = toRadians(b.latitude);

  const haversine =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(fromLatitude) * Math.cos(toLatitude) *
    Math.sin(deltaLongitude / 2) ** 2;
  const angularDistance = 2 * Math.atan2(
    Math.sqrt(haversine),
    Math.sqrt(1 - haversine),
  );

  return EARTH_RADIUS_KM * angularDistance;
}

/** Business rule supplied in the expert-system documentation.
 *  City limits are now admin-defined as dynamic (days -> cities) pairs in
 *  `rules.cityLimits`. For a given trip length we use the smallest tier whose
 *  `days` is >= the trip days; if the trip is longer than every tier, we use
 *  the largest tier. Falls back to the legacy maxCitiesN Days fields when no
 *  dynamic pairs are present, so older saved settings keep working. */
export function maxCitiesForDays(days, rules) {
  if (!rules) throw new Error("Expert System Rules are missing for city limits.");
  const tripDays = positiveInteger(days, "days");

  const limits = Array.isArray(rules.cityLimits)
    ? rules.cityLimits
        .map((p) => ({ days: Number(p.days), cities: Number(p.cities) }))
        .filter((p) => Number.isFinite(p.days) && p.days > 0 && Number.isFinite(p.cities) && p.cities >= 0)
        .sort((a, b) => a.days - b.days)
    : [];

  if (limits.length) {
    const match = limits.find((p) => tripDays <= p.days);
    return (match || limits[limits.length - 1]).cities;
  }

  // Legacy fallback (fixed 3/5/7/10 tiers).
  const getLimit = (key) => {
    const val = Number(rules[key]);
    if (!Number.isFinite(val)) throw new Error(`Missing Expert System Rule: ${key}`);
    return val;
  };
  if (tripDays <= 3) return getLimit('maxCities3Days');
  if (tripDays <= 5) return getLimit('maxCities5Days');
  if (tripDays <= 7) return getLimit('maxCities7Days');
  if (tripDays <= 10) return getLimit('maxCities10Days');
  return Math.min(tripDays - 3, getLimit('maxTripDays'));
}

/**
 * Deterministic nearest-neighbour ordering. It intentionally returns a partial
 * route when constraints cannot be met; presentation code must never insert
 * random destinations into a customer quotation.
 */
export function buildNearestNeighbourRoute({
  destinations,
  preferredNames,
  startName,
  days,
  rules = {},
  maxKmPerDay = 250,
}) {
  if (!Array.isArray(destinations) || !Array.isArray(preferredNames)) {
    throw new TypeError("destinations and preferredNames must be arrays");
  }

  const tripDays = positiveInteger(days, "days");
  const distanceBudget = finiteNumber(maxKmPerDay, "maxKmPerDay") * tripDays;
  if (distanceBudget <= 0) {
    throw new RangeError("maxKmPerDay must be greater than zero");
  }

  const byName = new Map(destinations.map((destination) => {
    coordinates(destination);
    if (!destination.name) throw new TypeError("each destination needs a name");
    return [destination.name, destination];
  }));
  const start = byName.get(startName);
  if (!start) throw new RangeError(`unknown start destination: ${startName}`);

  const maximumCities = maxCitiesForDays(tripDays, rules);
  const maxDestinations = Math.max(0, maximumCities);
  
  const validPreferredNames = preferredNames.filter(
    (name) => name !== startName && byName.has(name)
  );
  
  const topPreferred = validPreferredNames.slice(0, maxDestinations);
  const remainingToVisit = new Set(topPreferred);

  const route = [{ ...start, legDistanceKm: 0 }];
  let current = start;
  let totalDistanceKm = 0;

  while (remainingToVisit.size > 0 && route.length < maximumCities + 1) {
    const candidates = [...remainingToVisit]
      .map((name) => {
        const destination = byName.get(name);
        return {
          destination,
          distanceKm: haversineKm(current, destination),
        };
      })
      .sort((left, right) =>
        left.distanceKm - right.distanceKm ||
        left.destination.name.localeCompare(right.destination.name));

    const next = candidates.find(
      ({ distanceKm }) => totalDistanceKm + distanceKm <= distanceBudget,
    );
    if (!next) break;

    route.push({ ...next.destination, legDistanceKm: next.distanceKm });
    remainingToVisit.delete(next.destination.name);
    current = next.destination;
    totalDistanceKm += next.distanceKm;
  }

  const visitedNames = new Set(route.map(d => d.name));
  const unvisitedNames = validPreferredNames.filter(name => !visitedNames.has(name));

  return { route, totalDistanceKm, unvisitedNames };
}
