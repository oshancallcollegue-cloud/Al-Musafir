const BASIS_VALUES = new Set(["perPerson", "total"]);
const FORBIDDEN_PUBLIC_FIELDS = new Set([
  "name",
  "fullName",
  "email",
  "phone",
  "telephone",
  "whatsapp",
  "whatsappNumber",
  "passport",
  "passportNumber",
  "nationality",
  "nic",
  "address",
  "dateOfBirth",
  "accountId",
  "userId",
]);

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

function nonNegativeInteger(value, label) {
  const number = finiteNumber(value, label);
  if (!Number.isInteger(number) || number < 0) {
    throw new RangeError(`${label} must be a non-negative integer`);
  }
  return number;
}

function basisPoints(value, label) {
  const number = nonNegativeInteger(value, label);
  if (number > 100_000) {
    throw new RangeError(`${label} must be at most 100000 basis points`);
  }
  return number;
}

function currencyCode(value, label = "currency") {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) {
    throw new TypeError(`${label} must be a three-letter uppercase currency code`);
  }
  return value;
}

function walkKeys(value, path = "tripFacts") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_PUBLIC_FIELDS.has(key)) {
      throw new TypeError(`${path}.${key} is not accepted by the anonymous planner`);
    }
    if (child && typeof child === "object") walkKeys(child, `${path}.${key}`);
  }
}

/** Validate the public, identity-free planner contract before pricing. */
export function validateAnonymousTripFacts(tripFacts, rules = {}) {
  if (!tripFacts || typeof tripFacts !== "object" || Array.isArray(tripFacts)) {
    throw new TypeError("tripFacts must be an object");
  }
  walkKeys(tripFacts);

  const allowedKeys = new Set([
    "days",
    "adults",
    "children",
    "childAgeBands",
    "budget",
    "interests",
    "pace",
    "accommodationTier",
    "mealPlan",
    "excursionIds",
    "excursionNames",
    "arrivalHubId",
    "departureHubId",
  ]);
  for (const key of Object.keys(tripFacts)) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(`tripFacts.${key} is not an accepted planner field`);
    }
  }

  const days = positiveInteger(tripFacts.days, "tripFacts.days");
  const maxTripDays = Number(rules?.maxTripDays);
  if (!Number.isFinite(maxTripDays)) {
    throw new Error("Missing Expert System Rule: maxTripDays");
  }
  if (days > maxTripDays) {
    throw new RangeError(`tripFacts.days must be at most ${maxTripDays}`);
  }
  const adults = positiveInteger(tripFacts.adults, "tripFacts.adults");
  const children = nonNegativeInteger(tripFacts.children ?? 0, "tripFacts.children");

  for (const key of ["interests", "excursionIds", "excursionNames"]) {
    if (tripFacts[key] !== undefined) {
      if (!Array.isArray(tripFacts[key]) || tripFacts[key].some((value) => typeof value !== "string" || value.length === 0 || value.length > 80)) {
        throw new TypeError(`tripFacts.${key} must be an array of short strings`);
      }
    }
  }

  if (tripFacts.childAgeBands !== undefined) {
    if (!Array.isArray(tripFacts.childAgeBands) || tripFacts.childAgeBands.length !== children) {
      throw new RangeError("tripFacts.childAgeBands must match the child count");
    }
    if (tripFacts.childAgeBands.some((band) => typeof band !== "string" || band.length > 24)) {
      throw new TypeError("tripFacts.childAgeBands contains an invalid age band");
    }
  }

  let budget;
  if (tripFacts.budget !== undefined) {
    if (!tripFacts.budget || typeof tripFacts.budget !== "object") {
      throw new TypeError("tripFacts.budget must be an object");
    }
    const amountMinor = nonNegativeInteger(
      tripFacts.budget.amountMinor,
      "tripFacts.budget.amountMinor",
    );
    const basis = tripFacts.budget.basis;
    if (!BASIS_VALUES.has(basis)) {
      throw new TypeError("tripFacts.budget.basis must be perPerson or total");
    }
    budget = {
      amountMinor,
      basis,
      currency: currencyCode(tripFacts.budget.currency, "tripFacts.budget.currency"),
    };
  }

  return {
    days,
    adults,
    children,
    ...(tripFacts.childAgeBands ? { childAgeBands: [...tripFacts.childAgeBands] } : {}),
    ...(budget ? { budget } : {}),
    ...(tripFacts.interests ? { interests: [...tripFacts.interests] } : {}),
    ...(tripFacts.pace ? { pace: tripFacts.pace } : {}),
    ...(tripFacts.accommodationTier ? { accommodationTier: tripFacts.accommodationTier } : {}),
    ...(tripFacts.mealPlan ? { mealPlan: tripFacts.mealPlan } : {}),
    ...(tripFacts.excursionIds ? { excursionIds: [...tripFacts.excursionIds] } : {}),
    ...(tripFacts.excursionNames ? { excursionNames: [...tripFacts.excursionNames] } : {}),
    ...(tripFacts.arrivalHubId ? { arrivalHubId: tripFacts.arrivalHubId } : {}),
    ...(tripFacts.departureHubId ? { departureHubId: tripFacts.departureHubId } : {}),
  };
}

