/**
 * Cloudinary upload utilities.
 *
 * Uses UNSIGNED uploads (no server secret) via an upload preset. Unsigned
 * uploads are allowed to set `folder` (auto-creates the directory) and
 * `public_id` (the file name), so every workflow can store its images in a
 * systematic, identity-stamped hierarchy:
 *
 *   suntek/{workflow}/{subfolder}/{kind}_{entityOrPlant}_{timestamp}_{creator}
 *
 *   e.g.  suntek/maintenance/98c81379/completion_98c81379_1719048300000_anooj-kumar
 *         suntek/night-checkins/2026-06-23/checkin_rehla_1719048300000_devraj-singh
 *
 * Folders are created on Cloudinary automatically the first time an asset is
 * uploaded to that path (you cannot pre-create empty folders from the browser
 * without server-side signed credentials).
 *
 * Setup (Cloudinary dashboard): Settings → Upload → Upload Presets → Add preset,
 * Signing mode = Unsigned, name = "suntek_checkins".
 *
 * Env (.env.local):
 *   VITE_CLOUDINARY_CLOUD_NAME=your_cloud_name
 *   VITE_CLOUDINARY_UPLOAD_PRESET=suntek_checkins
 */

export interface CloudinaryUploadResult {
  secure_url: string;     // HTTPS URL to the uploaded image
  public_id: string;      // full path within the cloud (folder + name)
  asset_id: string;
  created_at: string;
  bytes: number;
  width: number;
  height: number;
  format: string;
}

/** Top-level folder buckets under `suntek/`, one per workflow. */
export type WorkflowBucket =
  | 'maintenance'
  | 'night-checkins'
  | 'activity-log'
  | 'store-req'
  | 'batch'
  | 'general';

export interface WorkflowUploadMeta {
  /** Top-level workflow folder under suntek/. */
  workflow: WorkflowBucket;
  /** Sub-folder — an entity id (e.g. ticket id) or a date. Defaults to today. */
  subfolder?: string;
  /** The record this image belongs to — stamped into the file name. */
  entityId?: string;
  /** Image kind, e.g. 'completion' | 'defective' | 'bill' | 'proof' | 'checkin'. */
  kind?: string;
  /** Person who uploaded it — stamped into the file name (the "identity"). */
  creator?: string;
  plant?: string;
  /** Extra Cloudinary contextual metadata (key=value, queryable in the dashboard). */
  context?: Record<string, string>;
  tags?: string[];
  onProgress?: (pct: number) => void;
}

const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.72;

/**
 * Phone cameras hand back a multi-megabyte file, often a temp file that
 * disappears before submit. Copy it into a smaller JPEG immediately so the
 * upload survives a weak plant network.
 */
export async function shrinkPhoto(file: Blob): Promise<Blob> {
  if (typeof document === 'undefined') return file;
  if (file.size > 0 && file.size < 700_000 && /jpe?g/i.test(file.type)) return file;

  const paint = async (w: number, h: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void) => {
    const edge = Math.max(w, h) || 1;
    const scale = edge > MAX_EDGE ? MAX_EDGE / edge : 1;
    const width = Math.max(1, Math.round(w * scale));
    const height = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not prepare the photo for upload.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    draw(ctx, width, height);
    const jpeg = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Could not prepare the photo for upload.'))),
        'image/jpeg',
        JPEG_QUALITY,
      );
    });
    return jpeg.size < file.size || file.size > 1_500_000 ? jpeg : file;
  };

  try {
    if (typeof createImageBitmap === 'function') {
      const bmp = await createImageBitmap(file);
      try {
        return await paint(bmp.width, bmp.height, (ctx, w, h) => ctx.drawImage(bmp, 0, 0, w, h));
      } finally {
        bmp.close();
      }
    }
  } catch {
    /* Fall through to an Image element. Some phone formats only decode there. */
  }

  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('unreadable'));
      el.src = url;
    });
    return await paint(img.naturalWidth, img.naturalHeight, (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h));
  } catch {
    if (file.size > 8_000_000) {
      throw new Error('This photo is too large for the plant network. Take it again, a little further from the equipment.');
    }
    return file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function asUploadError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg)) {
    return new Error('The photo did not reach the server. Check the signal and tap submit again.');
  }
  return err instanceof Error ? err : new Error(msg);
}

