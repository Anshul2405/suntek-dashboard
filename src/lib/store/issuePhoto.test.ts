import { describe, expect, it } from 'vitest';
import { issueLineValue, storeIssueNeedsPhoto } from './issuePhoto';

describe('store issue photo rule', () => {
  it('does not require a photo at ₹1,000 or below', () => {
    expect(storeIssueNeedsPhoto(0)).toBe(false);
    expect(storeIssueNeedsPhoto(1000)).toBe(false);
  });

  it('requires a photo above ₹1,000 and when value is unknown', () => {
    expect(storeIssueNeedsPhoto(1000.01)).toBe(true);
    expect(storeIssueNeedsPhoto(null)).toBe(true);
    expect(storeIssueNeedsPhoto(undefined)).toBe(true);
  });

  it('prefers the line total, else unit price × qty', () => {
    expect(issueLineValue(2500, 10, 2)).toBe(2500);
    expect(issueLineValue(null, 400, 2)).toBe(800);
    expect(issueLineValue(null, null, 2)).toBe(null);
  });
});
