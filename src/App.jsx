import { useEffect, useMemo, useState } from 'react';
import { TEST_ADDRESS } from './fixtures/testAddress';
import { geocodeAddress, getBuildingInsights } from './api/solar';
import { extractBillData, extractQuoteData } from './api/gemini';
import {
  ANNUAL_USAGE_KWH,
  ELECTRICITY_RATE,
  pickBestConfig,
  summarizeSystem,
} from './lib/financials';
import { getVerdict } from './lib/verdict';
import {
  cashPurchase,
  loanFinanced,
  leaseFinanced,
  dealerFeeImpact,
  MAX_DEALER_FEE_PCT,
} from './lib/financing';
import { analyzeQuotes } from './lib/quoteCheck';
import { evaluateQuoteOption } from './lib/quoteWorth';
import { fmtMoney } from './lib/format';
import RoofDesigner from './RoofDesigner';

const VERDICT_CLASS = {
  GOOD: 'verdict-good',
  MARGINAL: 'verdict-marginal',
  NO: 'verdict-no',
};

// Plain-spoken tagline that finishes the verdict's sentence
const VERDICT_TAGLINE = {
  GOOD: '— worth it.',
  MARGINAL: '— it’s close.',
  NO: '— skip it.',
};

const QUOTE_CHIP_CLASS = {
  FAIR: 'chip-fair',
  OVERPRICED: 'chip-overpriced',
  PREDATORY: 'chip-predatory',
};

function FinancingColumn({ title, option, best = false, extra }) {
  return (
    <div className={best ? 'fin best' : 'fin'}>
      <h3>{title}</h3>
      <p>
        Upfront <b>{fmtMoney(option.summary.upfrontCost)}</b>
      </p>
      <p>
        Payback{' '}
        <b>{option.summary.paybackYear ? `${option.summary.paybackYear} yrs` : 'never'}</b>
      </p>
      <p>
        25-yr net <b>{fmtMoney(option.summary.year25NetPosition)}</b>
      </p>
      {extra}
    </div>
  );
}

