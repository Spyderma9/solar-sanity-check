import { useEffect, useState } from 'react';
import { TEST_ADDRESS } from './fixtures/testAddress';
import { getBuildingInsights } from './api/solar';
import {
  ANNUAL_USAGE_KWH,
  pickBestConfig,
  systemSizeKw,
  buildCashFlow,
  systemCost,
  paybackYear,
} from './lib/financials';

function friendlyError(message) {
  if (message.includes('403')) {
    return 'Error 403 — check billing/key';
  }
  if (message.includes('404') || message.includes('NOT_FOUND')) {
    return 'No solar data for this building';
  }
  return `Error: ${message}`;
}

function App() {
  const solarKeyLoaded = Boolean(import.meta.env.VITE_SOLAR_KEY);
  const geminiKeyLoaded = Boolean(import.meta.env.VITE_GEMINI_API_KEY);
  const [status, setStatus] = useState('Loading…');
  const [results, setResults] = useState(null);

  useEffect(() => {
    getBuildingInsights(TEST_ADDRESS.lat, TEST_ADDRESS.lng)
      .then((data) => {
        console.log(data);

        const {
          panelCapacityWatts,
          solarPanelConfigs,
          maxArrayPanelsCount,
          roofSegmentStats,
          maxSunshineHoursPerYear,
        } = data.solarPotential;

        const config = pickBestConfig(solarPanelConfigs, ANNUAL_USAGE_KWH);
        const cashFlow = buildCashFlow(config, panelCapacityWatts);
        const cost = systemCost(config.panelsCount, panelCapacityWatts);

        const largestSegment = roofSegmentStats.reduce((best, s) =>
          s.stats.areaMeters2 > best.stats.areaMeters2 ? s : best
        );

        setResults({
          panelsCount: config.panelsCount,
          maxArrayPanelsCount,
          sizeKw: systemSizeKw(config.panelsCount, panelCapacityWatts),
          year1Production: cashFlow[0].production,
          cost,
          payback: paybackYear(cashFlow, cost),
          netSavings25: cashFlow[cashFlow.length - 1].cumulativeSavings,
          segmentCount: roofSegmentStats.length,
          dominantAzimuth: largestSegment.azimuthDegrees,
          maxSunshineHoursPerYear,
        });
        setStatus('Loaded');
      })
      .catch((err) => {
        setStatus(friendlyError(err.message));
      });
  }, []);

  return (
    <div style={{ maxWidth: 720, margin: '2rem auto', fontFamily: 'system-ui' }}>
      <h1>Solar Sanity-Check</h1>

      {/* Temporary wiring check — delete once both show ✅ */}
      <p>Solar key loaded: {solarKeyLoaded ? '✅' : '❌'}</p>
      <p>Gemini key loaded: {geminiKeyLoaded ? '✅' : '❌'}</p>
      <p>Test address: {TEST_ADDRESS.lat}, {TEST_ADDRESS.lng}</p>

      <div id="results">
        {results ? (
          <>
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
          </>
        ) : (
          status
        )}
      </div>
    </div>
  );
}

export default App;