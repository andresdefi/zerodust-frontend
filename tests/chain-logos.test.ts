import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LOGO_IDS, PNG_LOGOS } from '../src/chains/logo-ids';
import { logoSrc } from '../src/chains/logo-src';

const file = (path: string) => new URL(`../public${path}`, import.meta.url);

describe('chain logos', () => {
  it('every listed logo exists in its format, and logoSrc points at it', () => {
    for (const id of LOGO_IDS) {
      const src = logoSrc(id);
      expect(src, String(id)).toBe(`/chains/${id}.${PNG_LOGOS.has(id) ? 'png' : 'svg'}`);
      expect(existsSync(file(src)), src).toBe(true);
    }
  });

  it('the project logos added on 2026-10-08 are all there (no more initials for these chains)', () => {
    for (const id of [360, 648, 1155, 1514, 1672, 2818, 5031, 5330, 16661, 42018, 97477, 124816, 685689, 5064014]) expect(LOGO_IDS.has(id), String(id)).toBe(true);
  });

  it('PNG logos are real 96x96 PNGs, SVG logos carry nothing active', () => {
    for (const id of PNG_LOGOS) {
      const png = readFileSync(file(`/chains/${id}.png`));
      expect(png.subarray(1, 4).toString(), String(id)).toBe('PNG');
      expect([png.readUInt32BE(16), png.readUInt32BE(20)], String(id)).toEqual([96, 96]);
    }
    for (const id of [16661, 5064014]) {
      const svg = readFileSync(file(`/chains/${id}.svg`), 'utf8');
      expect(svg, String(id)).not.toMatch(/<script|\bon[a-z]+=|foreignObject|href="(https?:)?\/\//i);
    }
  });
});
