import { haversineKm } from "./routing-engine.js";

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite`);
  return number;
}

function fixtureRoute(points) {
  const legs = points.slice(1).map((point, index) => haversineKm(points[index], point));
  const distanceKm = legs.reduce((sum, distance) => sum + distance, 0) * 1.35;
  return {
    provider: "local-fixture",
    verified: true,
    bookable: false,
    distanceKm: Math.round(distanceKm * 100) / 100,
    durationMinutes: Math.max(1, Math.round(distanceKm / 35 * 60)),
    legsKm: legs.map((distance) => Math.round(distance * 1.35 * 100) / 100),
    encodedPolyline: null,
  };
}

async function osrmRoute(points, fetchImpl) {
  // Validate points
  points.forEach((p, i) => {
    finite(p.latitude, `point[${i}].latitude`);
    finite(p.longitude, `point[${i}].longitude`);
  });

  // OSRM coordinates format: {longitude},{latitude};{longitude},{latitude}
  const coords = points.map(p => `${p.longitude},${p.latitude}`).join(';');
  const url = `http://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=polyline`;
  
  const response = await fetchImpl(url);
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OSRM API returned ${response.status}: ${detail.slice(0, 300)}`);
  }
  const body = await response.json();
  const route = body.routes?.[0];
  if (!route || !Number.isFinite(route.distance)) {
    throw new Error("OSRM returned no usable route");
  }
  return {
    provider: "osrm",
    verified: true,
    bookable: true,
    distanceKm: Math.round(route.distance / 10) / 100, // route.distance is in meters
    durationMinutes: Math.max(1, Math.round(route.duration / 60)), // route.duration is in seconds
    legsKm: (route.legs || []).map(leg => Math.round(leg.distance / 10) / 100),
    encodedPolyline: route.geometry ?? null,
  };
}

export async function calculateRoute(points, {
  allowLocalFixture = process.env.FUNCTIONS_EMULATOR === "true" || process.env.ALLOW_LOCAL_ROUTE_FIXTURE === "true",
  fetchImpl = fetch,
} = {}) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new TypeError("at least an origin and destination are required");
  }
  try {
    return await osrmRoute(points, fetchImpl);
  } catch (error) {
    if (allowLocalFixture) {
      console.warn("OSRM API call failed, falling back to local route fixture:", error.message);
      return fixtureRoute(points);
    }
    throw error;
  }
}

