import { buildCashFlow } from './financials.js';
import { MAX_ACCEPTABLE_PAYBACK_YEARS } from './verdict.js';

/**
 * Is a quoted option worth it for THIS household?
 *
 * Values the system the quote is selling — at the quote's own price and loan
 * terms — using the user's usage and electricity rate (from their bill, or
 * defaults) and how productive their actual roof is.
 *
 * option: one extracted quote option ({ totalPrice, loanApr, loanTermYears, ... })
 * production: yearly kWh the quoted system would generate on this roof
 *
 * Returns { paybackYear, net25, worthIt, financed } or null when the quote
 * has no usable price (or the roof model gave us no production).
 */
export function evaluateQuoteOption(option, { production, annualUsageKwh, electricityRate }) {
  const { totalPrice, loanApr, loanTermYears } = option;
  if (totalPrice == null || totalPrice <= 0 || !production) return null;

  const cashFlow = buildCashFlow({ yearlyEnergyDcKwh: production }, null, {
    annualUsageKwh,
    electricityRate,
  });

  const financed = loanApr != null && loanApr > 0 && loanTermYears != null;
  const annualPayment = financed
    ? (totalPrice * loanApr) / (1 - Math.pow(1 + loanApr, -loanTermYears))
    : 0;

  // Cash: pay the price upfront and recover it through savings.
  // Loan: nothing down; payments apply only during the quoted term.
  let cumulative = financed ? 0 : -totalPrice;
  let paybackYear = null;
  for (const { year, savings } of cashFlow) {
    cumulative += savings - (financed && year <= loanTermYears ? annualPayment : 0);
    if (paybackYear === null && cumulative >= 0) paybackYear = year;
  }

  return {
    paybackYear,
    net25: cumulative,
    financed,
    worthIt:
      paybackYear !== null &&
      paybackYear <= MAX_ACCEPTABLE_PAYBACK_YEARS &&
      cumulative > 0,
  };
}
