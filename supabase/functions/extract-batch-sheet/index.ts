/**
 * Supabase Edge Function: extract-batch-sheet
 *
 * Acts as a server-side proxy for the NVIDIA Llama 3.2 Vision 90B API,
 * bypassing browser CORS restrictions.
 *
 * POST  { image: "data:image/jpeg;base64,..." }
 * → 200 { batchNo, finalGravity, readings[], processInfo, summary, notes }
 *
 * Deploy:
 *   supabase functions deploy extract-batch-sheet --no-verify-jwt
 * Secret:
 *   supabase secrets set NVIDIA_API_KEY=nvapi-...
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { nvidiaChat } from '../_shared/nvidiaVision.ts';

// ── CORS headers (allow all origins — internal factory tool) ──────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ── Extraction prompt (same as client-side, kept here as the authoritative copy)
const EXTRACTION_PROMPT = `You are a precise OCR assistant for a CP (Chlorinated Paraffin) manufacturing plant in India.

Carefully read and extract ALL handwritten data from this batch log sheet image.
Return ONLY a valid JSON object — no markdown fences, no explanation, just JSON.

SHEET SECTIONS:
1. HEADER: the printed COMPANY / FIRM name at the very top of the sheet (e.g. "Madan Chemicals Pvt Ltd Unit-II" → "Madan Chemicals Pvt Ltd"), the "BATCH NO." value (e.g. "P-701" or "1228") and "FINAL GRAVITY" value (number, e.g. 1305)

2. MAIN TABLE — extract every row that has any data written. Columns:
   - DATE: format DD/MM/YY (e.g. "25/07/26")
   - TIME: e.g. "2:00 pm", "10 PM", "2 AM"
   - TEMP: integer °C
   - CP GRAVITY: integer
   - Cl2 pressure: string preserving units, e.g. "800", "800g", "1.0", "1kg"
   - Cl2 Pipe Line Pressure: string, e.g. "2000", "2.0kg", "2kg" or "-"
   - HCL GRAVITY: integer or null. "F", "f", or "t" means full/same — use null
   - OPERATOR: handwritten name

3. PROCESS INFO (below the main table / NOTE block):
   OIL TIME, DATE, TEMP, Cl2 Starting Time, TEMP, FRR TIME, TEMP, PRESSURE, TOTAL BATCH TIME

4. BOTTOM SUMMARY (two-column layout) — extract EVERY field:
   Left: TYPE OF OIL, Reactor Air Purging (Temp/Start Time/End Time), Cooling stop temp,
         Degasser Air Purging (Start/End), Paraffin Weight, HS Used, Filling In-charge, HCL Quantity
   Right: Melter No./Temp, Degasser No., Opening Balance, Total Drums Filled, Closing Balance,
          Brightener, Helper, Operator, Free Cl2, OIL CON RATIO/Kg CP (number in grams if present),
          Sp. Gravity/temp (as string e.g. "1305 / 30°C"), Technical

Return this EXACT JSON (no extra keys, all values exactly typed as shown):
{
  "batchNo": "string",
  "companyName": "string_or_null",
  "finalGravity": number_or_null,
  "readings": [
    {
      "date": "DD/MM/YY",
      "time": "H AM/PM",
      "temp": number_or_null,
      "cpGravity": number_or_null,
      "cl2Pressure": "string_or_null",
      "cl2PipeLinePressure": "string_or_null",
      "hclGravity": number_or_null,
      "operator": "string_or_null"
    }
  ],
  "processInfo": {
    "oilTime": "string_or_null",
    "oilDate": "string_or_null",
    "oilTemp": number_or_null,
    "cl2StartingTime": "string_or_null",
    "cl2StartingTemp": number_or_null,
    "frrTime": "string_or_null",
    "frrTemp": number_or_null,
    "frrPressure": "string_or_null",
    "totalBatchTime": "string_or_null",
    "pressure": "string_or_null"
  },
  "summary": {
    "typeOfOil": "string_or_null",
    "melterNo": "string_or_null",
    "degasserNo": "string_or_null",
    "openingBalance": number_or_null,
    "totalDrumsFilled": number_or_null,
    "closingBalance": number_or_null,
    "helper": "string_or_null",
    "operator": "string_or_null",
    "paraffinWeight": number_or_null,
    "hclQuantity": number_or_null,
    "reactorAirPurgingTemp": number_or_null,
    "reactorAirPurgingStartTime": "string_or_null",
    "reactorAirPurgingEndTime": "string_or_null",
    "coolingStopTemp": number_or_null,
    "degasserAirPurgingStartTime": "string_or_null",
    "degasserAirPurgingEndTime": "string_or_null",
    "hsUsed": number_or_null,
    "brightener": "string_or_null",
    "freeCl2": "string_or_null",
    "oilConRatio": number_or_null,
    "fillingInCharge": "string_or_null",
    "spGravityTemp": "string_or_null",
    "technical": "string_or_null"
  },
  "notes": "any NOTE text from the sheet, or empty string"
}`;

/** Cap base64 payload size. Oversized images OOM the Edge worker before NVIDIA returns. */
function truncateDataUrl(image: string, maxChars: number): string {
  if (image.length <= maxChars) return image;
  // Prefer keeping a valid data-URL prefix; if still too long, send as-is truncated
  // (NVIDIA will reject invalid base64 — better than worker crash).
  console.warn('[extract-batch-sheet] Truncating image from', image.length, 'to', maxChars);
  return image.slice(0, maxChars);
}