function validateRoute(route, allowNonBookableRoute) {
  if (!route || route.verified !== true) {
    throw new Error("a verified road route is required before a quote can be issued");
  }
  if (typeof route.provider !== "string" || route.provider.length === 0) {
    throw new TypeError("route.provider is required");
  }
  const distanceKm = finiteNumber(route.distanceKm, "route.distanceKm");
  if (distanceKm < 0) throw new RangeError("route.distanceKm cannot be negative");
  const bookable = route.bookable !== false;
  if (!bookable && !allowNonBookableRoute) {
    throw new Error("a bookable route is required before a final quote can be issued");
  }
  return { provider: route.provider, distanceKm, bookable };
}

function validateLineItems(lineItems, currency) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw new TypeError("at least one pricing line item is required");
  }
  return lineItems.map((item, index) => {
    if (!item || typeof item !== "object" || typeof item.id !== "string") {
      throw new TypeError(`lineItems[${index}] must have a string id`);
    }
    const unitMinor = nonNegativeInteger(item.unitMinor, `lineItems[${index}].unitMinor`);
    const quantity = finiteNumber(item.quantity, `lineItems[${index}].quantity`);
    if (quantity < 0) throw new RangeError(`lineItems[${index}].quantity cannot be negative`);
    const itemCurrency = currencyCode(item.currency, `lineItems[${index}].currency`);
    if (itemCurrency !== currency) {
      throw new Error(`lineItems[${index}] uses ${itemCurrency}; FX must be explicit before quoting`);
    }
    const totalMinor = Math.round(unitMinor * quantity);
    return {
      id: item.id,
      ...(item.label ? { label: String(item.label) } : {}),
      unitMinor,
      quantity,
      currency,
      totalMinor,
    };
  });
}

function rateAmount(baseMinor, basisPoints) {
  return Math.round(baseMinor * basisPoints / 10_000);
}

/**
 * Calculate a reproducible quote from already-resolved admin rate line items.
 * This module deliberately does not invent hotel, vehicle, meal, FX, or tax
 * policy; those decisions belong to the published rate-version resolver.
 */
export function calculateQuote({
  tripFacts,
  route,
  lineItems,
  currency,
  rateVersionId,
  engineVersion = "pricing-v1",
  markupBps = 0,
  taxBps = 0,
  allowNonBookableRoute = false,
  rules = {},
}) {
  const facts = validateAnonymousTripFacts(tripFacts, rules);
  const normalizedCurrency = currencyCode(currency);
  const normalizedRoute = validateRoute(route, allowNonBookableRoute);
  const items = validateLineItems(lineItems, normalizedCurrency);
  const normalizedMarkupBps = basisPoints(markupBps, "markupBps");
  const normalizedTaxBps = basisPoints(taxBps, "taxBps");

  const subtotalMinor = items.reduce((sum, item) => sum + item.totalMinor, 0);
  const markupMinor = rateAmount(subtotalMinor, normalizedMarkupBps);
  const taxableMinor = subtotalMinor + markupMinor;
  const taxMinor = rateAmount(taxableMinor, normalizedTaxBps);
  const totalMinor = taxableMinor + taxMinor;
  const travellers = facts.adults + facts.children;
  const perPersonMinor = Math.round(totalMinor / travellers);

  let budgetComparison = { status: "not-provided" };
  if (facts.budget) {
    if (facts.budget.currency !== normalizedCurrency) {
      budgetComparison = { status: "currency-mismatch", currency: facts.budget.currency };
    } else {
      const comparisonMinor = facts.budget.basis === "perPerson" ? perPersonMinor : totalMinor;
      budgetComparison = {
        status: comparisonMinor <= facts.budget.amountMinor ? "within" : "over",
        basis: facts.budget.basis,
        targetMinor: facts.budget.amountMinor,
        actualMinor: comparisonMinor,
        currency: normalizedCurrency,
      };
    }
  }

  return {
    engineVersion,
    ...(rateVersionId ? { rateVersionId: String(rateVersionId) } : {}),
    currency: normalizedCurrency,
    route: normalizedRoute,
    travellers,
    lineItems: items,
    subtotalMinor,
    markupBps: normalizedMarkupBps,
    markupMinor,
    taxBps: normalizedTaxBps,
    taxMinor,
    totalMinor,
    perPersonMinor,
    budgetComparison,
  };
}
