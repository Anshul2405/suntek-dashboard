#!/usr/bin/env node
/**
 * Seed live stores + factory_store_access when the stores table is empty.
 * Requires SUPABASE_ACCESS_TOKEN (Management API) to fetch the service_role key.
 *
 *   SUPABASE_ACCESS_TOKEN=sbp_... node scripts/seed-stores-live.cjs
 */
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const REF = 'heiimxqyxthxtnxqozap';

function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.join(__dirname, '../.env.local'), 'utf8').split('\n')) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* optional */ }
}

loadEnv();
const token = process.env.SUPABASE_ACCESS_TOKEN;
const BASE = process.env.VITE_SUPABASE_URL;
if (!token || !BASE) {
  console.error('Need SUPABASE_ACCESS_TOKEN + VITE_SUPABASE_URL');
  process.exit(1);
}

(async () => {
  const keys = await (await fetch(`https://api.supabase.com/v1/projects/${REF}/api-keys`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  const secret = keys.find((k) => (k.name || k.type) === 'service_role')?.api_key;
  if (!secret) throw new Error('service_role key not found');

  const admin = createClient(BASE, secret, { auth: { persistSession: false } });
  const { data: plants } = await admin.from('plants').select('id,name,factory_code,location_id,is_factory,is_active');
  const { data: locs } = await admin.from('locations').select('id,code');
  const locByCode = Object.fromEntries((locs || []).map((l) => [l.code, l]));

  const desired = [
    { code: 'REHLA_COMMON', name: 'Rehla Common Store', loc: 'REHLA' },
    { code: 'SCPL_GANJAM_STORE', name: 'Ganjam Store', loc: 'GANJAM' },
    { code: 'MADAN_SIKANDRABAD_STORE', name: 'Sikandrabad Store', loc: 'SIKANDRABAD' },
    { code: 'DRUM_REHLA_STORE', name: 'Drum Plant Store', loc: 'REHLA' },
  ];

  const storeIds = {};
  for (const d of desired) {
    const loc = locByCode[d.loc];
    if (!loc) throw new Error(`Missing location ${d.loc}`);
    const { data: existing } = await admin.from('stores').select('id').eq('code', d.code).maybeSingle();
    if (existing?.id) {
      storeIds[d.code] = existing.id;
      await admin.from('stores').update({ is_active: true, name: d.name }).eq('id', existing.id);
      continue;
    }
    const { data: created, error } = await admin.from('stores').insert({
      location_id: loc.id, name: d.name, code: d.code, is_active: true,
    }).select('id').single();
    if (error) throw error;
    storeIds[d.code] = created.id;
    console.log('created', d.code);
  }

  const map = [
    ['SCPL_REHLA', 'REHLA_COMMON'],
    ['SPPL_REHLA', 'REHLA_COMMON'],
    ['SPPLK_REHLA', 'REHLA_COMMON'],
    ['SCPL_GANJAM', 'SCPL_GANJAM_STORE'],
    ['MADAN_SIKANDRABAD', 'MADAN_SIKANDRABAD_STORE'],
    ['DRUM_REHLA', 'DRUM_REHLA_STORE'],
  ];

  for (const [factoryCode, storeCode] of map) {
    const plant = (plants || []).find((p) => p.factory_code === factoryCode);
    const storeId = storeIds[storeCode];
    if (!plant || !storeId) continue;
    await admin.from('factory_store_access').delete().eq('plant_id', plant.id);
    const { error } = await admin.from('factory_store_access').insert({ plant_id: plant.id, store_id: storeId });
    if (error) throw error;
    console.log(factoryCode, '→', storeCode);
  }

  const { data: stores } = await admin.from('stores').select('code,name').eq('is_active', true).order('name');
  console.log('OK', (stores || []).map((s) => s.name).join(', '));
})().catch((e) => { console.error(e); process.exit(1); });
