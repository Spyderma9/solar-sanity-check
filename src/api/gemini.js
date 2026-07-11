const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent';

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000; // 1s, 2s, 4s

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateContent(parts) {
  let attempt = 0;

  for (;;) {
    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': import.meta.env.VITE_GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { temperature: 0 },
      }),
    });

    if (response.status === 429 && attempt < MAX_RETRIES) {
      await sleep(BASE_BACKOFF_MS * 2 ** attempt);
      attempt++;
      continue;
    }

    if (!response.ok) {
      throw new Error(`Gemini API request failed with HTTP status ${response.status}`);
    }

    const data = await response.json();
    return data.candidates[0].content.parts[0].text;
  }
}

export async function callGemini(promptText) {
  return generateContent([{ text: promptText }]);
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // result looks like "data:application/pdf;base64,JVBERi..." — strip the prefix
      resolve(reader.result.split(',')[1]);
    };
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

const BILL_PROMPT = `You are reading an electric utility bill. Return ONLY strict JSON — no markdown, no code fences, no prose — in exactly this shape:
{ "annualUsageKwh": number, "electricityRate": number }

Rules:
- annualUsageKwh: the household's yearly electricity use in kWh.
  - If the bill includes a usage history chart or table, sum EXACTLY the most
    recent 12 monthly values. Charts often show 13 months — if so, drop the
    oldest bar and sum only the latest 12.
  - Only if there is no usage history at all, take the single billing period's
    kWh and multiply by 12.
- electricityRate: the effective price in $/kWh for the current billing period,
  computed as total current charges divided by kWh used this period, unless an
  all-in rate is explicitly stated.
- If a value cannot be found, use null for that field.`;

export async function extractBillData(file) {
  const base64 = await fileToBase64(file);
  const raw = await generateContent([
    { text: BILL_PROMPT },
    { inline_data: { mime_type: file.type, data: base64 } },
  ]);
  return raw;
}
