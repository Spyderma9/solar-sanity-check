// =============================================================================
// Tunable thresholds — grounded in typical US residential solar
// =============================================================================

export const FAIR_PRICE_PER_WATT = 3.0; // ~national average, $/W installed
export const HIGH_PRICE_PER_WATT = 3.5; // above this is clearly overpriced
export const FAIR_APR = 0.08; // competitive solar loan rate
export const HIGH_APR = 0.1; // above this is a costly loan
export const DEALER_FEE_FLAG_PCT = 0.1; // fee > 10% of price is a red flag

// Severity order for computing the worst verdict
const SEVERITY = { FAIR: 0, OVERPRICED: 1, PREDATORY: 2 };

const money = (n) => '$' + Math.abs(Math.round(n)).toLocaleString();
const pct = (n) => (n * 100).toFixed(1).replace(/\.0$/, '') + '%';

// Natural-language join for headline fragments:
//   ["a $4,200 fee", "8.9% APR"] + pricePart -> "a $4,200 fee and 8.9% APR on
//   top of an already-high $4.00/watt"
function joinReasons(parts, pricePart) {
  const lead = parts.join(' and ');
  if (lead && pricePart) return `${lead} on top of ${pricePart}`;
  return lead || pricePart || '';
}

function analyzeOption(option) {
  const {
    optionLabel,
    totalPrice,
    systemSizeKw,
    pricePerWatt,
    loanApr,
    dealerOrOriginationFee,
  } = option;

  const flags = [];

  // --- Price per watt (skip if null) ---
  const priceTooHigh = pricePerWatt != null && pricePerWatt > HIGH_PRICE_PER_WATT;
  if (priceTooHigh) {
    const overPct = (pricePerWatt - FAIR_PRICE_PER_WATT) / FAIR_PRICE_PER_WATT;
    flags.push(
      `$${pricePerWatt.toFixed(2)}/watt is well above the ~$${FAIR_PRICE_PER_WATT.toFixed(2)} average — about ${pct(overPct)} overpriced.`
    );
  }

  // --- Loan APR (skip if null — cash options have no APR) ---
  const aprCostly = loanApr != null && loanApr > FAIR_APR;
  const aprPredatory = loanApr != null && loanApr > HIGH_APR;
  if (aprCostly) {
    flags.push(
      `${pct(loanApr)} APR is a costly loan; competitive rates are near ${pct(FAIR_APR)}.`
    );
  }

  // --- Dealer/origination fee (skip if null) ---
  const feeExcessive =
    dealerOrOriginationFee != null &&
    totalPrice != null &&
    dealerOrOriginationFee > DEALER_FEE_FLAG_PCT * totalPrice;
  if (feeExcessive) {
    const feePct = dealerOrOriginationFee / totalPrice;
    flags.push(
      `${money(dealerOrOriginationFee)} fee is ${pct(feePct)} of the price — the hidden markup honest lenders don't charge.`
    );
  }

  // --- Verdict ---
  let verdict;
  if (priceTooHigh && (aprPredatory || feeExcessive)) {
    verdict = 'PREDATORY';
  } else if (flags.length > 0) {
    verdict = 'OVERPRICED';
  } else {
    verdict = 'FAIR';
    flags.push('Priced within the fair range for residential solar — no red flags.');
  }

  // Dollars above fair-market for this option (null if we can't compute it)
  const fairPriceDelta =
    totalPrice != null && systemSizeKw != null
      ? totalPrice - systemSizeKw * 1000 * FAIR_PRICE_PER_WATT
      : null;

  return { optionLabel, verdict, flags, fairPriceDelta };
}

/**
 * Pure quote analysis over ALL extracted options.
 *
 * Input: array of options from extractQuoteData():
 *   [{ optionLabel, totalPrice, systemSizeKw, pricePerWatt,
 *      loanApr, loanTermYears, dealerOrOriginationFee }]
 *
 * Returns {
 *   options: [{ optionLabel, verdict, flags, fairPriceDelta }],
 *   summary: { worstVerdict, steeredOption, headline },
 * }
 */
export function analyzeQuotes(options) {
  const analyzed = options.map(analyzeOption);

  const worstVerdict = analyzed.reduce(
    (worst, o) => (SEVERITY[o.verdict] > SEVERITY[worst] ? o.verdict : worst),
    'FAIR'
  );

  // The option the installer would likely steer the buyer toward:
  // the financed option if one exists, otherwise the priciest.
  const financedIdx = options.findIndex(
    (o) => o.loanApr != null || o.loanTermYears != null
  );
  const priciestIdx = options.reduce(
    (best, o, i) =>
      (o.totalPrice ?? -Infinity) > (options[best].totalPrice ?? -Infinity) ? i : best,
    0
  );
  const steeredIdx = financedIdx !== -1 ? financedIdx : priciestIdx;
  const steered = analyzed[steeredIdx];
  const steeredRaw = options[steeredIdx];

  // --- One honest headline sentence ---
  let headline;
  if (worstVerdict === 'FAIR') {
    headline = 'All options are fairly priced — this quote looks honest.';
  } else {
    // Build the reason fragment from the steered option's numbers
    const parts = [];
    if (
      steeredRaw.dealerOrOriginationFee != null &&
      steeredRaw.totalPrice != null &&
      steeredRaw.dealerOrOriginationFee > DEALER_FEE_FLAG_PCT * steeredRaw.totalPrice
    ) {
      parts.push(`a ${money(steeredRaw.dealerOrOriginationFee)} fee`);
    }
    if (steeredRaw.loanApr != null && steeredRaw.loanApr > FAIR_APR) {
      parts.push(`${pct(steeredRaw.loanApr)} APR`);
    }
    const pricePart =
      steeredRaw.pricePerWatt != null && steeredRaw.pricePerWatt > HIGH_PRICE_PER_WATT
        ? `an already-high $${steeredRaw.pricePerWatt.toFixed(2)}/watt`
        : '';

    const fairOther = analyzed.find((o, i) => i !== steeredIdx && o.verdict === 'FAIR');
    const steeredClause =
      steered.verdict === 'FAIR'
        ? `the ${steered.optionLabel} option they'd likely steer you toward is fairly priced`
        : `the ${steered.optionLabel} option they'd likely steer you toward is ${steered.verdict.toLowerCase()} — ${joinReasons(parts, pricePart)}`;

    if (fairOther) {
      headline = `The ${fairOther.optionLabel} option is fairly priced, but ${steeredClause}.`;
    } else if (steered.verdict !== 'FAIR') {
      headline = `${steeredClause[0].toUpperCase()}${steeredClause.slice(1)}.`;
    } else {
      // Steered option is fair but another option is flagged
      const worst = analyzed.find((o) => o.verdict === worstVerdict);
      headline = `The ${steered.optionLabel} option is fairly priced, but the ${worst.optionLabel} option is ${worstVerdict.toLowerCase()}.`;
    }
  }

  return {
    options: analyzed,
    summary: {
      worstVerdict,
      steeredOption: steered.optionLabel,
      headline,
    },
  };
}
