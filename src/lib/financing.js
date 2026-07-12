// =============================================================================
// Tunable financing constants — adjust these as needed
// =============================================================================

export const LOAN_APR = 0.08; // typical solar loan rate
export const LOAN_TERM_YEARS = 25; // fully amortized within the 25-year comparison window
export const LEASE_ANNUAL_ESCALATOR = 0.029; // lease payments rise ~2.9%/yr
export const LEASE_FIRST_YEAR_FACTOR = 0.85; // lease year-1 payment ≈ 85% of what grid power would cost
export const MAX_DEALER_FEE_PCT = 0.3; // hidden dealer fees can add up to 30% to system cost

// =============================================================================
// Pure financing functions
//
// All three take the 25-year energy cash flow produced by
// financials.buildCashFlow(): [{ year, production, savings, cumulativeSavings }]
// where `savings` is the grid cost avoided that year.
//
// All three return:
//   {
//     rows: [{ year, netCashFlow, cumulative, ... }],   // 25 entries
//     summary: { upfrontCost, year25NetPosition, paybackYear },
//   }
// =============================================================================

// First year (1-based) where cumulative >= 0, or null if never within horizon.
function findPaybackYear(rows) {
  const entry = rows.find((r) => r.cumulative >= 0);
  return entry ? entry.year : null;
}

// Shared core for all three options: run the yearly accumulation and assemble
// rows + summary. perYear(year, savings) returns the row's fields, including
// netCashFlow, which drives the running cumulative.
function buildOption(startingCumulative, energyCashFlow, perYear, summaryExtras = {}) {
  let cumulative = startingCumulative;
  const rows = energyCashFlow.map(({ year, savings }) => {
    const row = perYear(year, savings);
    cumulative += row.netCashFlow;
    return { year, ...row, cumulative };
  });

  return {
    rows,
    summary: {
      ...summaryExtras,
      year25NetPosition: rows[rows.length - 1].cumulative,
      paybackYear: findPaybackYear(rows),
    },
  };
}

/**
 * Option 1: pay cash upfront.
 * netCashFlow each year = that year's energy savings;
 * cumulative starts at -(fee-inflated) system cost and climbs as savings accrue.
 *
 * dealerFeePct (default 0) inflates the effective cost:
 *   effectiveCost = systemCost × (1 + dealerFeePct)
 */
export function cashPurchase(systemCost, energyCashFlow, dealerFeePct = 0) {
  const effectiveCost = systemCost * (1 + dealerFeePct);

  return buildOption(-effectiveCost, energyCashFlow, (year, savings) => ({ netCashFlow: savings }), {
    baseCost: systemCost,
    effectiveCost, // e.g. "System: $24,000 → With dealer fee: $31,200"
    dealerFeePct,
    upfrontCost: effectiveCost,
  });
}

/**
 * Option 2: amortizing loan at LOAN_APR over LOAN_TERM_YEARS, no money down.
 *
 * The headline cash/loan/lease comparison calls this with NO dealer fee
 * (dealerFeePct = 0) so all three options sit on equal footing. The dealer
 * fee is examined separately via dealerFeeImpact().
 *
 * Standard amortization formula for the fixed periodic payment:
 *   payment = P * r / (1 - (1 + r)^-n)
 * where P = principal, r = periodic interest rate (annual here),
 * n = number of periods. This is the payment that exactly zeroes the
 * balance after n periods, because each payment covers that period's
 * interest (balance * r) plus a growing slice of principal.
 */
export function loanFinanced(systemCost, energyCashFlow, dealerFeePct = 0) {
  const effectiveCost = systemCost * (1 + dealerFeePct);
  const r = LOAN_APR;
  const n = LOAN_TERM_YEARS;
  const annualPayment = (effectiveCost * r) / (1 - Math.pow(1 + r, -n));

  // Term matches the 25-year window, so a payment applies every year.
  return buildOption(
    0, // nothing down
    energyCashFlow,
    (year, savings) => ({ annualPayment, netCashFlow: savings - annualPayment }),
    {
      baseCost: systemCost,
      effectiveCost, // e.g. "System: $24,000 → With dealer fee: $31,200"
      dealerFeePct,
      upfrontCost: 0,
    }
  );
}

/**
 * Option 3: solar lease, nothing down.
 * Year-1 payment = LEASE_FIRST_YEAR_FACTOR × that year's grid cost
 * (the energy savings the panels provide), then the payment rises by
 * LEASE_ANNUAL_ESCALATOR each year regardless of what grid prices do.
 * The user keeps the difference between grid cost avoided and the payment.
 */
export function leaseFinanced(energyCashFlow) {
  const firstYearPayment = LEASE_FIRST_YEAR_FACTOR * energyCashFlow[0].savings;

  return buildOption(
    0, // nothing down
    energyCashFlow,
    (year, savings) => {
      const leasePayment =
        firstYearPayment * Math.pow(1 + LEASE_ANNUAL_ESCALATOR, year - 1);
      return { leasePayment, netCashFlow: savings - leasePayment };
    },
    { upfrontCost: 0 }
  );
}

/**
 * Isolate the cost of a hidden dealer fee: the core honesty feature that makes
 * visible the markup a "no dealer fee" lender (e.g. OneEthos) eliminates.
 *
 * Takes the full result returned by cashPurchase() or loanFinanced() (rows +
 * summary), reconstructs the underlying energy savings from the rows, re-runs
 * the same option at ZERO fee, and reports the difference.
 *
 * Powers a readout like:
 *   "A 30% dealer fee adds 5 years to your payback and costs $16,900 in
 *    lifetime savings."
 *
 * Returns { dealerFeePct, addedPaybackYears, lifetimeSavingsLost, withoutFee, withFee }.
 */
export function dealerFeeImpact(result) {
  const { baseCost, dealerFeePct } = result.summary;
  const isLoan = result.rows[0].annualPayment !== undefined;

  // Reconstruct the raw energy savings each year:
  //   loan rows: netCashFlow = savings - annualPayment  =>  savings = net + payment
  //   cash rows: netCashFlow = savings
  const savingsFlow = result.rows.map((row) => ({
    year: row.year,
    savings: isLoan ? row.netCashFlow + row.annualPayment : row.netCashFlow,
  }));

  const withoutFee = isLoan
    ? loanFinanced(baseCost, savingsFlow, 0)
    : cashPurchase(baseCost, savingsFlow, 0);

  const horizon = result.rows.length;
  // Treat "never pays back within the horizon" as horizon + 1 so the delta
  // stays meaningful when the fee pushes payback past year 25.
  const paybackWithout = withoutFee.summary.paybackYear ?? horizon + 1;
  const paybackWith = result.summary.paybackYear ?? horizon + 1;

  return {
    dealerFeePct,
    withoutFee,
    withFee: result,
    addedPaybackYears: paybackWith - paybackWithout,
    lifetimeSavingsLost:
      withoutFee.summary.year25NetPosition - result.summary.year25NetPosition,
  };
}

