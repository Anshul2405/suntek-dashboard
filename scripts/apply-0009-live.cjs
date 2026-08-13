#!/usr/bin/env node
/**
 * Apply demo-critical SQL (0009 reactors + production_batch_sheets) via
 * Supabase Management API. Requires SUPABASE_ACCESS_TOKEN (Account → Access Tokens).
 *
 *   SUPABASE_ACCESS_TOKEN=sbp_... node scripts/apply-0009-live.mjs
 */
const fs = require('fs');
const path = require('path');

const REF = 'heiimxqyxthxtnxqozap';
const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token) {
  console.error('Set SUPABASE_ACCESS_TOKEN first (https://supabase.com/dashboard/account/tokens)');
  process.exit(1);
}

const sqlPath = path.join(__dirname, '../supabase/migrations/0009_production_batch_sheets.sql');
const sql = fs.readFileSync(sqlPath, 'utf8');

(async () => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });
  const text = await r.text();
  console.log('status', r.status);
  console.log(text.slice(0, 2000));
  if (!r.ok) process.exit(1);
  console.log('0009 applied OK');
})();
