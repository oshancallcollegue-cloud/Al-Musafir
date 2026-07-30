import "dotenv/config";
import express from "express";
import cors from "cors";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { calculateRoute } from "./src/domain/route-provider.js";
import { buildQuotePreview, selectRouteStops } from "./src/domain/quote-engine.js";
import { validateAnonymousTripFacts } from "./src/domain/pricing-engine.js";

initializeApp({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || "al-musafir",
});
const db = getFirestore();

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.status(200).json({ ok: true, service: "al-musafir-expert-system" });
});

function jsonError(response, status, code, message) {
  response.status(status).json({ ok: false, error: { code, message } });
}

app.post("/quotePreview", async (request, response) => {
  try {
    const rulesSnap = await db.collection("settings").doc("expertSystem").get();
    let rules = rulesSnap.exists ? rulesSnap.data() : null;

    if (!rules) {
      const DEFAULT_RATES = {
        transportPerKm: 260,
        guidePerDay: 8000,
        activityPerPerson: 2000,
        markupPercent: 10,
        maxTripDays: 30,
        maxKmPerDay: 300,
        defaultInterests: "nature, culture, beach",
        maxCities3Days: 1,
        maxCities5Days: 2,
        maxCities7Days: 3,
        maxCities10Days: 4,
        tierStandard: 12000,
        tierBoutique: 18000,
        tierFiveStar: 20000,
        tierDeluxe: 25000,
        tierVilla: 30000,
        mealBreakfast: 1500,
        mealHalfBoard: 3500,
        mealFullBoard: 5000,
        mealAllInclusive: 7000
      };
      await db.collection("settings").doc("expertSystem").set(DEFAULT_RATES);
      rules = DEFAULT_RATES;
    }

    const tripFacts = validateAnonymousTripFacts(request.body ?? {}, rules);

    let expertCitiesSnap = await db.collection("expertCities").orderBy("order").get();
    let destinations = expertCitiesSnap.docs.map(doc => ({ id: doc.data().id || doc.id, ...doc.data() }));

    if (!destinations.length) {
      const SEED_EXPERT_CITIES = [
        { order:1, region:"Western Coast", airportCode: "cmb", emoji:"🏙️", title:"Colombo", lat:6.9271, lng:79.8612, interests:["culture","shopping"], description:"Sri Lanka's vibrant capital — colonial architecture, bustling markets, mosques and cosmopolitan food scene.", activities:["Jami Ul Alfar Mosque Visit", "Galle Face Green Stroll", "Colombo City Highlights Tour", "Pettah Spice Bazaar Walk"] },
        { order:2, region:"Hill Country", emoji:"🛕", title:"Kandy", lat:7.2906, lng:80.6337, interests:["culture","nature"], description:"Sri Lanka's cultural capital — the sacred Temple of the Tooth, Kandy Lake and lush hill country.", activities:["Temple of the Tooth Visit", "Kandy Lake Stroll", "Peradeniya Botanical Gardens", "Kandy Cultural Dance Show"] },
        { order:3, region:"Cultural Triangle", emoji:"🦁", title:"Sigiriya", lat:7.9570, lng:80.7603, interests:["culture","heritage","nature"], description:"The iconic Lion Rock fortress rising 200m above the jungle — a UNESCO World Heritage site.", activities:["Climb Sigiriya Rock Fortress", "Village Safari & Traditional Lunch", "Pidurangala Sunrise Hike"] },
        { order:4, region:"Tea Hills", emoji:"🍵", title:"Nuwara Eliya", lat:6.9497, lng:80.7839, interests:["nature","culture"], description:"The 'Little England' of Sri Lanka at 1,800m — misty tea estates and cool highland air.", activities:["Tea Factory & Tasting Tour", "Gregory Lake Boat Ride", "Strawberry Farm Visit", "Horton Plains Day Trip"] },
        { order:5, region:"Mountain South", emoji:"🏕️", title:"Ella", lat:6.8667, lng:80.0500, interests:["nature","adventure"], description:"Scenic mountain village famous for the Nine Arch Bridge, Little Adam's Peak and lush valley views.", activities:["Nine Arch Bridge Train View", "Little Adam's Peak Hike", "Ella Rock Sunrise Trek", "Diyaluma Waterfall Visit"] },
        { order:6, region:"Wild South", emoji:"🐆", title:"Yala", lat:6.3768, lng:81.3969, interests:["wildlife","nature"], description:"Sri Lanka's most visited national park — the highest leopard density in the world.", activities:["Jeep Safari Wildlife Tour", "Leopard Spotting at Dawn", "Birdwatching at Bundala"] },
        { order:7, region:"Southern Coast", emoji:"⚓", title:"Galle", lat:6.0535, lng:80.2210, interests:["culture","beach"], description:"A stunning Dutch colonial fort city on the southern tip — UNESCO heritage and ocean breezes.", activities:["Galle Fort Walking Tour", "Lighthouse & Ramparts Sunset", "Sea Turtle Hatchery Visit"] },
        { order:8, region:"West Coast", emoji:"🌊", title:"Bentota", lat:6.4277, lng:79.9981, interests:["beach","nature"], description:"Pristine golden beaches, river safaris and water sports on Sri Lanka's west coast.", activities:["River Safari & Turtle Hatchery", "Water Sports & Jet Ski", "Sunset Beach Dinner"] },
        { order:9, region:"South Coast", emoji:"🐋", title:"Mirissa", lat:5.9483, lng:80.4572, interests:["beach","wildlife"], description:"A serene beach village famous for whale watching and laid-back atmosphere.", activities:["Blue Whale Watching Cruise", "Parrot Rock Sunrise", "Mirissa Beach Snorkelling"] },
        { order:10, region:"Cultural Triangle", emoji:"🏯", title:"Dambulla", lat:7.8731, lng:80.7718, interests:["culture","heritage"], description:"The magnificent Dambulla Cave Temple — 5 caves filled with 150+ Buddha statues.", activities:["Dambulla Cave Temple Tour", "Rangiri Dambulla Lake Boat Ride", "Local Market Walk"] },
        { order:11, region:"East Coast", emoji:"🏖️", title:"Trincomalee", lat:8.5874, lng:81.2152, interests:["beach","nature","culture"], description:"Sri Lanka's natural harbour and pristine east coast beaches — calm turquoise waters.", activities:["Nilaveli Beach Snorkelling", "Whale & Dolphin Watching", "Koneswaram Temple Visit"] },
        { order:12, region:"South Safari", emoji:"🐘", title:"Udawalawe", lat:6.4731, lng:80.8997, interests:["wildlife","nature","adventure"], description:"Wild elephant herds roam freely — the best park to see elephants in Sri Lanka.", activities:["Elephant Safari Jeep Tour", "Elephant Transit Home Visit", "Birdwatching at the Reservoir"] },
        { order:13, region:"Ancient Kingdom", emoji:"🏛️", title:"Polonnaruwa", lat:7.9399, lng:81.0000, interests:["culture","heritage","nature"], description:"A magnificent medieval ruined city — the second ancient capital of Sri Lanka.", activities:["Polonnaruwa Ruins Cycle Tour", "Gal Vihara Rock Temple", "Ancient Royal Palace Visit"] }
      ];
      const batch = db.batch();
      for (const city of SEED_EXPERT_CITIES) {
        batch.set(db.collection("expertCities").doc(), city);
      }
      await batch.commit();

      expertCitiesSnap = await db.collection("expertCities").orderBy("order").get();
      destinations = expertCitiesSnap.docs.map(doc => ({ id: doc.data().id || doc.id, ...doc.data() }));
    }

    if (!destinations.some(d => d.id === 'mri' || d.airportCode === 'mri' || (d.title && d.title.toLowerCase() === 'mattala'))) {
      destinations.push({
        id: 'mri',
        airportCode: 'mri',
        title: 'Mattala',
        lat: 6.287,
        lng: 81.123,
        region: 'Deep South',
        interests: ['transit'],
        description: 'Mattala Rajapaksa International Airport.',
        activities: []
      });
    }

    const stops = selectRouteStops(tripFacts, destinations, rules);
    const route = await calculateRoute(stops);

    response.status(200).json(buildQuotePreview({ tripFacts, route, destinations, rules }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to calculate this itinerary";
    const isValidation = error instanceof TypeError || error instanceof RangeError || message.includes("unknown ");
    jsonError(response, isValidation ? 400 : 422,
      isValidation ? "invalid-trip-facts" : "quote-unavailable",
      message);
  }
});

app.post("/enquiry", async (request, response) => {
  try {
    const payload = request.body || {};
    if (!payload.firstName || !payload.email) {
      jsonError(response, 400, "invalid-payload", "First name and email are required");
      return;
    }

    const enquiryDoc = {
      ...payload,
      status: "unread",
      createdAt: FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection("enquiries").add(enquiryDoc);
    response.status(200).json({ ok: true, id: docRef.id });
  } catch (error) {
    jsonError(response, 500, "internal-error", "Unable to submit enquiry");
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});