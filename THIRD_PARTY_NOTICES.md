# Third-party notices

## hcom native core

Agent Room vendors and modifies [aannoo/hcom](https://github.com/aannoo/hcom),
MIT License, Copyright (c) 2025 aannoo. The complete license is retained in
[native/hcom/LICENSE](native/hcom/LICENSE), with source provenance and changes in
[native/hcom/SOURCE.md](native/hcom/SOURCE.md). The native build copies the license
beside the binaries. hcom embeds Microsoft ConPTY assets; their bundled license is
retained by the upstream extraction code beside the extracted assets.

## xterm.js

The interactive terminal uses `@xterm/xterm` and `@xterm/addon-fit` (MIT).
`scripts/copy-terminal-assets.cjs` copies the package license files alongside the
local browser assets. No terminal JavaScript or styles are loaded from a CDN.

## Model Context Protocol SDK

The unified MCP Hub and generated Pi bridge use `@modelcontextprotocol/sdk`.
The package retains the following license in `node_modules/@modelcontextprotocol/sdk/LICENSE`:

MIT License

Copyright (c) 2024 Anthropic, PBC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## UI design references

Agent Room's `renderer/design-tokens.css` adapts a subset of the surface, color,
radius and timing values documented by [Caho1/open-claude-ui](https://github.com/Caho1/open-claude-ui),
specifically `code-examples/cds-theme.css` and the v2 design-system documentation.
The layout and application behavior are implemented locally in Agent Room.

## open-claude-ui

MIT License

Copyright (c) 2026 Caho1

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## @pierre/diffs

文件差异预览使用 [@pierre/diffs](https://github.com/pierrecomputer/pierre)，版本 1.6.2，Apache-2.0。构建时复制其许可证到 `renderer/vendor/diffs/LICENSE.txt`。库与语法高亮资源本地打包，不加载远程 CDN。

## React chat interface

The opt-in chat interface uses React, React DOM, `@assistant-ui/react`,
`@assistant-ui/core`, `@assistant-ui/store`, `@assistant-ui/react-markdown`, and Zod.
The build copies their package LICENSE files into `renderer/vendor/chat/` and
retains dependency legal comments in adjacent generated `.LEGAL.txt` files.
All chat resources are bundled locally. The Mock-only results examples use
`@json-render/core` and `@json-render/react` 0.21.3 under Apache-2.0. Their license
is retained in `renderer/chat/LICENSE.json-render.txt`; the fixed example catalog
does not execute model output or submit business commands.

## Bundled typography

Inter, Newsreader and JetBrains Mono are distributed locally as variable WOFF2
fonts (Latin and extended Latin, upright and italic), from the corresponding
`@fontsource-variable` packages pinned to 5.3.0. They are licensed under SIL OFL
1.1; the original licenses and exact source URLs / file hashes are retained in
`renderer/assets/fonts/`. No runtime font CDN is used. Chinese glyphs fall back
to the configured platform fonts.
