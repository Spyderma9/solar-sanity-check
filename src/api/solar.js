const BASE_URL = 'https://solar.googleapis.com/v1/buildingInsights:findClosest';
const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

// Resolves a street address to { lat, lng, label } via the Google Geocoding API
// (needs "Geocoding API" enabled on the same key as the Solar API).
export async function geocodeAddress(address) {
  const key = import.meta.env.VITE_SOLAR_KEY;
  const url = `${GEOCODE_URL}?address=${encodeURIComponent(address)}&key=${key}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Geocoding request failed with HTTP status ${response.status}`);
  }
  const data = await response.json();
  if (data.status === 'ZERO_RESULTS') {
    throw new Error('Address not found — try adding a city and state');
  }
  if (data.status !== 'OK') {
    throw new Error(`Geocoding failed: ${data.error_message ?? data.status}`);
  }

  const result = data.results[0];
  return {
    lat: result.geometry.location.lat,
    lng: result.geometry.location.lng,
    label: result.formatted_address,
  };
}

export async function getBuildingInsights(lat, lng) {
  const key = import.meta.env.VITE_SOLAR_KEY;
  const url = `${BASE_URL}?location.latitude=${lat}&location.longitude=${lng}&key=${key}`;

  const response = await fetch(url);
  if (response.status === 403) {
    throw new Error('Error 403 — check billing/key');
  }
  if (response.status === 404) {
    throw new Error('No solar data for this building');
  }
  if (!response.ok) {
    throw new Error(`Error: Solar API request failed with HTTP status ${response.status}`);
  }
  return response.json();
}
