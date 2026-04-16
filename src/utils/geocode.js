/**
 * utils/geocode.js — Geocode street addresses to lat/lng coordinates.
 *
 * Uses Google Maps Geocoding API for Clover merchants (address only, no coords).
 * Square provides coordinates directly via Locations API.
 *
 * Requires: GOOGLE_MAPS_API_KEY env var.
 */

"use strict";

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";
const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

/**
 * Geocode a street address to lat/lng coordinates.
 *
 * @param {{ address1?: string, city?: string, state?: string, postal?: string, country?: string }} address
 * @returns {Promise<{ latitude: number, longitude: number } | null>}
 */
async function geocodeAddress(address) {
  if (!GOOGLE_MAPS_API_KEY) {
    console.warn("[geocode] GOOGLE_MAPS_API_KEY not set — skipping geocode");
    return null;
  }

  const parts = [address.address1, address.city, address.state, address.postal, address.country || "US"].filter(Boolean);
  if (parts.length < 2) {
    console.warn("[geocode] insufficient address data for geocoding:", parts);
    return null;
  }

  const query = parts.join(", ");

  try {
    const url = `${GEOCODE_URL}?address=${encodeURIComponent(query)}&key=${GOOGLE_MAPS_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.status !== "OK" || !data.results?.length) {
      console.warn(`[geocode] no results for "${query}": ${data.status}`);
      return null;
    }

    const { lat, lng } = data.results[0].geometry.location;
    console.log(`[geocode] "${query}" → ${lat}, ${lng}`);
    return { latitude: lat, longitude: lng };
  } catch (e) {
    console.error("[geocode] error:", e?.message || String(e));
    return null;
  }
}

/**
 * Update a Store record with geocoded coordinates.
 *
 * @param {object} prisma
 * @param {number} storeId
 * @param {{ address1?: string, city?: string, state?: string, postal?: string }} address
 * @returns {Promise<{ latitude: number, longitude: number } | null>}
 */
async function geocodeAndUpdateStore(prisma, storeId, address) {
  const coords = await geocodeAddress(address);
  if (!coords) return null;

  await prisma.store.update({
    where: { id: storeId },
    data: { latitude: coords.latitude, longitude: coords.longitude },
  });

  return coords;
}

/**
 * Sync store coordinates from Square Locations API.
 * Square provides lat/lng directly — no geocoding needed.
 *
 * @param {object} prisma
 * @param {number} storeId
 * @param {{ latitude?: number, longitude?: number }} coordinates
 * @returns {Promise<{ latitude: number, longitude: number } | null>}
 */
async function syncSquareCoordinates(prisma, storeId, coordinates) {
  if (!coordinates?.latitude || !coordinates?.longitude) return null;

  await prisma.store.update({
    where: { id: storeId },
    data: { latitude: coordinates.latitude, longitude: coordinates.longitude },
  });

  return { latitude: coordinates.latitude, longitude: coordinates.longitude };
}

module.exports = { geocodeAddress, geocodeAndUpdateStore, syncSquareCoordinates };
