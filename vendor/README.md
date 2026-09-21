# vendor/

Third-party code that ships with the site. It is loaded from the site's own
origin, never from a CDN, because the Content-Security-Policy only allows
scripts from `'self'`.

| File | What | Version | Licence |
| --- | --- | --- | --- |
| `supabase.js` | `@supabase/supabase-js`, UMD build (`dist/umd/supabase.js`), unmodified | 2.109.0 | MIT (`supabase-js.LICENSE.txt`) |

SHA-256 of `supabase.js`:
`9ccb70b99860bb81593bd808708f6e1ed86146ef138f1942a37eeb38519d5a81`

It is only downloaded by the browser when sign-in is configured in
`src/config.js`. With the config left empty, this file is never requested.

To update it:

```bash
npm pack @supabase/supabase-js@<version>
# extract package/dist/umd/supabase.js and package/LICENSE into vendor/
# then update the version and hash above
```
