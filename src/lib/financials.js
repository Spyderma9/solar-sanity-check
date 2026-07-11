// =============================================================================
// Tunable constants — adjust these as needed
// =============================================================================

export const ANNUAL_USAGE_KWH = 11000; // household yearly use; a bill upload replaces this later
export const ELECTRICITY_RATE = 0.15; // $/kWh
export const INSTALL_COST_PER_WATT = 3.0; // $/W installed
export const ANNUAL_DEGRADATION = 0.005; // panels lose 0.5%/yr
export const RATE_INFLATION = 0.03; // electricity price rises 3%/yr

const SYSTEM_LIFETIME_YEARS = 25;

// =============================================================================
// Pure functions
// =============================================================================

/**
 * Pick the smallest config whose yearlyEnergyDcKwh meets or exceeds
 * annualUsageKwh; if none reaches it, return the largest config.
 *
 * Example input shape:
 *   solarPanelConfigs = [
 *     { panelsCount: 4, yearlyEnergyDcKwh: 2000.5, ... },
 *     { panelsCount: 20, yearlyEnergyDcKwh: 9800.2, ... },
 *   ]
 */
export function pickBestConfig(solarPanelConfigs, annualUsageKwh) {
  const meeting = solarPanelConfigs.filter(
    (c) => c.yearlyEnergyDcKwh >= annualUsageKwh
  );
  if (meeting.length > 0) {
    return meeting.reduce((best, c) =>
      c.yearlyEnergyDcKwh < best.yearlyEnergyDcKwh ? c : best
    );
  }
  return solarPanelConfigs.reduce((best, c) =>
    c.yearlyEnergyDcKwh > best.yearlyEnergyDcKwh ? c : best
  );
}

/**
 * System size in kW.
 * Example: systemSizeKw(20, 400) => 8
 */
export function systemSizeKw(panelsCount, panelCapacityWatts) {
  return (panelsCount * panelCapacityWatts) / 1000;
}

/**
 * Build a 25-year cash flow.
 *
 * Example input shape:
 *   config = { panelsCount: 20, yearlyEnergyDcKwh: 9800.2 }
 *   panelCapacityWatts = 400
 *   options = { annualUsageKwh: 15206, electricityRate: 0.19685 } // optional,
 *     defaults to ANNUAL_USAGE_KWH / ELECTRICITY_RATE when no bill is provided
 *
 * Returns: [{ year: 1, production, savings, cumulativeSavings }, ...]
 */
export function buildCashFlow(config, panelCapacityWatts, options = {}) {
  const {
    annualUsageKwh = ANNUAL_USAGE_KWH,
    electricityRate = ELECTRICITY_RATE,
  } = options;

  const cashFlow = [];
  let cumulativeSavings = 0;

  for (let year = 1; year <= SYSTEM_LIFETIME_YEARS; year++) {
    const production =
      config.yearlyEnergyDcKwh * Math.pow(1 - ANNUAL_DEGRADATION, year - 1);
    const rate = electricityRate * Math.pow(1 + RATE_INFLATION, year - 1);
    const savings = Math.min(production, annualUsageKwh) * rate;
    cumulativeSavings += savings;

    cashFlow.push({ year, production, savings, cumulativeSavings });
  }

  return cashFlow;
}

/**
 * Total installed system cost in dollars.
 * Example: systemCost(20, 400) => 20 * 400 * 3.00 = 24000
 */
export function systemCost(panelsCount, panelCapacityWatts) {
  return panelsCount * panelCapacityWatts * INSTALL_COST_PER_WATT;
}

/**
 * First year where cumulativeSavings >= cost, or null if it never
 * pays back within the 25-year window.
 *
 * Example: paybackYear(buildCashFlow(config, 400), 24000) => 13
 */
export function paybackYear(cashFlow, cost) {
  const entry = cashFlow.find((y) => y.cumulativeSavings >= cost);
  return entry ? entry.year : null;
}
