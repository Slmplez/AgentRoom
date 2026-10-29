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
