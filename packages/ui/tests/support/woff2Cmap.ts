/**
 * Read the Unicode cmap out of a WOFF2 file, in Node, with no font library:
 * enough to answer "does this face draw this character, or its .notdef?"
 * (#3157). A code point maps to a glyph id; id 0 is .notdef, which is what a
 * browser paints as tofu when no face in the stack has the character.
 *
 * WOFF2 (W3C, section 5): a 48-byte header, a variable-length table directory,
 * then ONE brotli stream holding every table back to back in directory order.
 * cmap is never transformed, so its bytes are plain sfnt cmap.
 */
import { brotliDecompressSync } from 'node:zlib';

const KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ',
  'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS',
  'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc',
  'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop',
  'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
];

function readBase128(bytes: Buffer, at: { pos: number }): number {
  let value = 0;
  for (let i = 0; i < 5; i += 1) {
    const byte = bytes[at.pos++]!;
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return value;
  }
  throw new Error('bad UIntBase128');
}

/** The raw (decompressed) bytes of one table. */
export function woff2Table(file: Buffer, wanted: string): Buffer {
  if (file.subarray(0, 4).toString('latin1') !== 'wOF2') throw new Error('not a WOFF2 file');
  if (file.readUInt32BE(4) === 0x74746366) throw new Error('font collections are not supported');
  const numTables = file.readUInt16BE(12);
  const compressedLength = file.readUInt32BE(20);
  const at = { pos: 48 };
  let offset = 0;
  let found: { offset: number; length: number } | null = null;
  for (let i = 0; i < numTables; i += 1) {
    const flags = file[at.pos++]!;
    let tag = KNOWN_TAGS[flags & 0x3f];
    if ((flags & 0x3f) === 63) {
      tag = file.subarray(at.pos, at.pos + 4).toString('latin1');
      at.pos += 4;
    }
    const transform = (flags >> 6) & 3;
    const origLength = readBase128(file, at);
    const glyfOrLoca = tag === 'glyf' || tag === 'loca';
    const transformed = glyfOrLoca ? transform === 0 : transform !== 0;
    const length = transformed ? readBase128(file, at) : origLength;
    if (tag === wanted) {
      if (transformed) throw new Error(`${wanted} is transformed`);
      found = { offset, length };
    }
    offset += length;
  }
  if (!found) throw new Error(`no ${wanted} table`);
  const tables = brotliDecompressSync(file.subarray(at.pos, at.pos + compressedLength));
  return tables.subarray(found.offset, found.offset + found.length);
}

/** Every code point the font maps to a real (non-.notdef) glyph. */
export function woff2CodePoints(file: Buffer): Set<number> {
  const cmap = woff2Table(file, 'cmap');
  const count = cmap.readUInt16BE(2);
  const subtables = new Map<string, number>();
  for (let i = 0; i < count; i += 1) {
    const record = 4 + i * 8;
    subtables.set(`${cmap.readUInt16BE(record)}.${cmap.readUInt16BE(record + 2)}`, cmap.readUInt32BE(record + 4));
  }
  const out = new Set<number>();
  const full = subtables.get('3.10') ?? subtables.get('0.4') ?? subtables.get('0.6');
  if (full !== undefined && cmap.readUInt16BE(full) === 12) {
    const groups = cmap.readUInt32BE(full + 12);
    for (let g = 0; g < groups; g += 1) {
      const base = full + 16 + g * 12;
      const start = cmap.readUInt32BE(base);
      const end = cmap.readUInt32BE(base + 4);
      const glyph = cmap.readUInt32BE(base + 8);
      for (let cp = start; cp <= end; cp += 1) if (glyph + (cp - start) !== 0) out.add(cp);
    }
    return out;
  }
  const bmp = subtables.get('3.1') ?? subtables.get('0.3');
  if (bmp === undefined || cmap.readUInt16BE(bmp) !== 4) throw new Error('no Unicode cmap (format 4 or 12)');
  const segX2 = cmap.readUInt16BE(bmp + 6);
  const ends = bmp + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const rangeOffsets = deltas + segX2;
  for (let s = 0; s < segX2 / 2; s += 1) {
    const end = cmap.readUInt16BE(ends + s * 2);
    const start = cmap.readUInt16BE(starts + s * 2);
    const delta = cmap.readInt16BE(deltas + s * 2);
    const rangeOffsetAt = rangeOffsets + s * 2;
    const rangeOffset = cmap.readUInt16BE(rangeOffsetAt);
    for (let cp = start; cp <= end && cp !== 0xffff; cp += 1) {
      let glyph: number;
      if (rangeOffset === 0) glyph = (cp + delta) & 0xffff;
      else {
        const raw = cmap.readUInt16BE(rangeOffsetAt + rangeOffset + (cp - start) * 2);
        glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
      }
      if (glyph !== 0) out.add(cp);
    }
  }
  return out;
}
