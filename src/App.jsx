import { TEST_ADDRESS } from './fixtures/testAddress';

function App() {
  const solarKeyLoaded = Boolean(import.meta.env.VITE_SOLAR_KEY);
  const geminiKeyLoaded = Boolean(import.meta.env.VITE_GEMINI_API_KEY);

  return (
    <div style={{ maxWidth: 720, margin: '2rem auto', fontFamily: 'system-ui' }}>
      <h1>Solar Sanity-Check</h1>

      {/* Temporary wiring check — delete once both show ✅ */}
      <p>Solar key loaded: {solarKeyLoaded ? '✅' : '❌'}</p>
      <p>Gemini key loaded: {geminiKeyLoaded ? '✅' : '❌'}</p>
      <p>Test address: {TEST_ADDRESS.lat}, {TEST_ADDRESS.lng}</p>

      <div id="results">{/* results render here later */}</div>
    </div>
  );
}

export default App;