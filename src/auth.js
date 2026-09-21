/**
 * Google sign-in and the printed-documents counter, on Supabase.
 *
 * Nothing here runs unless src/config.js is filled in. When it is not, the
 * Supabase library is never downloaded and the page makes no network calls.
 *
 * What crosses the network once it is on:
 *   - the OAuth sign-in with Google, via Supabase;
 *   - "ensure_profile": your name, email and photo link (from Google);
 *   - "record_print": a number — how many PDF documents you just saved.
 * The integration files themselves, and their names and contents, are never sent.
 *
 * All database writes go through those two functions (supabase/schema.sql); the
 * browser cannot write to the table itself, so it cannot edit its own count.
 *
 * States: 'off' (not configured) | 'loading' | 'out' (signed out) | 'in'.
 */

import { CONFIG } from './config.js';

/**
 * Settings. On localhost only, a page may override them with
 * window.__IFLOW_CONFIG__ — that is how the tests point the site at a local
 * stand-in for Supabase. On any other host the override is ignored.
 */
function settings() {
  const override = location.hostname === 'localhost' && window.__IFLOW_CONFIG__ ? window.__IFLOW_CONFIG__ : {};
  return { ...CONFIG, ...override };
}

export function authConfigured() {
  const c = settings();
  return Boolean(c.supabaseUrl && c.supabaseAnonKey);
}

/** True when the tool may not be used until the visitor has signed in. */
export function signInRequired() {
  return authConfigured() && Boolean(settings().requireSignIn);
}

function loadLibrary() {
  if (window.supabase && window.supabase.createClient) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('../vendor/supabase.js', import.meta.url).href;
    script.onload = () => (window.supabase && window.supabase.createClient ? resolve() : reject(new Error('the sign-in library did not initialise')));
    script.onerror = () => reject(new Error('the sign-in library could not be loaded'));
    document.head.appendChild(script);
  });
}

/** Turn a Supabase/PostgREST error into something a person can act on. */
function friendly(error) {
  const msg = String((error && (error.message || error.error_description)) || error || 'unknown error');
  const code = error && error.code;
  if (code === 'PGRST202' || /could not find the function|schema cache/i.test(msg)) {
    return 'the database is not set up yet — run supabase/schema.sql in the Supabase SQL editor';
  }
  if (code === '42501' || /permission denied/i.test(msg)) return 'the database refused the request (check that supabase/schema.sql was run)';
  if (/jwt|token/i.test(msg) && /expired|invalid/i.test(msg)) return 'your session has expired — sign in again';
  if (/failed to fetch|networkerror|load failed/i.test(msg)) return 'could not reach Supabase — check your connection and the project URL in src/config.js';
  return msg;
}

export function createAuth({ onChange, onError }) {
  const state = {
    status: authConfigured() ? 'loading' : 'off',
    user: null,        // { id, email, name, avatar } from the Google account
    profile: null,     // the row from public.profiles, including the counters
    profileError: '',
  };
  let client = null;
  let profileFor = null;       // user id the profile was loaded for
  let profileLoading = null;   // in-flight load, so two events do not load twice

  const emit = () => onChange({ ...state });

  function pickUser(user) {
    const meta = (user && user.user_metadata) || {};
    return {
      id: user.id,
      email: user.email || '',
      name: meta.full_name || meta.name || '',
      avatar: meta.avatar_url || meta.picture || '',
    };
  }

  async function loadProfile() {
    if (profileLoading) return profileLoading;
    profileLoading = (async () => {
      const { data, error } = await client.rpc('ensure_profile', {
        p_full_name: state.user.name || null,
        p_avatar_url: state.user.avatar || null,
      });
      if (error) {
        state.profile = null;
        state.profileError = friendly(error);
      } else {
        state.profile = data;
        state.profileError = '';
      }
      emit();
    })().finally(() => { profileLoading = null; });
    return profileLoading;
  }

  async function handleSession(event, session) {
    if (!session) {
      state.status = 'out';
      state.user = null;
      state.profile = null;
      state.profileError = '';
      profileFor = null;
      emit();
      return;
    }

    state.status = 'in';
    state.user = pickUser(session.user);
    emit();

    // The address bar still carries ?code=… after the OAuth round trip.
    if (/[?&](code|error)=/.test(location.search)) history.replaceState(null, '', location.pathname);

    if (profileFor === session.user.id && (state.profile || event === 'TOKEN_REFRESHED')) return;
    profileFor = session.user.id;
    await loadProfile();
  }

  /** Google can send the visitor back with ?error_description=… (denied, cancelled…). */
  function reportReturnedError() {
    const query = new URLSearchParams(location.search);
    const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
    const description = query.get('error_description') || hash.get('error_description');
    if (description) {
      onError(`Sign-in did not complete: ${description}`);
      history.replaceState(null, '', location.pathname);
    }
  }

  async function start() {
    if (!authConfigured()) {
      emit();
      return;
    }
    try {
      await loadLibrary();
    } catch (err) {
      state.status = 'off';
      emit();
      onError(`Sign-in is unavailable: ${err.message}.`);
      return;
    }

    const c = settings();
    client = window.supabase.createClient(c.supabaseUrl, c.supabaseAnonKey, {
      auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    reportReturnedError();

    client.auth.onAuthStateChange((event, session) => {
      // supabase-js can deadlock if it is called from inside this callback.
      setTimeout(() => handleSession(event, session), 0);
    });
  }

  async function signIn() {
    if (!client) return;
    const { error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: location.origin + location.pathname,
        queryParams: { prompt: 'select_account' },
      },
    });
    if (error) onError(`Could not start Google sign-in: ${friendly(error)}.`);
  }

  async function signOut() {
    if (!client) return;
    const { error } = await client.auth.signOut();
    if (error) onError(`Could not sign out: ${friendly(error)}.`);
  }

  /** Add `documents` to this user's count. Rejects with a readable message on failure. */
  async function recordPrint(documents) {
    if (!client || state.status !== 'in') return null;
    const { data, error } = await client.rpc('record_print', { p_documents: documents });
    if (error) throw new Error(friendly(error));
    state.profile = data;
    state.profileError = '';
    emit();
    return data;
  }

  return { start, signIn, signOut, recordPrint, get state() { return { ...state }; } };
}
