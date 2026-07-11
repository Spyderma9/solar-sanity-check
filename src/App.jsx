import { useEffect, useMemo, useState } from 'react';
import { TEST_ADDRESS } from './fixtures/testAddress';
import { getBuildingInsights } from './api/solar';
import { callGemini, extractBillData, extractQuoteData } from './api/gemini';
import {
  ANNUAL_USAGE_KWH,
  ELECTRICITY_RATE,
  pickBestConfig,
  systemSizeKw,
  buildCashFlow,
  systemCost,
  paybackYear,
} from './lib/financials';
import { getVerdict } from './lib/verdict';
import {
  cashPurchase,
  loanFinanced,
  leaseFinanced,
  dealerFeeImpact,
} from './lib/financing';
import { analyzeQuotes } from './lib/quoteCheck';
import RoofDesigner from './RoofDesigner';

function friendlyError(message) {
  if (message.includes('403')) {
    return 'Error 403 — check billing/key';
  }
  if (message.includes('404') || message.includes('NOT_FOUND')) {
    return 'No solar data for this building';
  }
  return `Error: ${message}`;
}

// High-contrast badge colors (white text on all three)
const VERDICT_COLORS = {
  GOOD: '#1a7f37', // green
  MARGINAL: '#b35900', // amber, dark enough for white text
  NO: '#c62828', // red
};

