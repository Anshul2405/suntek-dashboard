/**
 * Maps a spoken phrase to a dashboard route. If a section keyword (English or
 * Hindi) appears in the transcript, voice search jumps straight there; otherwise
 * the transcript is handed to the global quick-search palette.
 */
interface VoiceRoute {
  route: string;
  keywords: string[];
}

const VOICE_ROUTES: VoiceRoute[] = [
  { route: '/dashboard', keywords: ['overview', 'home', 'dashboard', 'अवलोकन', 'होम'] },
  { route: '/dashboard/purchase/purchase', keywords: ['purchase order', 'purchase orders', 'p o', 'po', 'खरीद आदेश'] },
  { route: '/dashboard/purchase/maint', keywords: ['maintenance', 'maintain', 'ticket', 'रखरखाव', 'टिकट'] },
  { route: '/dashboard/purchase/far', keywords: ['far', 'fixed asset', 'asset', 'स्थायी संपत्ति', 'संपत्ति'] },
  { route: '/dashboard/purchase/storereq', keywords: ['store requisition', 'store req', 'requisition', 'store', 'स्टोर माँग', 'स्टोर'] },
  { route: '/dashboard/purchase/activity', keywords: ['activity log', 'activity', 'गतिविधि'] },
  { route: '/dashboard/purchase/book', keywords: ['purchase book', 'payments sheet', 'paraffin', 'kolkata', 'shd sheet'] },
  { route: '/dashboard/purchase/marine', keywords: ['marine', 'insurance', 'मरीन', 'बीमा'] },
  { route: '/dashboard/purchase/labour', keywords: ['labour', 'labor', 'श्रम'] },
  { route: '/dashboard/purchase/far', keywords: ['purchase', 'खरीद'] },
  { route: '/dashboard/sales', keywords: ['sales', 'sale', 'contract', 'बिक्री'] },
  { route: '/dashboard/stock', keywords: ['cpm stock', 'stock', 'inventory', 'स्टॉक'] },
  { route: '/dashboard/batches', keywords: ['batch sheet', 'batches', 'batch', 'बैच'] },
  { route: '/dashboard/customers', keywords: ['customer history', 'customers', 'customer', 'ग्राहक'] },
  { route: '/dashboard/users', keywords: ['user management', 'users', 'user', 'उपयोगकर्ता'] },
  { route: '/dashboard/blacklist', keywords: ['blacklist', 'black list', 'ब्लैकलिस्ट'] },
  { route: '/dashboard/anomalies', keywords: ['anomaly detection', 'anomalies', 'anomaly', 'विसंगति'] },
  { route: '/dashboard/audit', keywords: ['audit log', 'audit', 'ऑडिट'] },
  { route: '/dashboard/oil-ratio', keywords: ['oil ratio', 'ratio table', 'ऑयल रेशियो'] },
  { route: '/dashboard/night-manager', keywords: ['night manager', 'night', 'नाइट'] },
  { route: '/dashboard/daily-log', keywords: ['daily unit log', 'daily log', 'दैनिक'] },
];

/** Best route whose keyword appears in the transcript (longest match wins). */
export function matchVoiceRoute(transcript: string): string | null {
  const text = transcript.toLowerCase().trim();
  if (!text) return null;
  let best: { route: string; len: number } | null = null;
  for (const r of VOICE_ROUTES) {
    for (const k of r.keywords) {
      if (text.includes(k) && (!best || k.length > best.len)) best = { route: r.route, len: k.length };
    }
  }
  return best?.route ?? null;
}
