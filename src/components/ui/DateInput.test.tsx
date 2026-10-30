import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, fireEvent } from '@testing-library/react';
import { DateInput } from './DateInput';

describe('DateInput (dd/mm/yyyy on every device)', () => {
  it('shows dd/mm/yyyy, day-first locale on the box and the picker', () => {
    const { container } = render(<DateInput value="2026-10-02" onChange={() => {}} />);
    const [box, picker] = Array.from(container.querySelectorAll('input'));
    expect(box.value).toBe('02/10/2026');
    expect(box.getAttribute('lang')).toBe('en-GB');
    expect(picker.getAttribute('type')).toBe('date');
    expect(picker.getAttribute('lang')).toBe('en-GB');
  });

  it('31/02 after a valid day clears the value (no save on the old date), keeps the red text', () => {
    const onChange = vi.fn();
    // A form that keeps the value in state, like every screen does.
    function Form() {
      const [v, setV] = useState('2026-10-02');
      return <DateInput value={v} onChange={(e) => { onChange(e); setV(e.target.value); }} />;
    }
    const { container } = render(<Form />);
    const box = container.querySelector('input')!;
    fireEvent.change(box, { target: { value: '31/02/2026' } });
    fireEvent.blur(box);
    expect(onChange).toHaveBeenLastCalledWith({ target: { value: '' } });
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(box.value).toBe('31/02/2026');
  });

  it('reads a typed day first and refuses 31/02', () => {
    const onChange = vi.fn();
    const { container } = render(<DateInput value="" onChange={onChange} />);
    const box = container.querySelector('input')!;
    fireEvent.change(box, { target: { value: '31/02/2026' } });
    fireEvent.blur(box);
    expect(onChange).not.toHaveBeenCalled();
    expect(box.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(box, { target: { value: '02/10/2026' } });
    expect(onChange).toHaveBeenLastCalledWith({ target: { value: '2026-10-02' } });
  });

  it('allows a future day when no max is set', () => {
    const onChange = vi.fn();
    const { container } = render(<DateInput value="" onChange={onChange} />);
    const box = container.querySelector('input')!;
    fireEvent.change(box, { target: { value: '30/12/2099' } });
    expect(onChange).toHaveBeenLastCalledWith({ target: { value: '2099-12-30' } });
  });
});