// ── Handler ────────────────────────────────────────────────────────────────────
serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  try {
    console.log('[extract-batch-sheet] Request received at', new Date().toISOString());
    const body = await req.json().catch(() => null);
    const image: string | undefined = body?.image;
    console.log('[extract-batch-sheet] Image data URL length:', image?.length ?? 0);

    if (!image || typeof image !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Request body must be JSON with an "image" field (data URL or base64).' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    const apiKey = Deno.env.get('NVIDIA_API_KEY');
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'NVIDIA_API_KEY secret is not set on this Edge Function. Run: supabase secrets set NVIDIA_API_KEY=nvapi-...' }),
        { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    // Shrink huge data-URLs so the Edge worker stays under memory limits.
    // Client already resizes, but PDFs / high-res cameras still blow the 90B path.
    const imageForModel = truncateDataUrl(image, 900_000);
    console.log('[extract-batch-sheet] Image for model length:', imageForModel.length);

    // Prefer 11B vision (fits Edge memory). Override with NVIDIA_OCR_MODEL secret.
    let content: string;
    let usedModel: string;
    try {
      const r = await nvidiaChat({
        apiKey,
        fallbackModel: 'meta/llama-3.2-11b-vision-instruct',
        maxTokens: 2048,
        jsonMode: true,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: EXTRACTION_PROMPT },
              { type: 'image_url', image_url: { url: imageForModel, detail: 'low' } },
            ],
          },
        ],
      });
      content = r.content;
      usedModel = r.model;
    } catch (e) {
      return new Response(
        JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
        { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    if (!content) {
      return new Response(
        JSON.stringify({ error: `NVIDIA API returned an empty response (model ${usedModel}).` }),
        { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    // ── Robust JSON extraction ───────────────────────────────────────────────
    // The model sometimes wraps output in markdown (e.g. "**JSON Object:**\n```json\n{...}\n```")
    // Instead of fragile regex stripping, find the outermost { ... } in the raw text.
    console.log('[extract-batch-sheet] Raw content length:', content.length);
    console.log('[extract-batch-sheet] Content preview:', content.slice(0, 200));

    const firstBrace = content.indexOf('{');
    const lastBrace  = content.lastIndexOf('}');

    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      console.error('[extract-batch-sheet] No JSON object found in response');
      return new Response(
        JSON.stringify({
          error: `AI response contained no JSON object. Preview: ${content.slice(0, 300)}`,
        }),
        { status: 422, headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    const jsonSlice = content.slice(firstBrace, lastBrace + 1);
    let extracted: unknown;
    try {
      extracted = JSON.parse(jsonSlice);
      console.log('[extract-batch-sheet] Successfully parsed JSON, batchNo:', (extracted as any)?.batchNo);
    } catch (parseErr) {
      console.error('[extract-batch-sheet] JSON.parse failed:', String(parseErr));
      console.error('[extract-batch-sheet] Attempted to parse:', jsonSlice.slice(0, 400));
      return new Response(
        JSON.stringify({
          error: `JSON parse failed after extraction. Preview: ${jsonSlice.slice(0, 300)}`,
        }),
        { status: 422, headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    return new Response(JSON.stringify(extracted), {
      status: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});
