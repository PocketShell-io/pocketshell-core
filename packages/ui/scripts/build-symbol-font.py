#!/usr/bin/env python3
"""Build PocketShellSymbols-Regular.woff2, the terminal's symbol fallback (#3157).

JetBrains Mono, the bundled terminal face, has no glyph for several symbols
that terminal UIs draw constantly: Claude Code's "⏵⏵ bypass permissions",
"✻ Thinking", "⎿" tool-result elbows, and more. A phone has no system font
for most of them either, so they rendered as .notdef boxes (tofu).

This script makes one small font for exactly those code points, taken from
Noto Sans Symbols 2, Noto Sans Symbols and Noto Sans Math (all SIL OFL 1.1,
no Reserved Font Name), in that order of preference,, and re-fits every glyph into JetBrains Mono's 0.6em cell so a symbol
sits inside its terminal cell instead of overlapping the next one:

  - code points JetBrains Mono already has are left out (it wins anyway);
  - default-emoji-presentation code points are left out, so emoji keep their
    colour emoji rendering;
  - every glyph is scaled down uniformly (never up) to fit 560 of the 600
    units, about its own centre, then centred in a 600-unit advance;
  - the family is renamed "PocketShell Symbols" (a modified version).

Run (inputs are verified against their sha256 before use):

  uv run --no-project --with fonttools==4.60.1 --with brotli \
    python -I packages/ui/scripts/build-symbol-font.py <dir with the three sources>

Sources (google/fonts):
  ofl/notosanssymbols2/NotoSansSymbols2-Regular.ttf @ 7b6724ac7ececc713e9ba93af309f7520c9a80a3
  ofl/notosanssymbols/NotoSansSymbols[wght].ttf      @ caa8c83707a5797d62fd02f14301391986f21d75
  ofl/notosansmath/NotoSansMath-Regular.ttf          @ dbd1ab6e65dc59bcda3ca8de9fd372f58f98e0af
"""
from __future__ import annotations

import hashlib
import sys
from pathlib import Path

from fontTools import subset
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

HERE = Path(__file__).resolve().parent
FONTS = HERE.parent / "src" / "assets" / "fonts"
OUT = FONTS / "PocketShellSymbols-Regular.woff2"
MONO = FONTS / "JetBrainsMono-Regular.woff2"

SOURCES = {
    "NotoSansSymbols2-Regular.ttf": "7d5fb73b7ca67a6798101741f5d280a3d016a56a197afcd4199dbb57b4b82a21",
    "NotoSansSymbols[wght].ttf": "f7e7e04b4a24b6c78893d50cbfd2b2f6cae49617ab047bfef668d252adb128f7",
    "NotoSansMath-Regular.ttf": "3f495fe933c06786e4d5f6d86b8ee70b6753a68ee3b9d87528726de0f6e2c47d",
}

# Symbol blocks terminal UIs draw from. Box drawing and blocks are NOT here:
# JetBrains Mono carries them, and they must line up with its cells exactly.
RANGES = [
    (0x2190, 0x21FF),  # Arrows
    (0x2200, 0x22FF),  # Mathematical Operators (⋯ ∴ …)
    (0x2300, 0x23FF),  # Miscellaneous Technical (⏵ ⏸ ⏺ ⎿ ⌘ …)
    (0x2460, 0x24FF),  # Enclosed Alphanumerics
    (0x25A0, 0x25FF),  # Geometric Shapes
    (0x2600, 0x26FF),  # Miscellaneous Symbols
    (0x2700, 0x27BF),  # Dingbats (✻ ✳ ✢ ✔ ✘ ❯ …)
    (0x27C0, 0x27EF),  # Miscellaneous Mathematical Symbols-A
    (0x27F0, 0x27FF),  # Supplemental Arrows-A
    (0x2900, 0x297F),  # Supplemental Arrows-B
    (0x2980, 0x29FF),  # Miscellaneous Mathematical Symbols-B (⧉ …)
    (0x2B00, 0x2BFF),  # Miscellaneous Symbols and Arrows
    (0x1F780, 0x1F7FF),  # Geometric Shapes Extended
    (0x1FB00, 0x1FBFF),  # Symbols for Legacy Computing
]