async function postForm(url: string, body: FormData): Promise<Response> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetch(url, { method: 'POST', body });
    } catch (err) {
      last = err;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    }
  }
  throw asUploadError(last);
}

/** Lower-case, hyphenated, safe-for-Cloudinary token. */
function slug(s: string | null | undefined, fallback = ''): string {
  const out = (s ?? '').toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return out || fallback;
}

/**
 * Generic, identity-stamped Cloudinary uploader. Every workflow should route
 * its image uploads through this so the cloud stays organised and every file
 * is traceable to a record + person + time.
 */
export async function uploadWorkflowImage(
  blob: Blob,
  meta: WorkflowUploadMeta,
): Promise<CloudinaryUploadResult> {
  const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME as string | undefined;
  const uploadPreset = (import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET as string | undefined) ?? 'suntek_checkins';
  if (!cloudName || cloudName === 'your_cloud_name_here') {
    throw new Error('VITE_CLOUDINARY_CLOUD_NAME is not set. Add it to .env.local and restart.');
  }

  const today = new Date().toISOString().split('T')[0];
  const timestamp = Date.now();

  // ── Folder: suntek/{workflow}/{subfolder} ──────────────────────────────────
  const subfolder = slug(meta.subfolder || today, today);
  const folder = `suntek/${meta.workflow}/${subfolder}`;

  // ── File name (public_id): {kind}_{entityOrPlant}_{timestamp}_{creator} ────
  const entityShort = meta.entityId ? meta.entityId.replace(/-/g, '').slice(0, 8) : '';
  const idToken = entityShort || slug(meta.plant);
  const creatorSlug = slug(meta.creator, 'unknown');
  const publicId = [slug(meta.kind, 'img'), idToken, timestamp, creatorSlug].filter(Boolean).join('_');

  // ── Simulated progress (Fetch has no upload-progress events) ───────────────
  let progressTimer: ReturnType<typeof setInterval> | null = null;
  let fakeProgress = 0;
  if (meta.onProgress) {
    meta.onProgress(0);
    progressTimer = setInterval(() => {
      fakeProgress = Math.min(fakeProgress + Math.random() * 12 + 3, 88);
      meta.onProgress?.(Math.round(fakeProgress));
    }, 250);
  }

  try {
    const photo = await shrinkPhoto(blob);
    const fd = new FormData();
    fd.append('file', photo, `${publicId}.jpg`);
    fd.append('upload_preset', uploadPreset);
    fd.append('folder', folder);
    fd.append('public_id', publicId);

    const tags = [
      ...(meta.kind ? [`kind:${slug(meta.kind)}`] : []),
      ...(meta.plant ? [`plant:${slug(meta.plant)}`] : []),
      ...(entityShort ? [`entity:${entityShort}`] : []),
      ...(meta.creator ? [`by:${creatorSlug}`] : []),
      `date:${today}`,
      ...(meta.tags ?? []),
    ];
    fd.append('tags', tags.join(','));

    // Contextual metadata — searchable in the Cloudinary Media Library.
    const ctx: Record<string, string> = {
      workflow: meta.workflow,
      kind: meta.kind ?? '',
      entity_id: meta.entityId ?? '',
      creator: meta.creator ?? '',
      plant: meta.plant ?? '',
      uploaded_at: new Date().toISOString(),
      ...(meta.context ?? {}),
    };
    fd.append('context', Object.entries(ctx)
      .filter(([, v]) => v !== '')
      .map(([k, v]) => `${k}=${String(v).replace(/[|=]/g, ' ')}`)
      .join('|'));

    const res = await postForm(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, fd);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error?.message ?? `Cloudinary upload failed (HTTP ${res.status})`);
    meta.onProgress?.(100);
    return data as CloudinaryUploadResult;
  } finally {
    if (progressTimer) clearInterval(progressTimer);
  }
}

/**
 * Upload ANY file (CSV, Excel, PDF, image…) to Cloudinary for reference, so the
 * cloud keeps a copy of everything we ingest. Uses the /auto/ endpoint so raw
 * documents are accepted. Same folder/identity convention as images.
 */
