// =============================================================================
// Tunable thresholds — adjust these as needed
// =============================================================================

export const MAX_ACCEPTABLE_PAYBACK_YEARS = 15; // payback longer than this => MARGINAL
export const MIN_SUNSHINE_HOURS_PER_YEAR = 1000; // less than this => roof too shaded => NO
export const NORTH_FACING_TOLERANCE_DEG = 45; // within this many degrees of due north => NO
// East/west band: azimuth in [45, 135] (east) or [225, 315] (west) => MARGINAL
export const EAST_BAND = [45, 135];
export const WEST_BAND = [225, 315];

// =============================================================================
// Pure verdict function
// =============================================================================

function isNorthFacing(azimuth) {
  return (
    azimuth >= 360 - NORTH_FACING_TOLERANCE_DEG ||
    azimuth <= NORTH_FACING_TOLERANCE_DEG
  );
}

function isEastWestFacing(azimuth) {
  return (
    (azimuth >= EAST_BAND[0] && azimuth <= EAST_BAND[1]) ||
    (azimuth >= WEST_BAND[0] && azimuth <= WEST_BAND[1])
  );
}

/**
 * Pure honesty-verdict function.
 *
 * Example input shape:
 *   inputs = {
 *     paybackYear: 10,              // number or null
 *     netSavings25yr: 56654,        // dollars
 *     dominantAzimuth: 269,         // degrees
 *     maxSunshineHoursPerYear: 1839,
 *     electricityRate: 0.15,        // $/kWh (carried for future tuning)
 *   }
 *
 * Returns: { rating: "GOOD" | "MARGINAL" | "NO", reasons: string[] }
 */
export function getVerdict(inputs) {
  const { paybackYear, netSavings25yr, dominantAzimuth, maxSunshineHoursPerYear } =
    inputs;

  // --- Hard stops => NO ---
  const noReasons = [];
  if (paybackYear === null) {
    noReasons.push('The system never pays for itself within 25 years.');
  }
  if (netSavings25yr <= 0) {
    noReasons.push('Projected 25-year savings are zero or negative.');
  }
  if (maxSunshineHoursPerYear < MIN_SUNSHINE_HOURS_PER_YEAR) {
    noReasons.push(
      `Roof gets only ${Math.round(maxSunshineHoursPerYear)} sunshine hours per year — too shaded for solar to make sense.`
    );
  }
  if (isNorthFacing(dominantAzimuth)) {
    noReasons.push('Roof faces mostly north, which badly limits production.');
  }
  if (noReasons.length > 0) {
    return { rating: 'NO', reasons: noReasons };
  }

  // --- Cautions => MARGINAL ---
  const marginalReasons = [];
  if (paybackYear > MAX_ACCEPTABLE_PAYBACK_YEARS) {
    marginalReasons.push(
      `Payback is ${paybackYear} years, longer than we'd call a confident yes.`
    );
  }
  if (isEastWestFacing(dominantAzimuth)) {
    marginalReasons.push(
      'Roof faces east/west rather than south, which reduces production.'
    );
  }
  if (marginalReasons.length > 0) {
    return { rating: 'MARGINAL', reasons: marginalReasons };
  }

  // --- Otherwise GOOD ---
  return {
    rating: 'GOOD',
    reasons: [
      `South-facing roof with strong sunlight (${Math.round(maxSunshineHoursPerYear)} hours/year).`,
      `Pays for itself in ${paybackYear} years.`,
    ],
  };
}
