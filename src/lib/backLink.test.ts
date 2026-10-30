import { describe, it, expect } from 'vitest';
import { hereForBack, safeBack, withBack } from './backLink';

describe('backLink', () => {
  it('appends back with ? or &', () => {
    expect(withBack('/dashboard/purchase/maint?ticket=1', '/dashboard/purchase/far'))
      .toBe('/dashboard/purchase/maint?ticket=1&back=%2Fdashboard%2Fpurchase%2Ffar');
    expect(withBack('/dashboard/purchase/storereq', '/dashboard')).toBe('/dashboard/purchase/storereq?back=%2Fdashboard');
  });
  it('keeps filters in the origin', () => {
    expect(hereForBack({ pathname: '/dashboard/todo', search: '?q=pump' })).toBe('/dashboard/todo?q=pump');
  });
  it('keeps the activity log page in back=', () => {
    const here = hereForBack({ pathname: '/dashboard/purchase/activity', search: '?p=3' });
    expect(here).toBe('/dashboard/purchase/activity?p=3');
    expect(withBack('/dashboard/purchase/maint?ticket=1', here))
      .toContain('back=%2Fdashboard%2Fpurchase%2Factivity%3Fp%3D3');
  });
  it('accepts only in-app dashboard paths', () => {
    expect(safeBack('/dashboard')).toBe('/dashboard');
    expect(safeBack('/dashboard/purchase/far?fy=2026')).toBe('/dashboard/purchase/far?fy=2026');
    expect(safeBack('//evil.example/dashboard')).toBe('');
    expect(safeBack('https://evil.example')).toBe('');
    expect(safeBack('/login')).toBe('');
    expect(safeBack(null)).toBe('');
  });
});
