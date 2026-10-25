# Fonts

`Geist-Variable.woff2` and `GeistMono-Variable.woff2` are copied unchanged from the `geist` npm
package, version 1.8.1 (`dist/fonts/geist-sans` and `dist/fonts/geist-mono`). They are licensed
under the SIL Open Font License 1.1; the licence and copyright notice are in
[`LICENSE.txt`](./LICENSE.txt) and must stay with the fonts.

They are vendored rather than installed because the `geist` package declares the Next.js framework
as a peer dependency, which pnpm installs automatically. This app does not use Next.js, and the
copy that arrived that way carried known critical advisories (and, through `sharp`, an LGPL
library) into the production dependency audit.
