import { describe, it, expect } from 'vitest';
import { issueLineValue, issuePhotoRule, canConfirmIssue } from './issuePhoto';

describe('store issue photo rule', () => {
  it('values a line as qty × unit price', () => {
    expect(issueLineValue(3, 400)).toBe(1200);
    expect(issueLineValue('2', 250)).toBe(500);
    expect(issueLineValue(2, null)).toBeNull();
    expect(issueLineValue(0, 500)).toBeNull();
  });
  it('> ₹1000 needs a photo', () => {
    expect(issuePhotoRule(1000.01)).toBe('required');
    expect(canConfirmIssue(1200, false)).toBe(false);
    expect(canConfirmIssue(1200, true)).toBe(true);
  });
  it('≤ ₹1000 photo optional', () => {
    expect(issuePhotoRule(1000)).toBe('optional');
    expect(canConfirmIssue(999, false)).toBe(true);
  });
  it('unknown value needs a photo', () => {
    expect(issuePhotoRule(null)).toBe('required');
    expect(canConfirmIssue(null, false)).toBe(false);
  });
});
