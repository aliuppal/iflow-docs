# vendor/

Third-party code that ships with the site. It is loaded from the site's own
origin, never from a CDN, because the Content-Security-Policy only allows
scripts from `'self'`.

| File | What | Version | Licence |
| --- | --- | --- | --- |
| `supabase.js` | `@supabase/supabase-js`, UMD build (`dist/umd/supabase.js`), unmodified | 2.109.0 | MIT (`supabase-js.LICENSE.txt`) |
| `pdfmake.min.js` | `pdfmake` browser build, unmodified | 0.3.11 | MIT (`pdfmake.LICENSE.txt`) |
| `pdfmake-vfs_fonts.js` | Roboto fonts for pdfmake, unmodified | 0.3.11 | Apache-2.0 (Roboto) |
| `pdf-mono-font.js` | Roboto Mono Regular (code blocks in PDFs), base64 in a small loader | Google Fonts | SIL OFL 1.1 (`roboto-mono.LICENSE.txt`) |

SHA-256 of `supabase.js`:
`9ccb70b99860bb81593bd808708f6e1ed86146ef138f1942a37eeb38519d5a81`

SHA-256 of the PDF files:

```
faaee53f8dcf48b0934553665809d8180e20e435b654f633df2f18f9dbdeaa88  pdfmake.min.js
1483ed267fe00ad90a3834441b019d856dd41ed079b2614404b2fcef425db6fc  pdfmake-vfs_fonts.js
d69db9e25d624955d6a699c5ed63b6e102266bcdcdaf7d61d725bb7fe28afbc6  pdf-mono-font.js
```

`supabase.js` is only downloaded when sign-in is configured in `src/config.js`.
The three PDF files (about 2 MB together) are only downloaded the first time someone
clicks Download PDF. `pdfmake.min.js` is the one place `new Function` appears, as the
standard `this || new Function("return this")()` fallback, which never runs in a
browser; the security policy forbids `eval`, and tests confirm the engine works under it.

To update it:

```bash
npm pack @supabase/supabase-js@<version>
# extract package/dist/umd/supabase.js and package/LICENSE into vendor/
# then update the version and hash above
```