function App() {
  const [status, setStatus] = useState('Loading…');
  const [solarData, setSolarData] = useState(null);

  // Where we're checking — geocoded from whatever the user types
  const [location, setLocation] = useState(TEST_ADDRESS);
  const [addressInput, setAddressInput] = useState(TEST_ADDRESS.label);
  const [addressError, setAddressError] = useState('');
  const [geocoding, setGeocoding] = useState(false);

  async function handleAddressSubmit(event) {
    event.preventDefault();
    const query = addressInput.trim();
    if (!query || geocoding) return;

    setGeocoding(true);
    setAddressError('');
    try {
      const found = await geocodeAddress(query);
      setAddressInput(found.label);
      // New roof: drop the old data and any panel customizations
      setSolarData(null);
      setStatus('Loading…');
      setCustomPanelIds(null);
      setLocation(found);
    } catch (err) {
      setAddressError(err.message);
    } finally {
      setGeocoding(false);
    }
  }

  // Saved choice wins; otherwise follow the system preference
  const [theme, setTheme] = useState(
    () =>
      localStorage.getItem('theme') ??
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);

  // Which page is showing: the roof/verdict side or the money side.
  // State lives above both, so uploads and toggles survive switching.
  const [page, setPage] = useState('roof');

  const [billStatus, setBillStatus] = useState('');
  const [billData, setBillData] = useState(null); // parsed { annualUsageKwh, electricityRate }
  const [billRawText, setBillRawText] = useState(''); // shown only if JSON parsing fails

  const [quoteStatus, setQuoteStatus] = useState('');
  const [quoteData, setQuoteData] = useState(null); // parsed quote fields
  const [quoteRawText, setQuoteRawText] = useState(''); // shown only if JSON parsing fails

  // Shared flow for both uploads: extract via Gemini, then either show the
  // parsed data or fall back to the raw model text
  async function handleUpload(event, extract, setStatus, setData, setRaw) {
    const file = event.target.files[0];
    if (!file) return;

    setStatus('Extracting…');
    setData(null);
    setRaw('');

    try {
      const { data, raw } = await extract(file);
      if (data !== undefined) {
        setData(data);
        setStatus('Extracted');
      } else {
        setStatus('Could not parse JSON — raw response below:');
        setRaw(raw);
      }
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    }
  }

  // Judge all extracted quote options (pure; re-runs when a new quote is parsed)
  const quoteAnalysis = useMemo(
    () => (quoteData ? analyzeQuotes(quoteData) : null),
    [quoteData]
  );

  useEffect(() => {
    let cancelled = false;
    getBuildingInsights(location.lat, location.lng)
      .then((data) => {
        if (cancelled) return;
        setSolarData(data);
        setStatus('Loaded');
      })
      .catch((err) => {
        if (!cancelled) setStatus(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [location]);

  // True when a bill was extracted with usable values
  const usingBill = Boolean(
    billData &&
      (billData.annualUsageKwh != null || billData.electricityRate != null)
  );

  // Recommended config (panels are sorted best-first, so config N = first N panels)
  const recommendedCount = useMemo(() => {
    if (!solarData) return null;
    const annualUsageKwh = billData?.annualUsageKwh ?? ANNUAL_USAGE_KWH;
    return pickBestConfig(solarData.solarPotential.solarPanelConfigs, annualUsageKwh)
      .panelsCount;
  }, [solarData, billData]);

  // null = user hasn't toggled anything yet, follow the recommendation
  const [customPanelIds, setCustomPanelIds] = useState(null);

  const activePanelIds = useMemo(() => {
    if (customPanelIds) return customPanelIds;
    if (recommendedCount == null) return new Set();
    return new Set(Array.from({ length: recommendedCount }, (_, i) => i));
  }, [customPanelIds, recommendedCount]);

  function togglePanel(index) {
    const next = new Set(activePanelIds);
    if (next.has(index)) {
      next.delete(index);
    } else {
      next.add(index);
    }
    setCustomPanelIds(next);
  }

  // Re-runs automatically when the solar data loads, a bill is extracted,
  // or panels are toggled on the roof canvas
  const results = useMemo(() => {
    if (!solarData) return null;

    const summary = summarizeSystem(solarData.solarPotential, activePanelIds, {
      annualUsageKwh: billData?.annualUsageKwh ?? ANNUAL_USAGE_KWH,
      electricityRate: billData?.electricityRate ?? ELECTRICITY_RATE,
    });

    const verdict = getVerdict({
      paybackYear: summary.payback,
      netSavings25yr: summary.netSavings25,
      dominantAzimuth: summary.arraySegment.azimuthDegrees,
      dominantPitch: summary.arraySegment.pitchDegrees,
      maxSunshineHoursPerYear: summary.maxSunshineHoursPerYear,
    });

    return { ...summary, dominantAzimuth: summary.arraySegment.azimuthDegrees, verdict };
  }, [solarData, billData, activePanelIds]);

  // The quote's system price (lowest option with a price — typically the cash
  // option, before financing markup). Null until a quote is uploaded.
  const quotedPrice = useMemo(() => {
    const prices = quoteData?.map((o) => o.totalPrice).filter((p) => p != null) ?? [];
    return prices.length > 0 ? Math.min(...prices) : null;
  }, [quoteData]);

  // Is each quoted option worth it for this household? Combines the roof's
  // productivity, the quote's size/price/terms, and the bill's usage & rate.
  const quoteWorth = useMemo(() => {
    if (!quoteData || !results || results.sizeKw <= 0) return null;
    const kwhPerKw = results.year1Production / results.sizeKw;
    const usage = {
      annualUsageKwh: billData?.annualUsageKwh ?? ANNUAL_USAGE_KWH,
      electricityRate: billData?.electricityRate ?? ELECTRICITY_RATE,
    };
    return quoteData.map((opt) =>
      evaluateQuoteOption(opt, {
        production:
          opt.systemSizeKw != null ? kwhPerKw * opt.systemSizeKw : results.year1Production,
        ...usage,
      })
    );
  }, [quoteData, results, billData]);

  // Dealer-fee slider (0–30%), stored as a whole percent for clean stepping
  const [dealerFeePercent, setDealerFeePercent] = useState(0);

  // Financing comparison — recomputes live as the slider moves. Once a quote
  // is uploaded, its real price replaces our modeled system cost.
  const financing = useMemo(() => {
    if (!results) return null;
    const baseCost = quotedPrice ?? results.cost;
    const fee = dealerFeePercent / 100;
    const cash = cashPurchase(baseCost, results.cashFlow, fee);
    const loan = loanFinanced(baseCost, results.cashFlow, fee);
    const lease = leaseFinanced(results.cashFlow);
    return { cash, loan, lease, impact: dealerFeeImpact(loan) };
  }, [results, dealerFeePercent, quotedPrice]);

  // Highlight the option that leaves the most money in your pocket
  const bestFinancing = useMemo(() => {
    if (!financing) return null;
    const entries = [
      ['cash', financing.cash],
      ['loan', financing.loan],
      ['lease', financing.lease],
    ];
    return entries.reduce((best, entry) =>
      entry[1].summary.year25NetPosition > best[1].summary.year25NetPosition
        ? entry
        : best
    )[0];
  }, [financing]);

  return (
    <div className="page">
      <header className="topbar">
        <div className="logo">
          Solar <em>Sanity</em> Check
        </div>
        <nav className="nav">
          <button
            type="button"
            className={page === 'roof' ? 'active' : ''}
            onClick={() => setPage('roof')}
          >
            Your roof
          </button>
          <button
            type="button"
            className={page === 'money' ? 'active' : ''}
            onClick={() => setPage('money')}
          >
            Money
          </button>
        </nav>
        <div className={usingBill ? 'bill-chip' : 'bill-chip default'}>
          {usingBill ? '✓ Using your bill' : 'Using default estimates'}
        </div>
        <button
          type="button"
          className="theme-toggle"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
      </header>

      {page === 'roof' && (
        <>
      {/* Address — the first thing to fill in */}
      <form className="addr-form card" onSubmit={handleAddressSubmit}>
        <label htmlFor="address">
          <strong>Your address</strong>
          <span className="hint">We pull your roof and its solar potential from satellite data</span>
        </label>
        <div className="addr-row">
          <input
            id="address"
            type="text"
            value={addressInput}
            onChange={(e) => setAddressInput(e.target.value)}
            placeholder="Street, city, state"
            autoComplete="street-address"
          />
          <button type="submit" disabled={geocoding}>
            {geocoding ? 'Finding…' : 'Check my roof'}
          </button>
        </div>
        {addressError && <p className="addr-error">{addressError}</p>}
      </form>
        </>
      )}

      {page === 'money' && (
        <>
      {/* Uploads */}
      <div className="card">
        <div className="upload-row">
          <label className="upload">
            <strong>Electric bill</strong>
            <span className="hint">
              Image or PDF — personalizes usage and rate
            </span>
            <input
              type="file"
              accept="image/*,application/pdf"
              onChange={(e) =>
                handleUpload(e, extractBillData, setBillStatus, setBillData, setBillRawText)
              }
            />
            {billStatus && <p className="upload-status">{billStatus}</p>}
            {billData && (
              <p className="extracted">
                {billData.annualUsageKwh ?? '—'} kWh/yr ·{' '}
                {billData.electricityRate ?? '—'} $/kWh
              </p>
            )}
          </label>
          <label className="upload">
            <strong>Solar quote</strong>
            <span className="hint">
              Image or PDF — we check it against fair-market pricing
            </span>
            <input
              type="file"
              accept="image/*,application/pdf"
              onChange={(e) =>
                handleUpload(e, extractQuoteData, setQuoteStatus, setQuoteData, setQuoteRawText)
              }
            />
            {quoteStatus && <p className="upload-status">{quoteStatus}</p>}
          </label>
        </div>
        {billRawText && <pre className="raw">{billRawText}</pre>}
        {quoteRawText && <pre className="raw">{quoteRawText}</pre>}
      </div>

      {/* Quote analysis */}
      {quoteData && quoteAnalysis && (
        <>
          <p className="quote-headline">{quoteAnalysis.summary.headline}</p>
          {quoteWorth &&
            (() => {
              const evaluated = quoteWorth
                .map((w, i) => ({ w, label: quoteData[i].optionLabel ?? `Option ${i + 1}` }))
                .filter((e) => e.w);
              if (evaluated.length === 0) return null;
              const worthy = evaluated.filter((e) => e.w.worthIt);
              const best = (worthy.length > 0 ? worthy : evaluated).reduce((a, b) =>
                b.w.net25 > a.w.net25 ? b : a
              );
              const basis = usingBill ? 'your electric bill' : 'default usage estimates';
              return (
                <div className={best.w.worthIt ? 'worth worth-good' : 'worth worth-bad'}>
                  {best.w.worthIt
                    ? `Based on ${basis} and your roof, the ${best.label} option is worth it — it pays back in year ${best.w.paybackYear} and leaves you ${fmtMoney(best.w.net25)} ahead after 25 years.`
                    : `Based on ${basis} and your roof, none of these options is worth it — the best of them ${
                        best.w.paybackYear
                          ? `doesn't pay back until year ${best.w.paybackYear}`
                          : 'never pays back within 25 years'
                      } and ends ${fmtMoney(best.w.net25)} after 25 years.`}
                </div>
              );
            })()}
          {quoteData.map((opt, i) => {
            const analysis = quoteAnalysis.options[i];
            const isWorst =
              analysis.verdict === quoteAnalysis.summary.worstVerdict &&
              quoteAnalysis.summary.worstVerdict !== 'FAIR';
            return (
              <div
                key={opt.optionLabel ?? i}
                className={isWorst ? 'quote-option worst' : 'quote-option'}
              >
                <p className="title">
                  {opt.optionLabel ?? `Option ${i + 1}`}
                  <span
                    className={`chip-verdict ${QUOTE_CHIP_CLASS[analysis.verdict] ?? ''}`}
                  >
                    {analysis.verdict}
                  </span>
                </p>
                <p className="meta">
                  {opt.totalPrice != null ? `$${opt.totalPrice.toLocaleString()}` : '?'} ·{' '}
                  {opt.systemSizeKw ?? '?'} kW ·{' '}
                  {opt.pricePerWatt != null ? `$${opt.pricePerWatt.toFixed(2)}/W` : '?'}
                  {opt.loanApr != null && ` · ${(opt.loanApr * 100).toFixed(2)}% APR`}
                  {opt.loanTermYears != null && ` · ${opt.loanTermYears} yrs`}
                  {opt.dealerOrOriginationFee != null &&
                    ` · fee $${opt.dealerOrOriginationFee.toLocaleString()}`}
                </p>
                <ul>
                  {analysis.flags.map((flag) => (
                    <li key={flag}>{flag}</li>
                  ))}
                </ul>
                {analysis.fairPriceDelta != null && (
                  <p className="delta">
                    {analysis.fairPriceDelta > 0
                      ? `${fmtMoney(analysis.fairPriceDelta)} above fair-market price`
                      : 'At or below fair-market price'}
                  </p>
                )}
                {quoteWorth?.[i] && (
                  <p className="delta">
                    For you:{' '}
                    {quoteWorth[i].paybackYear != null
                      ? `pays back in year ${quoteWorth[i].paybackYear} · ${fmtMoney(quoteWorth[i].net25)} after 25 years`
                      : `never pays back within 25 years (${fmtMoney(quoteWorth[i].net25)})`}
                  </p>
                )}
              </div>
            );
          })}
        </>
      )}
      {!results && <p className="status-line">{status}</p>}
        </>
      )}

      {page === 'roof' && (
        <>
      {results ? (
        <>
          <div className={`verdict ${VERDICT_CLASS[results.verdict.rating] ?? ''}`}>
            <div className="big">
              {results.verdict.rating}{' '}
              <small>{VERDICT_TAGLINE[results.verdict.rating]}</small>
            </div>
            <ul>
              {results.verdict.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>

          <div className="stats">
            <div className="stat">
              <label>System size</label>
              <b>{results.sizeKw.toFixed(1)}</b>{' '}
              <small>kW · {results.panelsCount} panels</small>
            </div>
            <div className="stat">
              <label>Year-1 production</label>
              <b>{Math.round(results.year1Production).toLocaleString()}</b>{' '}
              <small>kWh</small>
            </div>
            <div className="stat">
              <label>25-yr net savings</label>
              <b>{fmtMoney(results.netSavings25)}</b>
            </div>
          </div>
        </>
      ) : (
        <p className="status-line">{status}</p>
      )}

      <RoofDesigner
        key={`${location.lat},${location.lng}${solarData ? '+data' : ''}`}
        lat={solarData?.center?.latitude ?? location.lat}
        lng={solarData?.center?.longitude ?? location.lng}
        panels={solarData?.solarPotential.solarPanels ?? []}
        panelWidthMeters={solarData?.solarPotential.panelWidthMeters}
        panelHeightMeters={solarData?.solarPotential.panelHeightMeters}
        roofSegments={solarData?.solarPotential.roofSegmentStats ?? []}
        activePanelIds={activePanelIds}
        onTogglePanel={togglePanel}
        onReset={() => setCustomPanelIds(null)}
        isCustomized={customPanelIds !== null}
        recommendedCount={recommendedCount}
        imageryDate={solarData?.imageryDate ?? null}
      />

      {results && (
        <>
          <h2>The details</h2>
          <div className="card details-card">
            <div className="details">
              <p>
                Active panels{' '}
                <b>
                  {results.panelsCount} of {results.maxArrayPanelsCount} max
                </b>
              </p>
              <p>
                System cost <b>{fmtMoney(results.cost)}</b>
              </p>
              <p>
                Payback year <b>{results.payback ?? 'Never (25 yrs)'}</b>
              </p>
              <p>
                Roof segments <b>{results.segmentCount}</b>
              </p>
              <p>
                Dominant orientation <b>{Math.round(results.dominantAzimuth)}° azimuth</b>
              </p>
              <p>
                Max sunshine{' '}
                <b>{Math.round(results.maxSunshineHoursPerYear).toLocaleString()} hrs/yr</b>
              </p>
            </div>
          </div>
        </>
      )}
        </>
      )}

      {page === 'money' && results && financing && (
            <>
              <h2>How you pay changes everything</h2>
              {quotedPrice != null && (
                <p className="extracted">
                  Using your quote's price ({fmtMoney(quotedPrice)}) instead of our{' '}
                  {fmtMoney(results.cost)} estimate
                </p>
              )}
              {dealerFeePercent > 0 && (
                <p className="extracted">
                  System: {fmtMoney(financing.cash.summary.baseCost)} → with dealer fee:{' '}
                  <strong>{fmtMoney(financing.cash.summary.effectiveCost)}</strong>
                </p>
              )}
              <div className="fin-grid">
                <FinancingColumn
                  title="Cash"
                  option={financing.cash}
                  best={bestFinancing === 'cash'}
                />
                <FinancingColumn
                  title="Loan"
                  option={financing.loan}
                  best={bestFinancing === 'loan'}
                  extra={
                    <p>
                      Monthly <b>{fmtMoney(financing.loan.rows[0].annualPayment / 12)}</b>
                    </p>
                  }
                />
                <FinancingColumn
                  title="Lease"
                  option={financing.lease}
                  best={bestFinancing === 'lease'}
                  extra={
                    <span className="note">
                      Never owned — panels belong to the lessor
                    </span>
                  }
                />
              </div>

              <div className="fee-box">
                <label>
                  Dealer fee: <strong>{dealerFeePercent}%</strong>{' '}
                  <input
                    type="range"
                    min="0"
                    max={MAX_DEALER_FEE_PCT * 100}
                    step="1"
                    value={dealerFeePercent}
                    onChange={(e) => setDealerFeePercent(Number(e.target.value))}
                  />
                </label>
                <p className="fee-impact">
                  {dealerFeePercent === 0
                    ? 'No dealer fee — you keep every dollar of these savings.'
                    : `A ${dealerFeePercent}% dealer fee adds ${financing.impact.addedPaybackYears} year${financing.impact.addedPaybackYears === 1 ? '' : 's'} to your payback and costs you ${fmtMoney(financing.impact.lifetimeSavingsLost)} in lifetime savings.`}
                </p>
                <p className="fee-note">
                  Dealer fees can add up to {MAX_DEALER_FEE_PCT * 100}% to your cost — financing options with no
                  dealer fee (like ethical solar lenders) protect these savings.
                </p>
              </div>
            </>
      )}
    </div>
  );
}

export default App;
