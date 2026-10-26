export type PhotoKind = 'sheet' | 'bucket' | 'heat';

export interface PhotoVerdict {
  ok: boolean;
  reason: string;
  /** Decoded JPEG the form should keep. The original phone file is often unreadable a moment later. */
  prepared?: Blob;
}

const UNREADABLE = 'That file could not be read as a photo. Use the Camera button, or pick a JPG.';

function isHeic(type: string, name: string) {
  return /hei[cf]/i.test(type) || /\.hei[cf]$/i.test(name);
}

/**
 * Copy the bytes immediately. On many plant phones, clearing the file picker
 * (or waiting until submit) detaches the original, and gallery photos are often
 * HEIC, which Chrome cannot display until they are converted.
 * `arrayBuffer()` is started before the first await so the caller can reset the
 * input on the next line without losing the picture.
 */
export function retainPhoto(file: Blob, name = ''): Promise<Blob> {
  const fileName = name || (file instanceof File ? file.name : '');
  const pending = file.arrayBuffer();
  return pending.then(async (buf) => {
    if (!buf.byteLength) throw new Error('empty');
    const type = file.type || (/\.png$/i.test(fileName) ? 'image/png' : /\.webp$/i.test(fileName) ? 'image/webp' : 'image/jpeg');
    let blob: Blob = new Blob([buf], { type });
    if (!isHeic(type, fileName)) return blob;
    try {
      const mod = await import('heic2any') as { default: (opts: { blob: Blob; toType: string; quality: number }) => Promise<Blob | Blob[]> };
      const out = await mod.default({ blob, toType: 'image/jpeg', quality: 0.85 });
      blob = Array.isArray(out) ? out[0] : out;
      if (!blob || !blob.size) throw new Error('heic');
      return blob;
    } catch {
      throw new Error('heic');
    }
  });
}

/**
 * The batch-sheet wizard has three different photos. A mismatch must not be
 * stored, so the operator cannot continue until the right picture is in each slot.
 * Gemini looks at the photo. A wrong picture, a code, or a failed check is refused.
 */
export async function checkPhotoKind(file: Blob, kind: PhotoKind, name = ''): Promise<PhotoVerdict> {
  let photo: Blob;
  try {
    photo = await retainPhoto(file, name);
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (msg === 'empty') {
      return { ok: false, reason: 'The phone did not hand over that photo. Take it again with the Camera button.' };
    }
    if (msg === 'heic') {
      return { ok: false, reason: 'This phone saved the photo as HEIC and it could not be opened. Use the Camera button on this screen.' };
    }
    return { ok: false, reason: UNREADABLE };
  }
  const mime = photo.type || '';
  if (mime && !mime.startsWith('image/')) {
    return { ok: false, reason: 'Upload a photo (JPG or PNG), not a document file.' };
  }
  const dims = await readSize(photo);
  if (!dims) return { ok: false, reason: UNREADABLE };
  if (dims.w < 280 || dims.h < 280) {
    return { ok: false, reason: 'Photo is too small. Take a clear picture that fills the frame.' };
  }
  let prepared: Blob;
  try {
    const { shrinkPhoto } = await import('./cloudinary');
    prepared = await shrinkPhoto(photo);
  } catch {
    return { ok: false, reason: UNREADABLE };
  }
  const dataUrl = await blobToDataUrl(prepared);
  const verdict = await askGemini(dataUrl, kind);
  return verdict.ok ? { ...verdict, prepared } : verdict;
}

async function readSize(file: Blob): Promise<{ w: number; h: number } | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      const size = { w: bmp.width, h: bmp.height };
      bmp.close();
      if (size.w > 0 && size.h > 0) return size;
    } catch {
      /* Some phone pictures only decode through an Image element. */
    }
  }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read the photo.'));
    reader.readAsDataURL(blob);
  });
}

