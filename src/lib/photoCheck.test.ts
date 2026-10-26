// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { judgePixels, retainPhoto } from './photoCheck';

const SIZE = 96;

function image(paint: (x: number, y: number) => [number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b] = paint(x, y);
      const i = (y * SIZE + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return data;
}

/** White field, orange mark and black word in the middle — the Suntek-style logo. */
function logo(): Uint8ClampedArray {
  return image((x, y) => {
    const inMark = x > 34 && x < 62 && y > 18 && y < 42;
    const inWord = y > 48 && y < 62 && x > 18 && x < 78 && (x % 3 !== 0);
    if (inMark) return [239, 108, 0];
    if (inWord) return [20, 20, 20];
    return [255, 255, 255];
  });
}

/** Soft photo of a written page on a wooden table. Sharp black-on-white marks are not this. */
function writtenSheet(): Uint8ClampedArray {
  return image((x, y) => {
    const onTable = x < 14 || x > 82 || y < 10 || y > 86;
    if (onTable) return [132, 118, 104];
    const dy = Math.min(y % 10, 10 - (y % 10));
    const dx = Math.min(x % 14, 14 - (x % 14));
    const near = Math.min(dy, dx > 2 ? 6 : dx);
    const t = Math.min(1, near / 6);
    const ink = [52, 48, 44];
    const paper = [168, 158, 146];
    return [
      Math.round(ink[0] + (paper[0] - ink[0]) * t),
      Math.round(ink[1] + (paper[1] - ink[1]) * t),
      Math.round(ink[2] + (paper[2] - ink[2]) * t),
    ];
  });
}

/** Black-and-white modules — a QR code, not a batch sheet. */
function qrCode(): Uint8ClampedArray {
  return image((x, y) => (((x >> 2) + (y >> 2)) % 2 === 0 ? [12, 12, 12] : [245, 245, 245]));
}

/** Yellow-brown liquid filling the frame — bucket or heat sample. */
function product(): Uint8ClampedArray {
  return image((x, y) => {
    const n = ((x * 3 + y * 5) % 17) - 8;
    return [190 + n, 140 + n, 40];
  });
}

describe('retainPhoto', () => {
  it('keeps a copy of the bytes so a cleared file picker cannot blank the picture', async () => {
    const src = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' });
    const copy = await retainPhoto(src, 'shot.jpg');
    expect(copy).not.toBe(src);
    expect(copy.type).toBe('image/jpeg');
    expect(new Uint8Array(await copy.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('refuses an empty file from the phone', async () => {
    const src = new Blob([], { type: 'image/jpeg' });
    await expect(retainPhoto(src, 'shot.jpg')).rejects.toThrow('empty');
  });
});

describe('batch photo slots', () => {
  it('rejects a logo in every slot', () => {
    const px = logo();
    expect(judgePixels(px, SIZE, 'sheet').ok).toBe(false);
    expect(judgePixels(px, SIZE, 'bucket').ok).toBe(false);
    expect(judgePixels(px, SIZE, 'heat').ok).toBe(false);
  });

  it('accepts a written sheet only in the batch-sheet slot', () => {
    const px = writtenSheet();
    expect(judgePixels(px, SIZE, 'sheet').ok).toBe(true);
    expect(judgePixels(px, SIZE, 'bucket').ok).toBe(false);
    expect(judgePixels(px, SIZE, 'heat').ok).toBe(false);
  });

  it('rejects a QR code in every slot', () => {
    const px = qrCode();
    expect(judgePixels(px, SIZE, 'sheet').ok).toBe(false);
    expect(judgePixels(px, SIZE, 'bucket').ok).toBe(false);
    expect(judgePixels(px, SIZE, 'heat').ok).toBe(false);
  });

  it('accepts a product photo only in the bucket and heat slots', () => {
    const px = product();
    expect(judgePixels(px, SIZE, 'sheet').ok).toBe(false);
    expect(judgePixels(px, SIZE, 'bucket').ok).toBe(true);
    expect(judgePixels(px, SIZE, 'heat').ok).toBe(true);
  });
});
