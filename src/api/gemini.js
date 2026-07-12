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

// Runs a prompt against an uploaded file and parses the model's JSON reply.
// Returns { data } on success, or { raw } with the unparsed text when the
// model didn't return valid JSON (so the UI can show it).
async function extractFromFile(file, prompt) {
  const base64 = await fileToBase64(file);
  const raw = await generateContent([
    { text: prompt },
    { inline_data: { mime_type: file.type, data: base64 } },
  ]);

  // Strip accidental ```json fences before parsing
  const cleaned = raw
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  try {
    return { data: JSON.parse(cleaned) };
  } catch {
    return { raw };
  }
}

export async function extractBillData(file) {
  return extractFromFile(file, BILL_PROMPT);
}

const QUOTE_PROMPT = `You are reading a solar installer's quote or proposal. It may contain one or several pricing/financing options. Return ONLY strict JSON — no markdown, no code fences, no prose — as an ARRAY with one element per option found (typically 1-3). If only one option exists, return a single-element array. Each element must have exactly this shape:
[
  {
    "optionLabel": string,
    "totalPrice": number,
    "systemSizeKw": number,
    "pricePerWatt": number,
    "loanApr": number,
    "loanTermYears": number,
    "dealerOrOriginationFee": number
  }
]

Rules for each option:
- optionLabel: a short name for the option as the quote presents it (e.g. "Cash", "Option B - 25yr loan", "Premium package"). If unnamed, invent a brief descriptive label.
- totalPrice: total system price in dollars for that option.
- systemSizeKw: system size in kW.
- pricePerWatt: $/W. If not stated directly, compute totalPrice / (systemSizeKw * 1000).
- loanApr: the loan interest rate as a decimal (e.g. 8.9% -> 0.089). null if the option is not financed or no rate is stated.
- loanTermYears: loan term in years. null if not stated.
- dealerOrOriginationFee: any dealer fee, origination fee, or financing fee in dollars. null if not stated.
- Use null for any field that cannot be found (except pricePerWatt, which should be computed from totalPrice and systemSizeKw when possible).`;

export async function extractQuoteData(file) {
  const result = await extractFromFile(file, QUOTE_PROMPT);
  // Expect an array of options; tolerate a bare object by wrapping it
  if (result.data !== undefined && !Array.isArray(result.data)) {
    result.data = [result.data];
  }
  return result;
}
