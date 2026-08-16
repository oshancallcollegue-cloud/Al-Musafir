import { calculateQuote, validateAnonymousTripFacts } from "./pricing-engine.js";
import { maxCitiesForDays, buildNearestNeighbourRoute } from "./routing-engine.js";

export const LOCAL_RATE_VERSION = "dynamic-admin-rates";

const PACE_WEIGHT = Object.freeze({ relaxed: 0, moderate: 1, active: 2 });

function extractRates(rules, facts) {
  if (!rules) throw new Error("Expert System Rules are missing from the database.");
  
  const mealPlanKey = {
    breakfast: 'mealBreakfast',
    halfBoard: 'mealHalfBoard',
    fullBoard: 'mealFullBoard',
    allInclusive: 'mealAllInclusive'
  }[facts.mealPlan || 'halfBoard'] || 'mealHalfBoard';
  
  const tierKey = {
    standard: 'tierStandard',
    boutique: 'tierBoutique',
    fiveStar: 'tierFiveStar',
    deluxe: 'tierDeluxe',
    villa: 'tierVilla'
  }[facts.accommodationTier || 'fiveStar'] || 'tierFiveStar';

  const requireRate = (key, label) => {
    const val = Number(rules[key]);
    if (!Number.isFinite(val)) throw new Error(`Missing Expert System Rule: ${label} (${key})`);
    return val;
  };

  return {
    currency: "LKR",
    transportPerKmMinor: requireRate('transportPerKm', 'Transport Rate'),
    hotelPerRoomNightMinor: requireRate(tierKey, 'Hotel Tier Rate'),
    mealPerAdultDayMinor: requireRate(mealPlanKey, 'Meal Plan Rate'),
    mealPerChildDayMinor: Math.round(requireRate(mealPlanKey, 'Meal Plan Rate') / 2),
    guidePerDayMinor: requireRate('guidePerDay', 'Guide Fee'),
    activityPerPersonMinor: requireRate('activityPerPerson', 'Activity Allowance'),
    markupBps: Math.round(requireRate('markupPercent', 'Agency Markup') * 100),
    taxBps: 0,
  };
}

function scoreDestination(destination, interests, pace, excursionIds, excursionNames = []) {
  const destTags = (destination.tags || []).map(t => t.toLowerCase());
  const matchingInterests = interests.filter(i => destTags.includes(i)).length;
  const natureBonus = interests.includes("nature") && destTags.includes("mountains") ? 0.5 : 0;
  const paceBonus = PACE_WEIGHT[pace] === 2 && destTags.includes("adventure") ? 0.2 : 0;
  
  const destNameLower = (destination.title || destination.name || "").toLowerCase();
  const userSelectedBonus = (excursionIds.includes(destination.id) || excursionNames.includes(destNameLower)) ? 1000 : 0;
  
  return matchingInterests * 10 + natureBonus + paceBonus + userSelectedBonus;
}

function destinationOutput(destination) {
  return {
    id: destination.id,
    title: destination.title || destination.name,
    latitude: destination.lat || destination.latitude,
    longitude: destination.lng || destination.longitude,
  };
}

function buildSelection(facts, destinations, rules = {}) {
  const getDestination = (id) => destinations.find((d) => d.id === id);
  const getByAirport = (code) => destinations.find((d) => d.airportCode === code || d.id === code || (d.title && d.title.toLowerCase() === code) || (d.name && d.name.toLowerCase() === code)) || getDestination(code);
  
  const arrivalId = facts.arrivalHubId?.toLowerCase();
  const departureId = facts.departureHubId?.toLowerCase();
  
  let arrival = getByAirport(arrivalId);
  let departure = getByAirport(departureId);
  
  // Fallback gracefully if hubs aren't in expertCities
  if (!arrival) arrival = destinations[0];
  if (!departure) departure = destinations[0];
  
  if (!arrival || !departure) throw new RangeError("No expert cities available.");

  const defaultInterestsRaw = rules.defaultInterests || "nature, culture, beach";
  const defaultInterests = defaultInterestsRaw.split(',').map(s => s.trim().toLowerCase());
  const interests = facts.interests?.length ? facts.interests : defaultInterests;
  
  const safeExcursionIds = Array.isArray(facts.excursionIds) ? facts.excursionIds : [];
  const safeExcursionNames = Array.isArray(facts.excursionNames) ? facts.excursionNames.map(n => typeof n === 'string' ? n.toLowerCase() : "") : [];
  
  const candidates = destinations
    .filter((destination) => destination.id !== arrival.id && destination.id !== departure.id)
    .map((destination) => ({
      destination,
      score: scoreDestination(destination, interests, facts.pace, safeExcursionIds, safeExcursionNames),
    }))
    .sort((left, right) => right.score - left.score || (left.destination.title || "").localeCompare(right.destination.title || ""));

  let preferredNames = candidates.map(({ destination }) => destination.title || destination.name);
  
  // If the user manually checked any cities, strictly only route through those (do not auto-fill with Bentota etc)
  if (facts.excursionNames && facts.excursionNames.length > 0) {
    preferredNames = facts.excursionNames;
  }
  
  // Ensure destinations array has `name` mapped to `title` for NearestNeighbour logic
  const normalizedDestinations = destinations.map(d => ({ ...d, name: d.title || d.name, latitude: d.lat || d.latitude, longitude: d.lng || d.longitude }));
  
  const nearest = buildNearestNeighbourRoute({
    destinations: normalizedDestinations,
    preferredNames,
    startName: arrival.title || arrival.name,
    days: facts.days,
    rules: rules || {},
    maxKmPerDay: Number(rules.maxKmPerDay) || 300,
  });
  
  const selected = nearest.route.map(({ name }) => normalizedDestinations.find((d) => d.name === name));
  const stops = selected.filter(Boolean);
  if (stops.length > 0 && stops[stops.length - 1].id !== departure.id) {
    stops.push(normalizedDestinations.find(d => d.id === departure.id));
  } else if (stops.length === 0) {
    stops.push(arrival, departure);
  }
  // A route needs at least two points. When the traveller picks a single city
  // (e.g. a 3-night, 1-city trip) the nearest-neighbour route can collapse to a
  // single stop. Guarantee an origin AND destination so calculateRoute() never
  // fails with "at least an origin and destination are required".
  if (stops.length === 1) {
    const only = stops[0];
    const end = (departure && departure.id !== only.id)
      ? normalizedDestinations.find(d => d.id === departure.id)
      : (arrival && arrival.id !== only.id
          ? normalizedDestinations.find(d => d.id === arrival.id)
          : only);
    stops.push(end || only);   // duplicate the single stop as a last resort (distance 0)
  }
  return { arrival, departure, stops, candidates, unvisitedNames: nearest.unvisitedNames };
}

