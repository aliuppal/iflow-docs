# Turning on Google sign-in and the print counter

The code is done and tested. What is left is the part only you can do: create a
Supabase project, a Google OAuth client, and paste two values into
`src/config.js`. About 15 minutes.

Until you do, the site behaves exactly as before — no sign-in button, no network
calls, and the Supabase library is never downloaded.

## What you get

- A **Sign in with Google** button (optional by default; can be made mandatory).
- A profile per user: name, email, photo link.
- A **printed-documents counter** per user, shown in the top bar and in an
  account menu (documents printed, print jobs, last printed, member since).

**What is stored:** name, email, photo link, and the counters. **Never** the
integration files, their names, or their contents. The browser sends only a
number ("2 documents") when someone prints.

**What the count means:** the number of documents sent to the browser's print
dialog. A browser does not tell a page whether the user then printed or pressed
Cancel, so this measures print *requests*. It is also self-reported by the
browser — the database stops anyone editing the number directly, but a technical
user could still call the counting function repeatedly. Treat it as a usage
indicator, not as evidence.

## 1. Create the Supabase project

1. Go to <https://supabase.com>, sign in, **New project**. Pick a region near your users.
2. Open **Project Settings → API** and copy:
   - **Project URL** — like `https://abcdefghijklmnop.supabase.co`
   - the **anon / publishable** key.

   The anon key is *meant* to be in the page; the row-level security in step 2 is
   what protects the data. **Never** put the `service_role` key in `src/config.js`
   or anywhere that gets deployed.

## 2. Create the tables and functions

1. **SQL Editor → New query**.
2. Paste the whole of [`supabase/schema.sql`](supabase/schema.sql) and click **Run**.
3. **Table Editor** should now show a `profiles` table.

Safe to run again later. It is tested (`npm run test:sql`) against a real Postgres
engine: a signed-in user can read only their own row and cannot write to the table
at all — every change goes through two functions that act only on the caller's own
row.

## 3. Create the Google OAuth client

1. Open <https://console.cloud.google.com>, create or pick a project.
2. **APIs & Services → OAuth consent screen** (newer UI: *Google Auth Platform*):
   - User type **External**, app name (e.g. "iFlow Docs"), your support email.
   - Scopes: `openid`, `email`, `profile` only. These are non-sensitive, so no
     Google verification review is needed.
   - **Publishing status: In production.** In *Testing* mode only listed test
     users (max 100) can sign in and their sign-ins expire after 7 days.
3. **Credentials → Create credentials → OAuth client ID → Web application**.
   - **Authorized redirect URI:** `https://<your-project-ref>.supabase.co/auth/v1/callback`
     (Supabase shows the exact value on its Google provider page — copy it from there).
4. Copy the **Client ID** and **Client secret**.

## 4. Connect Google to Supabase

1. Supabase → **Authentication → Sign In / Providers → Google**.
2. Enable it, paste the Client ID and Client secret, **Save**.
3. **Authentication → URL Configuration**:
   - **Site URL:** `https://iflow-docs.vercel.app` (or your own domain)
   - **Redirect URLs:** add `https://iflow-docs.vercel.app/**` and, for local
     testing, `http://localhost:4173/**`

   Sign-in fails if the address the browser returns to is not on this list.

## 5. Put the two values in the site

Edit [`src/config.js`](src/config.js):

```js
export const CONFIG = {
  supabaseUrl: 'https://abcdefghijklmnop.supabase.co',
  supabaseAnonKey: 'eyJ…your anon key…',
  requireSignIn: false,   // true = nobody can load a file until they sign in
};
```

Then tighten the Content-Security-Policy in [`vercel.json`](vercel.json) from any
Supabase project to yours: change `connect-src https://*.supabase.co` to
`connect-src https://abcdefghijklmnop.supabase.co`.

## 6. Deploy and check

```powershell
cd C:\Claude_Demo\iflow-docs
npx vercel --prod --yes
```

Open the site → **Sign in with Google** → load a file → **Download PDF** →
the number next to your name goes up. In Supabase → Table Editor → `profiles`
you should see your row.

## Running it yourself

See who has used it, in the SQL Editor:

```sql
select email, full_name, documents_printed, print_jobs, last_printed_at
from public.profiles
order by documents_printed desc;
```

Delete a person's data: **Authentication → Users → delete the user**. Their
profile row is removed with them.

## Trying it locally without Google or Supabase

```powershell
node tools/mock-supabase.mjs                       # a local stand-in, port 54321
$env:IFLOW_EXTRA_CONNECT = "http://localhost:54321"; node serve.mjs
```

Then in the browser console at `http://localhost:4173`:

```js
window.__IFLOW_CONFIG__ = { supabaseUrl: 'http://localhost:54321', supabaseAnonKey: 'anon-test-key' }
```

and reload. The override is honoured on `localhost` only.

## If something goes wrong

| What you see | Cause |
| --- | --- |
| Google shows `redirect_uri_mismatch` | The redirect URI in the Google client is not exactly `https://<ref>.supabase.co/auth/v1/callback`. |
| Sign-in returns to the site but you are not signed in; "Sign-in did not complete…" | Site URL / Redirect URLs in Supabase (step 4.3) do not include the address you signed in from. |
| Only some people can sign in | The Google consent screen is still in *Testing* (step 3.2). |
| Signed in, but "the database is not set up yet" | `supabase/schema.sql` has not been run (step 2). |
| Signed in, count stays blank or a toast says it could not be updated | Open the browser's Network tab: a request to `/rest/v1/rpc/record_print` shows the reason. A CSP error means the project URL in `vercel.json` does not match `src/config.js`. |
