const BASE_URL = 'https://solar.googleapis.com/v1/buildingInsights:findClosest';

export async function getBuildingInsights(lat, lng) {
  const key = import.meta.env.VITE_SOLAR_KEY;
  const url = `${BASE_URL}?location.latitude=${lat}&location.longitude=${lng}&key=${key}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Solar API request failed with HTTP status ${response.status}`);
  }
  return response.json();
}