function buildLineItems(facts, route, stops, rates) {
  const travellers = facts.adults + facts.children;
  const vehicles = Math.max(1, Math.ceil(travellers / 4));
  const nights = Math.max(0, facts.days - 1);
  const rooms = Math.max(1, Math.ceil(travellers / 2));
  const activityStops = Math.max(0, stops.length - 1);
  return [
    {
      id: "transport",
      label: `Private transport (${vehicles} vehicle${vehicles === 1 ? "" : "s"})`,
      quantity: route.distanceKm * vehicles,
      unitMinor: rates.transportPerKmMinor,
      currency: rates.currency,
    },
    {
      id: "accommodation",
      label: `${facts.accommodationTier ?? "comfort"} accommodation`,
      quantity: rooms * nights,
      unitMinor: rates.hotelPerRoomNightMinor,
      currency: rates.currency,
    },
    {
      id: "meals",
      label: `${facts.mealPlan ?? "half-board"} meals`,
      quantity: facts.adults * facts.days,
      unitMinor: rates.mealPerAdultDayMinor,
      currency: rates.currency,
    },
    {
      id: "child-meals",
      label: "Child meal allowance",
      quantity: facts.children * facts.days,
      unitMinor: rates.mealPerChildDayMinor,
      currency: rates.currency,
    },
    {
      id: "guide",
      label: "English-speaking guide/driver service",
      quantity: facts.days,
      unitMinor: rates.guidePerDayMinor,
      currency: rates.currency,
    },
    {
      id: "activities",
      label: "Destination activities and entry allowance",
      quantity: activityStops * travellers,
      unitMinor: rates.activityPerPersonMinor,
      currency: rates.currency,
    },
  ].filter((item) => item.quantity > 0);
}

export function buildQuotePreview({ tripFacts, route, destinations, rules }) {
  const facts = validateAnonymousTripFacts(tripFacts, rules);
  const selection = buildSelection(facts, destinations, rules);
  const rates = extractRates(rules, facts);
  const lineItems = buildLineItems(facts, route, selection.stops, rates);
  
  const quote = calculateQuote({
    tripFacts: facts,
    route,
    lineItems,
    currency: rates.currency,
    rateVersionId: LOCAL_RATE_VERSION,
    markupBps: rates.markupBps,
    taxBps: rates.taxBps,
    allowNonBookableRoute: true, // Allow OSRM or straight-line local routing
    rules,
  });

  return {
    ok: true,
    bookable: route.bookable !== false,
    estimateMode: "osrm-dynamic",
    currency: quote.currency,
    totalMinor: quote.totalMinor,
    perPersonMinor: quote.perPersonMinor,
    travellers: quote.travellers,
    budgetComparison: quote.budgetComparison,
    route: {
      provider: route.provider,
      distanceKm: route.distanceKm,
      durationMinutes: route.durationMinutes,
      encodedPolyline: route.encodedPolyline ?? null,
      stops: selection.stops.map(destinationOutput),
    },
    itinerary: selection.stops.map((destination, index) => ({
      day: Math.min(index + 1, facts.days),
      destinationId: destination.id,
      title: destination.title || destination.name,
      durationMinutes: destination.durationMinutes || 0,
      highlights: destination.activities || [],
    })),
    lineItems: quote.lineItems.map(({ id, label, totalMinor }) => ({ id, label, totalMinor })),
    warnings: [
      route.bookable === false ? "Using straight-line estimation fallback. Live routing may be unavailable." : "",
      "DEBUG: excursionIds = " + JSON.stringify(facts.excursionIds),
      "DEBUG: preferredNames = " + JSON.stringify(facts.excursionNames),
      "DEBUG: topPreferred = " + JSON.stringify(selection.stops.map(d => d.title || d.name))
    ].filter(Boolean),
    unvisitedDestinationNames: selection.unvisitedNames,
  };
}

export function selectRouteStops(tripFacts, destinations, rules) {
  const facts = validateAnonymousTripFacts(tripFacts, rules);
  return buildSelection(facts, destinations, rules).stops;
}