async function askGemini(image: string, kind: PhotoKind): Promise<PhotoVerdict> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!supabaseUrl) return { ok: false, reason: 'This photo could not be checked. Try again in a moment.' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/check-photo`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(anon ? { Authorization: `Bearer ${anon}`, apikey: anon } : {}),
      },
      body: JSON.stringify({ image, kind }),
    });
    const json = await res.json().catch(() => ({})) as { ok?: boolean; reason?: string };
    if (!res.ok || typeof json.ok !== 'boolean') {
      return { ok: false, reason: json.reason || 'This photo could not be checked. Check the signal and try again.' };
    }
    return { ok: json.ok, reason: json.ok ? '' : (json.reason || 'This photo does not match this slot.') };
  } catch {
    return { ok: false, reason: 'This photo could not be checked. Check the signal and try again.' };
  } finally {
    clearTimeout(timer);
  }
}

/** Pure pixel test so the three slots can be checked without a browser image. */
export function judgePixels(data: Uint8ClampedArray, size: number, kind: PhotoKind): PhotoVerdict {
  const cells = 4;
  const cell = size / cells;
  const cellEdge = new Array<number>(cells * cells).fill(0);
  const cellN = new Array<number>(cells * cells).fill(0);
  let paper = 0;
  let white = 0;
  let ink = 0;
  let color = 0;
  let mid = 0;
  let extreme = 0;
  let edge = 0;
  let n = 0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = max - min;
      const L = 0.299 * r + 0.587 * g + 0.114 * b;
      if (L > 200 && sat < 28) paper++;
      if (L > 230 && sat < 18) white++;
      if (L < 75) ink++;
      if (sat > 42 && L > 30 && L < 235) color++;
      if (L > 80 && L < 180) mid++;
      let e = 0;
      if (x + 1 < size) {
        const j = i + 4;
        e = Math.abs(r - data[j]) + Math.abs(g - data[j + 1]) + Math.abs(b - data[j + 2]);
      }
      if (e > 80) extreme++;
      edge += e;
      const cx = Math.min(cells - 1, Math.floor(x / cell));
      const cy = Math.min(cells - 1, Math.floor(y / cell));
      const ci = cy * cells + cx;
      cellEdge[ci] += e;
      cellN[ci]++;
      n++;
    }
  }

  const paperRatio = paper / n;
  const whiteRatio = white / n;
  const inkRatio = ink / n;
  const colorRatio = color / n;
  const midRatio = mid / n;
  const extremeRatio = extreme / n;
  const edgeAvg = edge / n;
  const busyCells = cellEdge.filter((sum, idx) => cellN[idx] > 0 && sum / cellN[idx] > 10).length;

  // A QR code is sharp black-on-white. A photographed batch sheet is mostly
  // mid-tone paper and table, with softer pen and grid lines.
  const isCode = extremeRatio > 0.12 && midRatio < 0.32 && edgeAvg > 30;
  const photographedForm = inkRatio > 0.06 && busyCells >= 6 && edgeAvg > 8 && edgeAvg < 32
    && whiteRatio < 0.35 && colorRatio < 0.4 && midRatio > 0.3 && extremeRatio < 0.08;
  const brightForm = paperRatio > 0.25 && inkRatio > 0.08 && busyCells >= 8 && colorRatio < 0.12
    && whiteRatio < 0.7 && midRatio > 0.2 && extremeRatio < 0.07 && edgeAvg < 28;
  const isDocument = photographedForm || brightForm;
  const isLogo = whiteRatio > 0.55 && midRatio < 0.2 && !photographedForm;

  if (isLogo) {
    return {
      ok: false,
      reason: kind === 'sheet'
        ? 'This looks like a logo, not a batch sheet. Photograph the written sheet so it fills the frame.'
        : kind === 'heat'
          ? 'This looks like a logo, not a heat-sample photo. Photograph the finished product colour.'
          : 'This looks like a logo, not a bucket photo. Photograph the bucket / balti.',
    };
  }

  if (isCode) {
    return {
      ok: false,
      reason: kind === 'sheet'
        ? 'This looks like a code or a graphic, not a batch sheet. Photograph the written sheet so it fills the frame.'
        : kind === 'heat'
          ? 'This looks like a code or a graphic, not a heat-sample photo. Photograph the finished product colour.'
          : 'This looks like a code or a graphic, not a bucket photo. Photograph the bucket / balti.',
    };
  }

  if (kind === 'sheet') {
    if (!isDocument) {
      return { ok: false, reason: 'This does not look like a batch sheet. Upload a photo of the written sheet, not the bucket or the heat sample.' };
    }
    return { ok: true, reason: '' };
  }

  if (isDocument || (paperRatio > 0.38 && edgeAvg > 14 && colorRatio < 0.08 && busyCells >= 8)) {
    return {
      ok: false,
      reason: kind === 'heat'
        ? 'This looks like a paper form, not a heat-sample photo. Photograph the finished product colour.'
        : 'This looks like a paper form, not a bucket photo. Photograph the bucket / balti.',
    };
  }
  return { ok: true, reason: '' };
}
