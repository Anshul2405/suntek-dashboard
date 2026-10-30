import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabase';
import { insertRows, updateRows } from '../db';
import { fetchAllRows } from '../fetchAll';
import { usePlantScope } from '../../contexts/PlantScopeContext';
import { useColumnLive } from '../schemaProbe';
import type { Database } from '../database.types';
import {
  isAlreadyPosted, nextStageAfterProduction, onHandByBatch, productionMovement,
  type OnHand, type ProductionSheet,
} from './ledger';

export type LedgerRow = Database['public']['Tables']['batch_stock_movements']['Row'];
export type LedgerInsert = Database['public']['Tables']['batch_stock_movements']['Insert'];

/**
 * The batch ledger for the user's plants (fail-closed scope) plus transfers
 * sent to their plants that are not received yet. `live` is false until
 * migration 0041 is applied — screens then say "ledger not switched on".
 */
export function useBatchLedger() {
  const { scopeQuery, ready, plantIds, isGlobal } = usePlantScope();
  const live = useColumnLive('batch_stock_movements', 'id');
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [incoming, setIncoming] = useState<LedgerRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick(n => n + 1), []);

  useEffect(() => {
    if (!live || !ready) return;
    let alive = true;
    void (async () => {
      const own = await fetchAllRows<LedgerRow>((from, to) =>
        scopeQuery(supabase.from('batch_stock_movements').select('*'))
          .order('at', { ascending: false }).order('id').range(from, to).returns<LedgerRow[]>());
      let inc: LedgerRow[] = [];
      if (isGlobal || plantIds.length) {
        let q = supabase.from('batch_stock_movements').select('*').eq('movement_type', 'transfer_out');
        if (!isGlobal) q = q.in('to_plant_id', plantIds);
        const { data } = await q.order('at', { ascending: false }).limit(500).returns<LedgerRow[]>();
        inc = data ?? [];
      }
      if (!alive) return;
      setError(own.error ? own.error.message || 'error' : null);
      setRows(own.data);
      const received = new Set(own.data.filter(r => r.movement_type === 'transfer_in' && r.transfer_group).map(r => r.transfer_group));
      setIncoming(inc.filter(r => r.transfer_group && !received.has(r.transfer_group)));
      setLoaded(true);
    })();
    return () => { alive = false; };
  }, [live, ready, scopeQuery, isGlobal, plantIds, tick]);

  const onHand = useMemo(() => onHandByBatch(rows.map(r => ({
    batch_no: r.batch_no, plant_id: r.plant_id, movement_type: r.movement_type, qty: Number(r.qty), qty_kg: r.qty_kg, at: r.at,
  }))), [rows]);

  /** Production sheets already posted (one production row per sheet). */
  const postedSheets = useMemo(() => new Set(rows.filter(r => r.movement_type === 'production' && r.batch_sheet_id).map(r => r.batch_sheet_id as string)), [rows]);

  return { live, loaded, error, rows, incoming, onHand, postedSheets, reload };
}

/** Insert one movement. A duplicate (already posted) is reported, not thrown. */
export async function postMovement(row: LedgerInsert): Promise<{ ok: boolean; already: boolean; error: string | null }> {
  const { error } = await insertRows('batch_stock_movements', row);
  if (!error) return { ok: true, already: false, error: null };
  if (isAlreadyPosted(error)) return { ok: true, already: true, error: null };
  return { ok: false, already: false, error: error.message };
}

/**
 * Post a finished batch sheet's production once (idempotent: the database keeps
 * one production row per sheet) and move the sheet to in_stock.
 */
export async function postProduction(sheet: ProductionSheet, drums: number, actor: string, kg?: number | null) {
  const res = await postMovement(productionMovement(sheet, drums, actor, kg));
  if (res.ok) {
    const next = nextStageAfterProduction(sheet.stage);
    if (next) await updateRows('production_batch_sheets', { stage: next }).eq('id', sheet.id).eq('stage', 'created');
  }
  return res;
}

export type { OnHand };