# Emoji_Presentation=Yes inside RANGES (Unicode 15.1 emoji-data.txt): left to
# the platform's colour emoji font.
EMOJI_PRESENTATION = [
    (0x231A, 0x231B), (0x23E9, 0x23EC), (0x23F0, 0x23F0), (0x23F3, 0x23F3),
    (0x25FD, 0x25FE), (0x2614, 0x2615), (0x2648, 0x2653), (0x267F, 0x267F),
    (0x2693, 0x2693), (0x26A1, 0x26A1), (0x26AA, 0x26AB), (0x26BD, 0x26BE),
    (0x26C4, 0x26C5), (0x26CE, 0x26CE), (0x26D4, 0x26D4), (0x26EA, 0x26EA),
    (0x26F2, 0x26F3), (0x26F5, 0x26F5), (0x26FA, 0x26FA), (0x26FD, 0x26FD),
    (0x2705, 0x2705), (0x270A, 0x270B), (0x2728, 0x2728), (0x274C, 0x274C),
    (0x274E, 0x274E), (0x2753, 0x2755), (0x2757, 0x2757), (0x2795, 0x2797),
    (0x27B0, 0x27B0), (0x27BF, 0x27BF), (0x2B1B, 0x2B1C), (0x2B50, 0x2B50),
    (0x2B55, 0x2B55), (0x1F7E0, 0x1F7EB), (0x1F7F0, 0x1F7F0),
]

ADVANCE = 600  # JetBrains Mono: 600 of 1000 units
FIT = 560  # leave 20 units each side so neighbours never touch
FAMILY = "PocketShell Symbols"


def expand(ranges: list[tuple[int, int]]) -> set[int]:
    return {cp for lo, hi in ranges for cp in range(lo, hi + 1)}


def verified(directory: Path, name: str) -> Path:
    path = directory / name
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != SOURCES[name]:
        sys.exit(f"{name}: sha256 {digest} != pinned {SOURCES[name]}")
    return path


def subset_to(font: TTFont, codepoints: set[int]) -> TTFont:
    options = subset.Options()
    options.layout_features = []  # no shaping features needed for single symbols
    # Math layout and vertical metrics are meaningless in a horizontal terminal cell.
    options.drop_tables += ["MATH", "vhea", "vmtx"]
    options.name_IDs = ["*"]
    options.notdef_outline = True
    options.recalc_bounds = True
    sub = subset.Subsetter(options)
    sub.populate(unicodes=sorted(codepoints))
    sub.subset(font)
    return font


def add_glyphs(base: TTFont, donor: TTFont, prefix: str) -> None:
    """Copy every mapped glyph of `donor` into `base`, decomposed, under `prefix`."""
    donor_glyphs = donor.getGlyphSet()
    added: dict[int, str] = {}
    for codepoint, name in donor.getBestCmap().items():
        new_name = prefix + name
        if new_name not in base["glyf"].glyphs:
            recording = DecomposingRecordingPen(donor_glyphs)
            donor_glyphs[name].draw(recording)
            pen = TTGlyphPen(None)
            recording.replay(pen)
            base["glyf"][new_name] = pen.glyph()
            base["hmtx"][new_name] = donor["hmtx"][name]
        added[codepoint] = new_name
    # glyf's own order already gained the new names; make the font's match it.
    base.setGlyphOrder(list(base["glyf"].glyphOrder))
    for table in base["cmap"].tables:
        if table.isUnicode():
            if table.format == 4:
                table.cmap.update({cp: n for cp, n in added.items() if cp <= 0xFFFF})
            else:
                table.cmap.update(added)


