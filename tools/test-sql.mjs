/**
 * Tests supabase/schema.sql against a real Postgres engine (PGlite, in-process).
 *
 *   npm run test:sql
 *
 * The point is the permission model, not the syntax. The browser holds a public
 * key and acts as the "authenticated" role, so this test does exactly that: it
 * stands up Supabase's roles, its default grants (which hand new tables to
 * anon/authenticated) and auth.uid(), loads the schema, and then tries — as an
 * ordinary user — to read other people's rows and to write its own counter.
 * Each attack must fail, and each legitimate call must work.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const SCHEMA = await readFile(fileURLToPath(new URL('../supabase/schema.sql', import.meta.url)), 'utf8');

let failures = 0;
let checks = 0;
const check = (label, ok, detail = '') => {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? ' — ' + detail : ''}`);
};

const ALICE = '11111111-1111-1111-1111-111111111111';
const BOB = '22222222-2222-2222-2222-222222222222';
const CAROL = '33333333-3333-3333-3333-333333333333';

async function freshDatabase() {
  const db = new PGlite();
  // A stand-in for the parts of Supabase the schema depends on.
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
    create function auth.uid() returns uuid language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
    grant usage on schema public, auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    -- What Supabase does by default: new tables in public are open to both roles.
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on functions to anon, authenticated;
  `);
  await db.exec(`
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${ALICE}', 'alice@example.com', '{"full_name":"Alice Adams","picture":"https://lh3.googleusercontent.com/alice"}'),
      ('${BOB}',   'bob@example.com',   '{"name":"Bob Brown"}'),
      ('${CAROL}', 'carol@example.com', '{}');
  `);
  await db.exec(SCHEMA);
  return db;
}

/** Run `fn` the way PostgREST does: as a role, with the JWT claims set. */
async function as(db, role, uid, fn) {
  const claims = uid ? JSON.stringify({ sub: uid, role }) : '';
  await db.exec(`set role ${role}`);
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [claims]);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '', false)`);
  }
}

/** Run a statement expected to fail; return the error message, or '' if it succeeded. */
async function failure(promise) {
  try {
    await promise;
    return '';
  } catch (err) {
    return String(err.message || err);
  }
}

const db = await freshDatabase();
const q = (sql, params) => db.query(sql, params);

console.log('\nSigned-out visitors (anon key only)');
check('cannot read profiles', /permission denied/i.test(await failure(as(db, 'anon', null, () => q('select * from public.profiles')))));
check('cannot call ensure_profile', /permission denied/i.test(await failure(as(db, 'anon', null, () => q('select public.ensure_profile()')))));
check('cannot call record_print', /permission denied/i.test(await failure(as(db, 'anon', null, () => q('select public.record_print(5)')))));
check('cannot write to profiles', /permission denied/i.test(await failure(as(db, 'anon', null, () => q(`insert into public.profiles (id) values ('${ALICE}')`)))));

console.log('\nFirst sign-in creates a profile from the Google account');
const alice = await as(db, 'authenticated', ALICE, () => q('select * from public.ensure_profile()'));
const a = alice.rows[0];
check('profile created for the caller', a && a.id === ALICE);
check('email comes from auth.users', a.email === 'alice@example.com');
check('name comes from Google metadata', a.full_name === 'Alice Adams', String(a.full_name));
check('photo link comes from Google metadata', a.avatar_url === 'https://lh3.googleusercontent.com/alice', String(a.avatar_url));
check('counters start at zero', a.documents_printed === 0 && a.print_jobs === 0 && a.last_printed_at === null);

const bob = (await as(db, 'authenticated', BOB, () => q('select * from public.ensure_profile()'))).rows[0];
check('a name stored under "name" instead of "full_name" is still picked up', bob.full_name === 'Bob Brown', String(bob.full_name));

const spoof = (await as(db, 'authenticated', CAROL, () => q(`select * from public.ensure_profile('Carol Chosen', 'https://x.test/c.png')`))).rows[0];
check('the browser may suggest a display name and photo', spoof.full_name === 'Carol Chosen' && spoof.avatar_url === 'https://x.test/c.png');
const carolEmail = (await as(db, 'authenticated', CAROL, () => q(`select email from public.ensure_profile('x','y')`))).rows[0].email;
check('...but the email can never be supplied by the browser', carolEmail === 'carol@example.com');

console.log('\nReading: only your own row');
const seen = (await as(db, 'authenticated', ALICE, () => q('select id from public.profiles'))).rows;
check('a user sees exactly one row, their own', seen.length === 1 && seen[0].id === ALICE, JSON.stringify(seen));
const peek = (await as(db, 'authenticated', ALICE, () => q('select * from public.profiles where id = $1', [BOB]))).rows;
check('asking for someone else\'s row returns nothing', peek.length === 0);

console.log('\nWriting: the browser cannot touch the table directly');
const tamper = await failure(as(db, 'authenticated', ALICE, () => q('update public.profiles set documents_printed = 999999 where id = $1', [ALICE])));
check('cannot set their own counter', /permission denied/i.test(tamper), tamper || 'update succeeded');
check('cannot set someone else\'s counter', /permission denied/i.test(await failure(as(db, 'authenticated', ALICE, () => q('update public.profiles set documents_printed = 0 where id = $1', [BOB])))));
check('cannot insert a row', /permission denied/i.test(await failure(as(db, 'authenticated', ALICE, () => q(`insert into public.profiles (id, documents_printed) values (gen_random_uuid(), 50)`)))));
check('cannot delete a row', /permission denied/i.test(await failure(as(db, 'authenticated', ALICE, () => q('delete from public.profiles where id = $1', [ALICE])))));
check('cannot rewrite their email', /permission denied/i.test(await failure(as(db, 'authenticated', ALICE, () => q(`update public.profiles set email = 'x@y.z' where id = $1`, [ALICE])))));
check('the counter is untouched after all of that', (await q('select documents_printed from public.profiles where id = $1', [ALICE])).rows[0].documents_printed === 0);

console.log('\nCounting prints through record_print');
let row = (await as(db, 'authenticated', ALICE, () => q('select * from public.record_print(3)'))).rows[0];
check('3 documents in one job', row.documents_printed === 3 && row.print_jobs === 1, JSON.stringify(row));
check('last_printed_at is set', row.last_printed_at !== null);
row = (await as(db, 'authenticated', ALICE, () => q('select * from public.record_print(2)'))).rows[0];
check('counters accumulate (5 documents, 2 jobs)', row.documents_printed === 5 && row.print_jobs === 2, JSON.stringify(row));
check('another user\'s count is unaffected', (await q('select documents_printed from public.profiles where id = $1', [BOB])).rows[0].documents_printed === 0);

for (const bad of [0, -1, 101, 1000000]) {
  const msg = await failure(as(db, 'authenticated', ALICE, () => q('select public.record_print($1)', [bad])));
  check(`record_print(${bad}) is rejected`, /between 1 and 100/.test(msg), msg || 'accepted');
}
check('record_print(null) is rejected', /between 1 and 100/.test(await failure(as(db, 'authenticated', ALICE, () => q('select public.record_print(null)')))));
check('rejected calls changed nothing', (await q('select documents_printed, print_jobs from public.profiles where id = $1', [ALICE])).rows[0].documents_printed === 5);
check('record_print(100), the largest allowed job, works', (await as(db, 'authenticated', ALICE, () => q('select * from public.record_print(100)'))).rows[0].documents_printed === 105);

console.log('\nEdge cases');
const noSub = await failure(as(db, 'authenticated', null, () => q('select public.record_print(1)')));
check('a signed-in role with no user id is refused', /not authenticated/.test(noSub), noSub);
const dave = '44444444-4444-4444-4444-444444444444';
await db.exec(`insert into auth.users (id, email) values ('${dave}', 'dave@example.com')`);
const lazy = (await as(db, 'authenticated', dave, () => q('select * from public.record_print(2)'))).rows[0];
check('printing before any ensure_profile creates the profile and counts', lazy.email === 'dave@example.com' && lazy.documents_printed === 2 && lazy.print_jobs === 1, JSON.stringify(lazy));
const again = (await as(db, 'authenticated', ALICE, () => q(`select * from public.ensure_profile('Renamed', null)`))).rows[0];
check('ensure_profile again does not reset the counters', again.documents_printed === 105 && again.print_jobs === 3);
check('...and does not overwrite a name already stored', again.full_name === 'Alice Adams', String(again.full_name));
const long = (await as(db, 'authenticated', BOB, () => q(`select * from public.ensure_profile($1, null)`, ['x'.repeat(5000)]))).rows[0];
check('oversized names are clipped', long.full_name === 'Bob Brown' || long.full_name.length <= 200);

console.log('\nDeleting the auth user removes the profile');
await db.exec(`delete from auth.users where id = '${dave}'`);
check('profile cascades away', (await q('select count(*)::int as n from public.profiles where id = $1', [dave])).rows[0].n === 0);

console.log('\nThe schema can be run twice');
const rerun = await failure(db.exec(SCHEMA));
check('re-running schema.sql succeeds', rerun === '', rerun);
check('...and keeps the data', (await q('select documents_printed from public.profiles where id = $1', [ALICE])).rows[0].documents_printed === 105);
const stillSealed = await failure(as(db, 'authenticated', ALICE, () => q('update public.profiles set documents_printed = 1 where id = $1', [ALICE])));
check('...and is still sealed after the second run', /permission denied/i.test(stillSealed));

console.log(`\n${checks - failures}/${checks} SQL checks passed.`);
process.exit(failures ? 1 : 0);
