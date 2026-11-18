# Bundled fonts

`JetBrainsMono-Regular.woff2` and `JetBrainsMono-Bold.woff2` are the unmodified
`fonts/webfonts/` files from JetBrains Mono **v2.304**
(https://github.com/JetBrains/JetBrainsMono/releases/tag/v2.304), licensed
under the SIL Open Font License 1.1 (`JetBrainsMono-OFL.txt`).

They are the complete faces, not the Fontsource per-script subsets, on purpose:
the Fontsource latin/latin-ext/cyrillic subsets contain no box-drawing, block
or arrow glyphs (verified: 0 of the 128 U+2500-257F codepoints), and a TUI or a
tmux border drawn from a fallback face does not line up with the cells. These
files carry latin, latin-ext, cyrillic, greek, all 128 box-drawing and 32 block
glyphs, arrows and powerline separators (1363 codepoints each).

sha256:
- `JetBrainsMono-Regular.woff2` a9cb1cd82332b23a47e3a1239d25d13c86d16c4220695e34b243effa999f45f2
- `JetBrainsMono-Bold.woff2`    c503cc5ec5f8b2c7666b7ecda1adf44bd45f2e6579b2eba0fc292150416588a2

Declared in `../../fonts.css`.

## Symbol fallback (#3157)

`PocketShellSymbols-Regular.woff2` is the terminal's symbol fallback: the symbol
blocks terminal UIs draw (Claude Code's `⏵⏵ ✻ ⎿ ❯ ● ○ ⧉`, arrows, geometric
shapes, dingbats, technical and math symbols) that JetBrains Mono does not
have, and that a phone has no system font for, so they rendered as tofu. It
is cut by `../../../scripts/build-symbol-font.py` from Noto Sans Symbols 2,
Noto Sans Symbols and Noto Sans Math (google/fonts, commits and sha256 pinned
in the script; SIL OFL 1.1, no Reserved Font Name), minus anything JetBrains
Mono covers and anything with default emoji presentation. Every glyph is
scaled down (never up) to fit JetBrains Mono's 600-unit cell and centred in
it, so a symbol stays inside its terminal cell. As a modified version it is
renamed "PocketShell Symbols". Licence: `PocketShellSymbols-OFL.txt`.

Rebuild (reproducible; prints this sha256):

    uv run --no-project --with fonttools==4.60.1 --with brotli \
      python -I packages/ui/scripts/build-symbol-font.py <dir with the three sources>

- `PocketShellSymbols-Regular.woff2` ae259c91cc2d1f7f656baed51e25b6a74d14bde15b209728e4f8eff003b1565a (1809 code points)

Declared in `../../fonts.css` with a `unicode-range` of the symbol blocks only.