def refit(font: TTFont) -> None:
    glyph_set = font.getGlyphSet()
    glyf = font["glyf"]
    hmtx = font["hmtx"]
    for name in font.getGlyphOrder():
        if name == ".notdef":
            hmtx[name] = (ADVANCE, hmtx[name][1])
            continue
        bounds_pen = BoundsPen(glyph_set)
        glyph_set[name].draw(bounds_pen)
        recording = DecomposingRecordingPen(glyph_set)
        glyph_set[name].draw(recording)
        out = TTGlyphPen(None)
        if bounds_pen.bounds is None:  # a space-like glyph
            glyf[name] = out.glyph()
            hmtx[name] = (ADVANCE, 0)
            continue
        x0, y0, x1, y1 = bounds_pen.bounds
        width = x1 - x0
        scale = min(1.0, FIT / width) if width > 0 else 1.0
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        # Scale about the glyph's centre, then move that centre to the cell's.
        transform = (scale, 0, 0, scale, ADVANCE / 2 - scale * cx, cy - scale * cy)
        recording.replay(TransformPen(out, transform))
        glyf[name] = out.glyph()
        glyf[name].recalcBounds(glyf)
        hmtx[name] = (ADVANCE, glyf[name].xMin)


def rename(font: TTFont) -> None:
    names = font["name"]
    keep = {0, 7, 8, 9, 11, 12, 13, 14}  # copyright, trademark, designer, URLs, licence
    names.names = [n for n in names.names if n.nameID in keep]
    for name_id, value in {1: FAMILY, 2: "Regular", 3: f"{FAMILY} Regular; #3157",
                           4: f"{FAMILY} Regular", 5: "Version 1.000", 6: "PocketShellSymbols-Regular"}.items():
        names.setName(value, name_id, 3, 1, 0x409)
    font["post"].isFixedPitch = 1
    font["OS/2"].xAvgCharWidth = ADVANCE
    font["OS/2"].panose.bProportion = 9  # monospaced
    font["hhea"].advanceWidthMax = ADVANCE


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    sources = Path(sys.argv[1])
    mono = set(TTFont(MONO).getBestCmap())
    wanted = expand(RANGES) - expand(EMOJI_PRESENTATION) - mono

    symbols2 = TTFont(verified(sources, "NotoSansSymbols2-Regular.ttf"))
    from_symbols2 = wanted & set(symbols2.getBestCmap())
    symbols = instancer.instantiateVariableFont(
        TTFont(verified(sources, "NotoSansSymbols[wght].ttf")), {"wght": 400})
    from_symbols = (wanted - from_symbols2) & set(symbols.getBestCmap())
    math = TTFont(verified(sources, "NotoSansMath-Regular.ttf"))
    from_math = (wanted - from_symbols2 - from_symbols) & set(math.getBestCmap())

    # Symbols 2 is the base; the other two only fill code points it lacks.
    # Their glyphs are copied in decomposed (fontTools' Merger refuses fonts
    # whose head/OS2 tables differ, and every glyph is redrawn by refit anyway).
    merged = subset_to(symbols2, from_symbols2)
    for prefix, font, cps in (("sym.", symbols, from_symbols), ("math.", math, from_math)):
        add_glyphs(merged, subset_to(font, cps), prefix)

    refit(merged)
    rename(merged)
    # Reproducible output: keep the source's timestamps instead of "now".
    merged["head"].modified = merged["head"].created
    merged.recalcTimestamp = False
    merged.flavor = "woff2"
    merged.save(OUT)
    covered = set(TTFont(OUT).getBestCmap())
    print(f"{OUT.name}: {len(covered)} code points, {OUT.stat().st_size} bytes")
    print("sha256", hashlib.sha256(OUT.read_bytes()).hexdigest())
    missing = sorted(wanted - covered)
    print(f"not covered by any source: {len(missing)}")


if __name__ == "__main__":
    main()
