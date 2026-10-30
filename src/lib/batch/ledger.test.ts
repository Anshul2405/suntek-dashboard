import { describe, it, expect } from 'vitest';
import { isAlreadyPosted, onHandByBatch, onHandFor, productionMovement, signOk, signedQty, type Movement } from './ledger';

const mv = (batch: string, type: Movement['movement_type'], qty: number, plant = 'p1', at = '2026-10-27T05:00:00Z'): Movement =>
  ({ batch_no: batch, plant_id: plant, movement_type: type, qty, at });

describe('batch stock ledger', () => {
  it('signs quantities by movement type', () => {
    expect(signedQty('production', 40)).toBe(40);
    expect(signedQty('dispatch', 12)).toBe(-12);
    expect(signedQty('transfer_out', 5)).toBe(-5);
    expect(signedQty('adjustment', 2, -1)).toBe(-2);
    expect(() => signedQty('return', 0)).toThrow();
    expect(signOk('dispatch', 5)).toBe(false);
    expect(signOk('adjustment', -3)).toBe(true);
  });

  it('on hand = sum of movements, per batch and plant', () => {
    const map = onHandByBatch([
      mv('P26-12', 'production', 40),
      mv('p26-12', 'dispatch', -12, 'p1', '2026-10-28T05:00:00Z'),
      mv('P26-12', 'transfer_out', -8),
      mv('P26-12', 'transfer_in', 8, 'p2'),
      mv('P26-12', 'adjustment', -1),
      mv('P26-13', 'opening', 5),
    ]);
    expect(onHandFor(map, 'P26-12', 'p1')).toMatchObject({ drums: 19, movements: 4, lastAt: '2026-10-28T05:00:00Z' });
    expect(onHandFor(map, 'P26-12', 'p2')?.drums).toBe(8);
    expect(onHandFor(map, 'P26-13', 'p1')?.drums).toBe(5);
  });

  it('a batch number with no movements has no stock (not "exists = in stock")', () => {
    expect(onHandFor(onHandByBatch([]), 'P38-084', 'p1')).toBeNull();
  });

  it('production is one row per sheet; a repeat post is recognised as already posted', () => {
    const sheet = { id: 's1', batch_no: ' p26-14 ', plant_id: 'p1', reactor_id: 'r26', density: 1.4, stage: 'created' };
    const a = productionMovement(sheet, 36, 'Ravi');
    const b = productionMovement(sheet, 36, 'Ravi');
    expect(a).toEqual(b);
    expect(a).toMatchObject({ batch_no: 'P26-14', batch_sheet_id: 's1', movement_type: 'production', qty: 36 });
    expect(isAlreadyPosted({ code: '23505', message: 'duplicate key value violates unique constraint' })).toBe(true);
    expect(isAlreadyPosted({ code: '42501', message: 'permission denied' })).toBe(false);
    expect(isAlreadyPosted(null)).toBe(false);
  });
});
