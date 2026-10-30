import { describe, it, expect } from 'vitest';
import { codeLabel } from './labels';

describe('codeLabel', () => {
  it('turns status, module and role codes into words', () => {
    expect(codeLabel('pending_vijay')).toBe('Vijay ji');
    expect(codeLabel('pending_approval')).toBe('Unit head approval');
    expect(codeLabel('factory_operator')).toBe('Technical');
    expect(codeLabel('store_req')).toBe('Store requisitions');
    expect(codeLabel('false_positive')).toBe('False alarm');
  });

  it('never shows a slug or a personal id', () => {
    expect(codeLabel('stock_check_override')).toBe('Stock check override');
    expect(codeLabel('db_3f2a9c1e-0000-4000-8000-000000000000')).toBe('—');
    expect(codeLabel('')).toBe('—');
  });
});
