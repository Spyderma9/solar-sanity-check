import { useEffect, useMemo, useState } from 'react';
import { TEST_ADDRESS } from './fixtures/testAddress';
import { getBuildingInsights } from './api/solar';
import { callGemini, extractBillData } from './api/gemini';
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

  // Re-runs automatically when the solar data loads or a bill is extracted
  const results = useMemo(() => {
    if (!solarData) return null;

    const {
      panelCapacityWatts,
      solarPanelConfigs,
      maxArrayPanelsCount,
      roofSegmentStats,
      maxSunshineHoursPerYear,
    } = solarData.solarPotential;

    const annualUsageKwh = billData?.annualUsageKwh ?? ANNUAL_USAGE_KWH;
    const electricityRate = billData?.electricityRate ?? ELECTRICITY_RATE;

    const config = pickBestConfig(solarPanelConfigs, annualUsageKwh);
    const cashFlow = buildCashFlow(config, panelCapacityWatts, {
      annualUsageKwh,
      electricityRate,
    });
    const cost = systemCost(config.panelsCount, panelCapacityWatts);

    const largestSegment = roofSegmentStats.reduce((best, s) =>
      s.stats.areaMeters2 > best.stats.areaMeters2 ? s : best
    );

    const payback = paybackYear(cashFlow, cost);
    const netSavings25 = cashFlow[cashFlow.length - 1].cumulativeSavings;

    const verdict = getVerdict({
      paybackYear: payback,
      netSavings25yr: netSavings25,
      dominantAzimuth: largestSegment.azimuthDegrees,
      maxSunshineHoursPerYear,
      electricityRate,
    });

    return {
      panelsCount: config.panelsCount,
      maxArrayPanelsCount,
      sizeKw: systemSizeKw(config.panelsCount, panelCapacityWatts),
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
  }, [solarData, billData]);

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
            <p>Recommended panels: {results.panelsCount} (roof max: {results.maxArrayPanelsCount})</p>
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