export async function uploadWorkflowFile(
  file: File,
  meta: { workflow: WorkflowBucket; subfolder?: string; entityId?: string; kind?: string; creator?: string; onProgress?: (pct: number) => void },
): Promise<CloudinaryUploadResult> {
  const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME as string | undefined;
  const uploadPreset = (import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET as string | undefined) ?? 'suntek_checkins';
  if (!cloudName || cloudName === 'your_cloud_name_here') {
    throw new Error('VITE_CLOUDINARY_CLOUD_NAME is not set. Add it to .env.local and restart.');
  }
  const today = new Date().toISOString().split('T')[0];
  const timestamp = Date.now();
  const subfolder = slug(meta.subfolder || today, today);
  const folder = `suntek/${meta.workflow}/${subfolder}`;
  const entityShort = meta.entityId ? meta.entityId.replace(/-/g, '').slice(0, 8) : '';
  const publicId = [slug(meta.kind, 'file'), entityShort, timestamp, slug(meta.creator, 'unknown')].filter(Boolean).join('_');

  let timer: ReturnType<typeof setInterval> | null = null;
  let p = 0;
  if (meta.onProgress) {
    meta.onProgress(0);
    timer = setInterval(() => { p = Math.min(p + Math.random() * 12 + 3, 88); meta.onProgress?.(Math.round(p)); }, 250);
  }
  try {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('upload_preset', uploadPreset);
    fd.append('folder', folder);
    fd.append('public_id', publicId);
    fd.append('tags', [`workflow:${meta.workflow}`, ...(meta.kind ? [`kind:${slug(meta.kind)}`] : []), ...(meta.creator ? [`by:${slug(meta.creator)}`] : []), `date:${today}`].join(','));
    const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`, { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error?.message ?? `Cloudinary upload failed (HTTP ${res.status})`);
    meta.onProgress?.(100);
    return data as CloudinaryUploadResult;
  } finally {
    if (timer) clearInterval(timer);
  }
}

// ── Workflow-specific wrappers ───────────────────────────────────────────────

export interface MaintenancePhotoMeta {
  ticketId: string;
  plantName: string;
  photoType: 'completion' | 'defective' | 'bill';
  /** Who uploaded the photo — stamped into the file name. */
  creator?: string;
  onProgress?: (pct: number) => void;
}

/** Stored under suntek/maintenance/{ticketId}/ as {type}_{ticketShort}_{ts}_{creator}. */
export async function uploadMaintenancePhoto(
  blob: Blob,
  meta: MaintenancePhotoMeta,
): Promise<CloudinaryUploadResult> {
  return uploadWorkflowImage(blob, {
    workflow: 'maintenance',
    subfolder: meta.ticketId,
    entityId: meta.ticketId,
    kind: meta.photoType,
    creator: meta.creator,
    plant: meta.plantName,
    onProgress: meta.onProgress,
  });
}

/** Upload every photo in order. Progress is spread across the whole set. */
export async function uploadMaintenancePhotos(
  blobs: Blob[],
  meta: MaintenancePhotoMeta,
): Promise<string[]> {
  const urls: string[] = [];
  const total = blobs.length || 1;
  for (let i = 0; i < blobs.length; i++) {
    const result = await uploadMaintenancePhoto(blobs[i], {
      ...meta,
      onProgress: pct => meta.onProgress?.(Math.round(((i + pct / 100) / total) * 100)),
    });
    urls.push(result.secure_url);
  }
  return urls;
}

export interface CheckinPhotoMeta {
  plantName: string;
  lat: number;
  lng: number;
  isOnSite: boolean;
  workerInitials?: string;
  /** Who checked in — stamped into the file name. */
  creator?: string;
  onProgress?: (pct: number) => void;
}

/** Stored under suntek/night-checkins/{date}/ as checkin_{plant}_{ts}_{creator}. */
export async function uploadCheckinPhoto(
  blob: Blob,
  meta: CheckinPhotoMeta,
): Promise<CloudinaryUploadResult> {
  const today = new Date().toISOString().split('T')[0];
  return uploadWorkflowImage(blob, {
    workflow: 'night-checkins',
    subfolder: today,
    kind: 'checkin',
    creator: meta.creator ?? meta.workerInitials,
    plant: meta.plantName,
    tags: [meta.isOnSite ? 'on_site' : 'out_of_zone'],
    context: {
      lat: meta.lat.toFixed(6),
      lng: meta.lng.toFixed(6),
      is_on_site: String(meta.isOnSite),
    },
    onProgress: meta.onProgress,
  });
}