const fmtMoney = (n) =>
  (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString();

// Quote verdict colors (same palette as the main verdict badge)
const QUOTE_VERDICT_COLORS = {
  FAIR: '#1a7f37',
  OVERPRICED: '#b35900',
  PREDATORY: '#c62828',
};

function FinancingColumn({ title, option, extra }) {
  return (
    <div style={{ flex: 1, border: '1px solid #ccc', borderRadius: 8, padding: '0.75rem' }}>
      <h3 style={{ margin: '0 0 0.5rem' }}>{title}</h3>
      <p>Upfront: {fmtMoney(option.summary.upfrontCost)}</p>
      <p>Payback: {option.summary.paybackYear ? `${option.summary.paybackYear} years` : 'never (25 yrs)'}</p>
      <p>25-yr net: {fmtMoney(option.summary.year25NetPosition)}</p>
      {extra}
    </div>
  );
}

function App() {
  const solarKeyLoaded = Boolean(import.meta.env.VITE_SOLAR_KEY);
  const geminiKeyLoaded = Boolean(import.meta.env.VITE_GEMINI_API_KEY);
  const [status, setStatus] = useState('Loading…');
  const [solarData, setSolarData] = useState(null);
  const [geminiResult, setGeminiResult] = useState('');

  async function testGemini() {
    setGeminiResult('Calling Gemini…');
    try {
      const text = await callGemini('Say hello in one word.');
      setGeminiResult(text);
    } catch (err) {
      setGeminiResult(`Error: ${err.message}`);
    }
  }

  const [billStatus, setBillStatus] = useState('');
  const [billData, setBillData] = useState(null); // parsed { annualUsageKwh, electricityRate }
  const [billRawText, setBillRawText] = useState(''); // shown only if JSON parsing fails

  async function handleBillUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    setBillStatus('Extracting…');
    setBillData(null);
    setBillRawText('');

    try {
      const raw = await extractBillData(file);
      console.log('Raw Gemini bill response:', raw);

      // Strip accidental ```json fences before parsing
      const cleaned = raw
        .replace(/^\s*```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .trim();

      try {
        const parsed = JSON.parse(cleaned);
        setBillData(parsed);
        setBillStatus('Extracted');
      } catch {
        setBillStatus('Could not parse JSON — raw response below:');
        setBillRawText(raw);
      }
    } catch (err) {
      setBillStatus(`Error: ${err.message}`);
    }
  }

  const [quoteStatus, setQuoteStatus] = useState('');
  const [quoteData, setQuoteData] = useState(null); // parsed quote fields
  const [quoteRawText, setQuoteRawText] = useState(''); // shown only if JSON parsing fails

  async function handleQuoteUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    setQuoteStatus('Extracting…');
    setQuoteData(null);
    setQuoteRawText('');

    try {
      const raw = await extractQuoteData(file);
      console.log('Raw Gemini quote response:', raw);

      // Strip accidental ```json fences before parsing
      const cleaned = raw
        .replace(/^\s*```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .trim();

      try {
        const parsed = JSON.parse(cleaned);
        // Expect an array of options; tolerate a bare object by wrapping it
        setQuoteData(Array.isArray(parsed) ? parsed : [parsed]);
        setQuoteStatus('Extracted');
      } catch {
        setQuoteStatus('Could not parse JSON — raw response below:');
        setQuoteRawText(raw);
      }
    } catch (err) {
      setQuoteStatus(`Error: ${err.message}`);
    }
  }

  // Judge all extracted quote options (pure; re-runs when a new quote is parsed)
  const quoteAnalysis = useMemo(
    () => (quoteData ? analyzeQuotes(quoteData) : null),
    [quoteData]
  );

  useEffect(() => {
    getBuildingInsights(TEST_ADDRESS.lat, TEST_ADDRESS.lng)
      .then((data) => {
        console.log(data);
        setSolarData(data);
        setStatus('Loaded');
      })
      .catch((err) => {
        setStatus(friendlyError(err.message));
      });
  }, []);

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

    const {
      panelCapacityWatts,
      solarPanels,
      maxArrayPanelsCount,
      roofSegmentStats,
      maxSunshineHoursPerYear,
    } = solarData.solarPotential;

    const annualUsageKwh = billData?.annualUsageKwh ?? ANNUAL_USAGE_KWH;
    const electricityRate = billData?.electricityRate ?? ELECTRICITY_RATE;

    const panelsCount = activePanelIds.size;
    const yearlyEnergyDcKwh = [...activePanelIds].reduce(
      (sum, i) => sum + (solarPanels[i]?.yearlyEnergyDcKwh ?? 0),
      0
    );

    const cashFlow = buildCashFlow({ yearlyEnergyDcKwh }, panelCapacityWatts, {
      annualUsageKwh,
      electricityRate,
    });
    const cost = systemCost(panelsCount, panelCapacityWatts);

    const largestSegment = roofSegmentStats.reduce((best, s) =>
      s.stats.areaMeters2 > best.stats.areaMeters2 ? s : best
    );

    // With zero panels there is no system: cost 0 would trivially "pay back"
    // in year 1, so force the never-pays-back path instead
    const payback = panelsCount === 0 ? null : paybackYear(cashFlow, cost);
    const netSavings25 = cashFlow[cashFlow.length - 1].cumulativeSavings;

    const verdict = getVerdict({
      paybackYear: payback,
      netSavings25yr: netSavings25,
      dominantAzimuth: largestSegment.azimuthDegrees,
      maxSunshineHoursPerYear,
      electricityRate,
    });

    return {
      panelsCount,
      maxArrayPanelsCount,
      sizeKw: systemSizeKw(panelsCount, panelCapacityWatts),
      year1Production: cashFlow[0].production,
      cost,
      cashFlow,
      payback,
      netSavings25,
      segmentCount: roofSegmentStats.length,
      dominantAzimuth: largestSegment.azimuthDegrees,
      maxSunshineHoursPerYear,
      verdict,
    };
  }, [solarData, billData, activePanelIds]);

  // Dealer-fee slider (0–30%), stored as a whole percent for clean stepping
  const [dealerFeePercent, setDealerFeePercent] = useState(0);

  // Financing comparison — recomputes live as the slider moves
  const financing = useMemo(() => {
    if (!results) return null;
    const fee = dealerFeePercent / 100;
    const cash = cashPurchase(results.cost, results.cashFlow, fee);
    const loan = loanFinanced(results.cost, results.cashFlow, fee);
    const lease = leaseFinanced(results.cashFlow);
    return { cash, loan, lease, impact: dealerFeeImpact(loan) };
  }, [results, dealerFeePercent]);

  return (
    <div style={{ maxWidth: 720, margin: '2rem auto', fontFamily: 'system-ui' }}>
      <h1>Solar Sanity-Check</h1>

      {/* Temporary wiring check — delete once both show ✅ */}
      <p>Solar key loaded: {solarKeyLoaded ? '✅' : '❌'}</p>
      <p>Gemini key loaded: {geminiKeyLoaded ? '✅' : '❌'}</p>
      <p>Test address: {TEST_ADDRESS.lat}, {TEST_ADDRESS.lng}</p>

      {/* Temporary Gemini wiring check — delete once confirmed */}
      <p>
        <button onClick={testGemini}>Test Gemini</button>{' '}
        {geminiResult && <span>Gemini says: {geminiResult}</span>}
      </p>

      {/* Electric bill upload + extraction */}
      <div>
        <label>
          Upload electric bill (image or PDF):{' '}
          <input
            type="file"
            accept="image/*,application/pdf"
            onChange={handleBillUpload}
          />
        </label>
        {billStatus && <p>{billStatus}</p>}
        {billData && (
          <>
            <p>Annual usage: {billData.annualUsageKwh ?? 'not found'} kWh</p>
            <p>Electricity rate: {billData.electricityRate ?? 'not found'} $/kWh</p>
          </>
        )}
        {billRawText && <pre style={{ whiteSpace: 'pre-wrap' }}>{billRawText}</pre>}
      </div>

      {/* Solar quote upload + extraction (no flagging yet) */}
      <div>
        <label>
          Upload solar quote (image or PDF):{' '}
          <input
            type="file"
            accept="image/*,application/pdf"
            onChange={handleQuoteUpload}
          />
        </label>
        {quoteStatus && <p>{quoteStatus}</p>}
        {quoteData && quoteAnalysis && (
          <>
            <p style={{ fontSize: '1.15rem', fontWeight: 700 }}>
              {quoteAnalysis.summary.headline}
            </p>
            {quoteData.map((opt, i) => {
              const analysis = quoteAnalysis.options[i];
              const isWorst =
                analysis.verdict === quoteAnalysis.summary.worstVerdict &&
                quoteAnalysis.summary.worstVerdict !== 'FAIR';
              return (
                <div
                  key={opt.optionLabel ?? i}
                  style={{
                    marginBottom: '0.75rem',
                    padding: '0.75rem',
                    borderRadius: 8,
                    border: isWorst ? '3px solid #c62828' : '1px solid #ccc',
                  }}
                >
                  <p style={{ fontWeight: 700, margin: '0 0 0.25rem' }}>
                    {opt.optionLabel ?? `Option ${i + 1}`}{' '}
                    <span
                      style={{
                        background: QUOTE_VERDICT_COLORS[analysis.verdict],
                        color: '#fff',
                        borderRadius: 4,
                        padding: '0.1rem 0.5rem',
                        marginLeft: '0.5rem',
                      }}
                    >
                      {analysis.verdict}
                    </span>
                  </p>
                  <p style={{ margin: '0.25rem 0', color: '#555' }}>
                    {opt.totalPrice != null ? `$${opt.totalPrice.toLocaleString()}` : '?'} ·{' '}
                    {opt.systemSizeKw ?? '?'} kW ·{' '}
                    {opt.pricePerWatt != null ? `$${opt.pricePerWatt.toFixed(2)}/W` : '?'}
                    {opt.loanApr != null && ` · ${(opt.loanApr * 100).toFixed(2)}% APR`}
                    {opt.loanTermYears != null && ` · ${opt.loanTermYears} yrs`}
                    {opt.dealerOrOriginationFee != null &&
                      ` · fee $${opt.dealerOrOriginationFee.toLocaleString()}`}
                  </p>
                  <ul style={{ margin: '0.25rem 0 0.25rem 1.25rem' }}>
                    {analysis.flags.map((flag) => (
                      <li key={flag}>{flag}</li>
                    ))}
                  </ul>
                  {analysis.fairPriceDelta != null && (
                    <p style={{ margin: '0.25rem 0 0' }}>
                      {analysis.fairPriceDelta > 0
                        ? `${fmtMoney(analysis.fairPriceDelta)} above fair-market price`
                        : 'At or below fair-market price'}
                    </p>
                  )}
                </div>
              );
            })}
          </>
        )}
        {quoteRawText && <pre style={{ whiteSpace: 'pre-wrap' }}>{quoteRawText}</pre>}
      </div>

      <RoofDesigner
        key={solarData ? 'center' : 'fallback'}
        lat={solarData?.center?.latitude ?? TEST_ADDRESS.lat}
        lng={solarData?.center?.longitude ?? TEST_ADDRESS.lng}
        panels={solarData?.solarPotential.solarPanels ?? []}
        panelWidthMeters={solarData?.solarPotential.panelWidthMeters}
        panelHeightMeters={solarData?.solarPotential.panelHeightMeters}
        roofSegments={solarData?.solarPotential.roofSegmentStats ?? []}
        activePanelIds={activePanelIds}
        onTogglePanel={togglePanel}
        onReset={() => setCustomPanelIds(null)}
        isCustomized={customPanelIds !== null}
      />
      {results && (
        <p style={{ fontWeight: 700 }}>
          {results.panelsCount} active panels · {results.sizeKw.toFixed(1)} kW ·{' '}
          {Math.round(results.year1Production).toLocaleString()} kWh/yr
          {recommendedCount != null && ` (recommended: ${recommendedCount})`}
        </p>
      )}

      <div id="results">
        {results ? (
          <>
            <p style={{ fontWeight: 700 }}>
              {usingBill
                ? '📄 Using your bill'
                : 'Using default estimates (upload a bill to personalize)'}
            </p>
            <div
              style={{
                background: VERDICT_COLORS[results.verdict.rating] ?? '#333',
                color: '#fff',
                borderRadius: 8,
                padding: '1rem 1.5rem',
                margin: '1rem 0',
              }}
            >
              <div style={{ fontSize: '3rem', fontWeight: 800, letterSpacing: 2 }}>
                {results.verdict.rating}
              </div>
              <ul style={{ fontSize: '1.25rem', margin: '0.5rem 0 0', paddingLeft: '1.5rem' }}>
                {results.verdict.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>

            <h2>Results</h2>
            <p>Active panels: {results.panelsCount} (roof max: {results.maxArrayPanelsCount})</p>
            <p>System size: {results.sizeKw.toFixed(1)} kW</p>
            <p>Year-1 production: {Math.round(results.year1Production).toLocaleString()} kWh</p>
            <p>System cost: ${results.cost.toLocaleString()}</p>
            <p>Payback year: {results.payback ?? 'Never (within 25 years)'}</p>
            <p>25-year net savings: ${Math.round(results.netSavings25).toLocaleString()}</p>

            <h2>Roof summary</h2>
            <p>Roof segments: {results.segmentCount}</p>
            <p>Dominant orientation: {Math.round(results.dominantAzimuth)}° azimuth</p>
            <p>Max sunshine: {Math.round(results.maxSunshineHoursPerYear).toLocaleString()} hours/year</p>

            {financing && (
              <>
                <h2>How you pay changes everything</h2>
                {dealerFeePercent > 0 && (
                  <p>
                    System: {fmtMoney(financing.cash.summary.baseCost)} → With dealer fee:{' '}
                    <strong>{fmtMoney(financing.cash.summary.effectiveCost)}</strong>
                  </p>
                )}
                <div style={{ display: 'flex', gap: '0.75rem' }}>
                  <FinancingColumn title="Cash" option={financing.cash} />
                  <FinancingColumn title="Loan"
                    option={financing.loan}
                    extra={<p>Monthly: {fmtMoney(financing.loan.rows[0].annualPayment / 12)}</p>}
                  />
                  <FinancingColumn title="Lease" option={financing.lease}
                    extra={<p style={{ color: '#555', fontStyle: 'italic' }}>Never owned — panels belong to the lessor</p>}
                  />
                </div>

                <div style={{ margin: '1rem 0' }}>
                  <label>
                    Dealer fee: <strong>{dealerFeePercent}%</strong>{' '}
                    <input
                      type="range"
                      min="0"
                      max="30"
                      step="1"
                      value={dealerFeePercent}
                      onChange={(e) => setDealerFeePercent(Number(e.target.value))}
                      style={{ width: 240, verticalAlign: 'middle' }}
                    />
                  </label>
                  <p style={{ fontSize: '1.15rem', fontWeight: 700 }}>
                    {dealerFeePercent === 0
                      ? 'No dealer fee — you keep every dollar of these savings.'
                      : `A ${dealerFeePercent}% dealer fee adds ${financing.impact.addedPaybackYears} year${financing.impact.addedPaybackYears === 1 ? '' : 's'} to your payback and costs you ${fmtMoney(financing.impact.lifetimeSavingsLost)} in lifetime savings.`}
                  </p>
                  <p style={{ color: '#555' }}>
                    Dealer fees can add up to 30% to your cost — financing options with no
                    dealer fee (like ethical solar lenders) protect these savings.
                  </p>
                </div>
              </>
            )}
          </>
        ) : (
          status
        )}
      </div>
    </div>
  );
}

export default App;