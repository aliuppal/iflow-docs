/**
 * Sign-in and usage-count settings.
 *
 * Leave supabaseUrl and supabaseAnonKey empty and the site behaves exactly as it
 * did before accounts existed: no sign-in button, no network calls, and the
 * Supabase library is never even downloaded.
 *
 * Fill them in (see SETUP-SUPABASE.md) to turn on Google sign-in and the count
 * of documents each user has printed.
 *
 * The anon key is a PUBLIC key, meant to be in the page; what protects the data
 * is the row-level security in supabase/schema.sql. Never put the service_role
 * key here, or in any file that is deployed.
 */
export const CONFIG = {
  /** e.g. https://rmxpderufuwsmxynerzf.supabase.co */
  supabaseUrl: 'https://rmxpderufuwsmxynerzf.supabase.co',

  /** The "anon" / "publishable" key from Project Settings > API. */
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJteHBkZXJ1ZnV3c214eW5lcnpmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk4NTM2NzYsImV4cCI6MjEwNTQyOTY3Nn0.H7bZ1RWCnrTlZ4Y3hRukLYoq5MyYFU7a0EIAycoTSIg',

  /**
   * false: anyone can use the tool; signing in is optional, and only signed-in
   *        users have their printed documents counted.
   * true:  the tool is unusable until the visitor signs in with Google.
   */
  requireSignIn: true,
};
