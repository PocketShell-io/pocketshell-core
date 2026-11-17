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
