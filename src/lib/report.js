import { jsPDF } from 'jspdf';

// A4 in mm
const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = 18;
const CONTENT_W = PAGE_W - 2 * MARGIN;
const BOTTOM = PAGE_H - 22;

const INK = [51, 48, 42];
const MUTED = [122, 115, 101];
const ACCENT = [185, 126, 16];
const VERDICT_RGB = {
  GOOD: [47, 125, 63],
  MARGINAL: [179, 89, 0],
  NO: [198, 40, 40],
};

// jsPDF's built-in fonts only cover WinAnsi — swap the characters they lack
const clean = (s) => String(s).replace(/−/g, '-').replace(/[≈☀]/g, '');

/**
 * Builds and downloads "solar-sanity-check-report.pdf" — a printable summary
 * of everything the site computed for this user: verdict, system numbers,
 * financing comparison, dealer-fee warning, and quote analysis.
 */
export function generateReport({
  addressLabel,
  usingBill,
  billData,
  results,
  tagline,
  financing,
  dealerFeePercent,
  quotedPrice,
  quoteData,
  quoteAnalysis,
  quoteWorth,
  worthStatement,
}) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
  let y = 0;

  const ensure = (needed) => {
    if (y + needed > BOTTOM) {
      doc.addPage();
      y = 20;
    }
  };

  const heading = (text) => {
    ensure(18);
    y += 9;
    doc.setFont('helvetica', 'bold').setFontSize(13).setTextColor(...INK);
    doc.text(clean(text), MARGIN, y);
    y += 2;
    doc.setDrawColor(...ACCENT).setLineWidth(0.6);
    doc.line(MARGIN, y, MARGIN + CONTENT_W, y);
    y += 7;
  };

  const row = (label, value) => {
    ensure(7);
    doc.setFont('helvetica', 'normal').setFontSize(10.5).setTextColor(...MUTED);
    doc.text(clean(label), MARGIN, y);
    doc.setFont('helvetica', 'bold').setTextColor(...INK);
    doc.text(clean(value), MARGIN + CONTENT_W, y, { align: 'right' });
    y += 6.2;
  };

  const para = (text, { size = 10, color = MUTED, style = 'normal', gap = 3 } = {}) => {
    doc.setFont('helvetica', style).setFontSize(size).setTextColor(...color);
    const lines = doc.splitTextToSize(clean(text), CONTENT_W);
    ensure(lines.length * 4.8 + gap);
    doc.text(lines, MARGIN, y);
    y += lines.length * 4.8 + gap;
  };

  const bullet = (text) => {
    doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(...INK);
    const lines = doc.splitTextToSize(clean(text), CONTENT_W - 6);
    ensure(lines.length * 4.8 + 1.5);
    doc.circle(MARGIN + 1.5, y - 1.2, 0.7, 'F');
    doc.text(lines, MARGIN + 6, y);
    y += lines.length * 4.8 + 1.5;
  };

  // ---------- Title ----------
  y = 24;
  doc.setFont('helvetica', 'bold').setFontSize(20).setTextColor(...INK);
  doc.text('Solar Sanity-Check Report', MARGIN, y);
  y += 7;
  doc.setFont('helvetica', 'normal').setFontSize(10.5).setTextColor(...MUTED);
  doc.text(clean(addressLabel), MARGIN, y);
  y += 5.5;
  doc.text(
    clean(
      `Prepared ${new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })} · ${
        usingBill ? 'based on your uploaded electric bill' : 'based on default usage estimates'
      }`
    ),
    MARGIN,
    y
  );
  y += 4;

  // ---------- Verdict ----------
  const rating = results.verdict.rating;
  const boxH = 15 + results.verdict.reasons.length * 5.2;
  ensure(boxH + 8);
  y += 5;
  doc.setFillColor(...(VERDICT_RGB[rating] ?? INK));
  doc.roundedRect(MARGIN, y, CONTENT_W, boxH, 2.5, 2.5, 'F');
  doc.setFont('helvetica', 'bold').setFontSize(18).setTextColor(255, 255, 255);
  doc.text(clean(`${rating} ${tagline ?? ''}`), MARGIN + 6, y + 10);
  doc.setFont('helvetica', 'normal').setFontSize(10);
  results.verdict.reasons.forEach((reason, i) => {
    doc.text(clean(`• ${reason}`), MARGIN + 6, y + 16.5 + i * 5.2);
  });
  y += boxH + 2;

  // ---------- System ----------
  heading('Your system at a glance');
  row('Panels', `${results.panelsCount} of ${results.maxArrayPanelsCount} the roof could hold`);
  row('System size', `${results.sizeKw.toFixed(1)} kW`);
  row('Year-1 production', `${Math.round(results.year1Production).toLocaleString('en-US')} kWh`);
  row(
    'System cost',
    quotedPrice != null
      ? `${money(quotedPrice)} (from your quote)`
      : `${money(results.cost)} (estimated at $3/W)`
  );
  row('Payback year', results.payback ?? 'Never (within 25 years)');
  row('25-year net savings', money(results.netSavings25));
  row(
    'Your usage',
    `${(billData?.annualUsageKwh ?? 11000).toLocaleString('en-US')} kWh/yr at $${(
      billData?.electricityRate ?? 0.15
    ).toFixed(2)}/kWh${usingBill ? '' : ' (defaults)'}`
  );
  row('Roof', `${results.segmentCount} segments · dominant ${Math.round(results.dominantAzimuth)} deg azimuth`);
  row('Max sunshine', `${Math.round(results.maxSunshineHoursPerYear).toLocaleString('en-US')} hours/yr`);

  // ---------- Financing ----------
  if (financing) {
    heading('How you pay changes everything');
    const cols = [
      ['Cash', financing.cash, null],
      ['Loan', financing.loan, `Monthly: ${money(financing.loan.rows[0].annualPayment / 12)}`],
      ['Lease', financing.lease, 'Panels never owned'],
    ];
    const colW = CONTENT_W / 3;
    ensure(34);
    cols.forEach(([title, option, note], i) => {
      const x = MARGIN + i * colW;
      doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(...INK);
      doc.text(title, x, y);
      doc.setFont('helvetica', 'normal').setFontSize(9.5).setTextColor(...MUTED);
      doc.text(clean(`Upfront: ${money(option.summary.upfrontCost)}`), x, y + 5.5);
      doc.text(
        clean(
          `Payback: ${option.summary.paybackYear ? `${option.summary.paybackYear} yrs` : 'never'}`
        ),
        x,
        y + 10.5
      );
      doc.text(clean(`25-yr net: ${money(option.summary.year25NetPosition)}`), x, y + 15.5);
      if (note) doc.text(clean(note), x, y + 20.5);
    });
    y += 27;

    if (dealerFeePercent > 0) {
      para(
        `With the ${dealerFeePercent}% dealer fee you modeled, the system's effective cost rises from ${money(
          financing.cash.summary.baseCost
        )} to ${money(financing.cash.summary.effectiveCost)} — adding ${
          financing.impact.addedPaybackYears
        } year${financing.impact.addedPaybackYears === 1 ? '' : 's'} to payback and costing ${money(
          financing.impact.lifetimeSavingsLost
        )} in lifetime savings.`,
        { color: INK, style: 'bold' }
      );
    }
    para(
      'Watch for hidden dealer fees: they can add up to 30% to your cost. Financing with no dealer fee (like ethical solar lenders) protects your savings. Always ask the installer for the cash price and the financed price side by side.'
    );
  }

  // ---------- Quote analysis ----------
  if (quoteData && quoteAnalysis) {
    heading('Your quote, checked');
    para(quoteAnalysis.summary.headline, { color: INK, style: 'bold', size: 11 });
    if (worthStatement) {
      para(worthStatement.text, {
        color: VERDICT_RGB[worthStatement.worthIt ? 'GOOD' : 'NO'],
        style: 'bold',
        size: 11,
      });
    }

    quoteData.forEach((opt, i) => {
      const analysis = quoteAnalysis.options[i];
      ensure(14);
      y += 2;
      doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(...INK);
      doc.text(clean(`${opt.optionLabel ?? `Option ${i + 1}`} — ${analysis.verdict}`), MARGIN, y);
      y += 5.5;
      const meta = [
        opt.totalPrice != null && money(opt.totalPrice),
        opt.systemSizeKw != null && `${opt.systemSizeKw} kW`,
        opt.pricePerWatt != null && `$${opt.pricePerWatt.toFixed(2)}/W`,
        opt.loanApr != null && `${(opt.loanApr * 100).toFixed(2)}% APR`,
        opt.loanTermYears != null && `${opt.loanTermYears} yrs`,
        opt.dealerOrOriginationFee != null && `fee ${money(opt.dealerOrOriginationFee)}`,
      ].filter(Boolean);
      if (meta.length > 0) para(meta.join(' · '), { gap: 2 });
      analysis.flags.forEach(bullet);
      if (quoteWorth?.[i]) {
        const w = quoteWorth[i];
        bullet(
          w.paybackYear != null
            ? `For you: pays back in year ${w.paybackYear} · ${money(w.net25)} after 25 years`
            : `For you: never pays back within 25 years (${money(w.net25)})`
        );
      }
    });
  }

  // ---------- Questions to ask ----------
  heading('Questions to ask any installer');
  [
    'What is the cash price, and what is the financed price? (The gap is the dealer fee.)',
    'Is there a dealer, origination, or financing fee built into the loan? How many dollars?',
    'What is the price per watt? (Fair is around $3/W installed; above $3.50/W is high.)',
    'What does the production estimate assume, and is it guaranteed?',
    'For a lease: who owns the panels, what is the annual escalator, and what happens if I sell the house?',
  ].forEach(bullet);

  // ---------- Footer on every page ----------
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...MUTED);
    doc.text(
      'Generated by Solar Sanity-Check. Estimates come from satellite roof modeling and standard assumptions - not a binding quote or financial advice.',
      MARGIN,
      PAGE_H - 10
    );
    doc.text(`${p} / ${pages}`, PAGE_W - MARGIN, PAGE_H - 10, { align: 'right' });
  }

  doc.save('solar-sanity-check-report.pdf');
}
