/**
 * Supabase Edge Function: check-photo
 *
 * Looks at one batch-wizard photo and says whether it matches the slot.
 * The Gemini key stays here. The browser only sends the picture and the slot.
 *
 * POST { image: "data:image/jpeg;base64,...", kind: "sheet" | "bucket" | "heat" }
 * → 200 { ok: boolean, reason: string }
 *
 * Deploy:
 *   supabase functions deploy check-photo --no-verify-jwt
 * Secret:
 *   supabase secrets set GEMINI_API_KEY=...
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

declare const Deno: { env: { get(k: string): string | undefined } };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type Kind = 'sheet' | 'bucket' | 'heat';

const EXPECTED: Record<Kind, string> = {
  sheet: 'batch_sheet',
  bucket: 'bucket',
  heat: 'heat_sample',
};

const PROMPT = `Classify this one photo for a chemical plant batch log. Return JSON only:
{"label":"batch_sheet|bucket|heat_sample|qr_code|logo|other","confidence":0.0}

batch_sheet = a paper form with a table and handwriting or printed batch fields. A sheet photographed on a table still counts.
bucket = the product liquid or wax in a bucket, drum, or balti.
heat_sample = a small sample of product colour after heating, in a dish, beaker, or on a surface.
qr_code = a QR code or barcode fills most of the frame.
logo = a company logo on a plain background.
other = equipment, a person, a screenshot, or anything else.
If unsure, use other and confidence below 0.5. confidence is 0 to 1.`;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function reasonFor(kind: Kind, label: string): string {
  if (label === 'qr_code') {
    if (kind === 'sheet') return 'This looks like a code, not a batch sheet. Photograph the written sheet so it fills the frame.';
    if (kind === 'heat') return 'This looks like a code, not a heat-sample photo. Photograph the finished product colour.';
    return 'This looks like a code, not a bucket photo. Photograph the bucket / balti.';
  }
  if (label === 'logo') {
    if (kind === 'sheet') return 'This looks like a logo, not a batch sheet. Photograph the written sheet so it fills the frame.';
    if (kind === 'heat') return 'This looks like a logo, not a heat-sample photo. Photograph the finished product colour.';
    return 'This looks like a logo, not a bucket photo. Photograph the bucket / balti.';
  }
  if (label === 'batch_sheet') {
    if (kind === 'heat') return 'This looks like a paper form, not a heat-sample photo. Photograph the finished product colour.';
    return 'This looks like a paper form, not a bucket photo. Photograph the bucket / balti.';
  }
  if (label === 'bucket' || label === 'heat_sample') {
    if (kind === 'sheet') return 'This looks like a product photo, not a batch sheet. Photograph the written sheet.';
    if (kind === 'bucket') return 'This looks like a heat sample, not the bucket. Photograph the product in the bucket / balti.';
    return 'This looks like the bucket, not the heat sample. Photograph the finished product colour.';
  }
  if (kind === 'sheet') return 'This does not look like a batch sheet. Upload a photo of the written sheet, not the bucket or the heat sample.';
  if (kind === 'heat') return 'This does not look like a heat-sample photo. Photograph the finished product colour.';
  return 'This does not look like a bucket photo. Photograph the bucket / balti.';
}

async function classify(apiKey: string, mime: string, data: string): Promise<{ label: string; confidence: number }> {
  const override = Deno.env.get('GEMINI_PHOTO_MODEL')?.trim();
  const models = override ? [override] : ['gemini-flash-lite-latest', 'gemini-3.1-flash-lite'];
  let last = 'Gemini did not answer';
  for (const model of models) {
    let res: Response;
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: PROMPT },
                { inline_data: { mime_type: mime, data } },
              ],
            }],
            generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 80 },
          }),
        },
      );
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      continue;
    }
    if (!res.ok) {
      last = `Gemini ${res.status}`;
      if (res.status === 404 || res.status === 429 || res.status >= 500) continue;
      break;
    }
    const payload = await res.json();
    const parts = payload?.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p: { text?: string }) => p.text ?? '').join('');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) {
      last = 'Gemini returned no label';
      continue;
    }
    const parsed = JSON.parse(text.slice(start, end + 1)) as { label?: string; confidence?: number };
    const label = String(parsed.label ?? 'other');
    const confidence = Number(parsed.confidence);
    return { label, confidence: Number.isFinite(confidence) ? confidence : 0 };
  }
  throw new Error(last);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, reason: 'POST only' }, 405);

  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) return json({ ok: false, reason: 'Photo check is not configured.' }, 500);

  let body: { image?: string; kind?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, reason: 'That photo could not be checked. Take it again.' }, 400);
  }

  const kind = body.kind;
  if (kind !== 'sheet' && kind !== 'bucket' && kind !== 'heat') {
    return json({ ok: false, reason: 'Unknown photo slot.' }, 400);
  }

  const image = body.image ?? '';
  const match = image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/);
  const mime = match?.[1] ?? 'image/jpeg';
  const data = (match?.[2] ?? image).replace(/\s/g, '');
  if (data.length < 100) return json({ ok: false, reason: 'That photo could not be read. Take it again.' }, 400);
  if (data.length > 1_800_000) return json({ ok: false, reason: 'That photo is too large. Take it again, a little further back.' }, 413);

  try {
    const { label, confidence } = await classify(apiKey, mime, data);
    const ok = label === EXPECTED[kind] && confidence >= 0.6;
    return json({ ok, reason: ok ? '' : reasonFor(kind, label) });
  } catch (e) {
    console.error('[check-photo]', e instanceof Error ? e.message : e);
    return json({ ok: false, reason: 'This photo could not be checked. Check the signal and try again.' }, 502);
  }
});
