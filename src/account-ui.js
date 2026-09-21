/**
 * The account area of the page: the Google button, the signed-in chip with the
 * printed-documents count, the account menu, and the sign-in gate.
 *
 * Everything that comes from Google or the database (name, email, photo link)
 * is written with textContent or a validated property — never as HTML — so a
 * display name like "<img onerror=…>" is shown as text and does nothing.
 */

const $ = (id) => document.getElementById(id);

const DATE = { year: 'numeric', month: 'short', day: 'numeric' };
const formatDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, DATE) : '–');
const formatCount = (n) => (Number.isFinite(n) ? n.toLocaleString() : '–');

function initials(name, email) {
  const source = (name || email || '?').trim();
  const words = source.split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[words.length - 1][0] : source.slice(0, 2);
  return letters.toUpperCase();
}

/** A photo if there is a safe one; otherwise initials on a coloured disc. */
function paintAvatar(el, url, name, email) {
  el.textContent = '';
  el.classList.remove('has-photo');
  const safe = typeof url === 'string' && /^https:\/\//i.test(url);
  if (!safe) {
    el.textContent = initials(name, email);
    return;
  }
  const img = document.createElement('img');
  img.alt = '';
  img.referrerPolicy = 'no-referrer';
  img.addEventListener('error', () => {
    el.textContent = initials(name, email);
    el.classList.remove('has-photo');
  });
  img.src = url;
  el.classList.add('has-photo');
  el.appendChild(img);
}

/**
 * @param {{ signIn: () => void, signOut: () => void, required: boolean }} actions
 * @returns {{ render: (state: object) => void }}
 */
export function mountAccount(actions) {
  const ui = {
    root: $('account'),
    signIn: $('btn-signin'),
    chip: $('btn-account'),
    avatar: $('acct-avatar'),
    name: $('acct-name'),
    count: $('acct-count'),
    menu: $('account-menu'),
    menuAvatar: $('menu-avatar'),
    menuName: $('menu-name'),
    menuEmail: $('menu-email'),
    menuError: $('menu-error'),
    docs: $('stat-docs'),
    jobs: $('stat-jobs'),
    last: $('stat-last'),
    since: $('stat-since'),
    signOut: $('btn-signout'),
    gate: $('gate'),
    gateButton: $('btn-signin-gate'),
    dropzone: $('dropzone'),
    privacy: $('privacy-note'),
  };
  const defaultPrivacy = ui.privacy.innerHTML;
  let lastCount = null;

  /* ---------------- menu open / close ---------------- */

  const setMenu = (open) => {
    ui.menu.hidden = !open;
    ui.chip.setAttribute('aria-expanded', String(open));
  };
  ui.chip.addEventListener('click', (e) => {
    e.stopPropagation();
    setMenu(ui.menu.hidden);
  });
  document.addEventListener('click', (e) => {
    if (!ui.menu.hidden && !ui.root.contains(e.target)) setMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !ui.menu.hidden) {
      setMenu(false);
      ui.chip.focus();
    }
  });

  ui.signIn.addEventListener('click', () => actions.signIn());
  ui.gateButton.addEventListener('click', () => actions.signIn());
  ui.signOut.addEventListener('click', () => {
    setMenu(false);
    actions.signOut();
  });

  /* ---------------- rendering ---------------- */

  function renderPrivacy(status) {
    if (status === 'off') {
      ui.privacy.innerHTML = defaultPrivacy;
      return;
    }
    // Once accounts exist, "nothing leaves this machine" would no longer be true
    // of everything, so the note says exactly what does and does not.
    ui.privacy.textContent = '';
    const strong = document.createElement('strong');
    strong.textContent = 'Your files never leave this machine.';
    ui.privacy.append(
      strong,
      actions.required
        ? ' The archive is read in your browser and nothing in it is uploaded. Signing in with Google is required to use the tool; it stores only your name, email and a count of the documents you print.'
        : ' The archive is read in your browser and nothing in it is uploaded. Signing in with Google is optional; if you do, only your name, email and a count of the documents you print are stored.'
    );
  }

  function render(state) {
    const { status, user, profile, profileError } = state;
    document.body.dataset.auth = status;
    renderPrivacy(status);

    // Not configured, or still working out whether someone is signed in.
    ui.root.hidden = status === 'off' || status === 'loading';
    // When sign-in is required the gate carries the button; a second one in the top bar is noise.
    ui.signIn.hidden = status !== 'out' || actions.required;
    ui.chip.hidden = status !== 'in';
    if (status !== 'in') setMenu(false);

    // The gate: hides the dropzone until the visitor has signed in.
    ui.gate.hidden = !(actions.required && status === 'out');
    ui.dropzone.hidden = actions.required && status !== 'in';

    if (status !== 'in' || !user) {
      lastCount = null;
      return;
    }

    const label = user.name || user.email || 'Signed in';
    ui.name.textContent = label;
    paintAvatar(ui.avatar, user.avatar, user.name, user.email);
    paintAvatar(ui.menuAvatar, user.avatar, user.name, user.email);
    ui.menuName.textContent = label;
    ui.menuEmail.textContent = user.email;

    ui.menuError.hidden = !profileError;
    ui.menuError.textContent = profileError ? `Your usage count is unavailable: ${profileError}.` : '';

    const printed = profile ? profile.documents_printed : NaN;
    ui.count.textContent = profile ? `${formatCount(printed)} printed` : '…';
    ui.count.hidden = !profile && Boolean(profileError);
    ui.docs.textContent = formatCount(printed);
    ui.jobs.textContent = formatCount(profile ? profile.print_jobs : NaN);
    ui.last.textContent = profile ? formatDate(profile.last_printed_at) : '–';
    ui.since.textContent = profile ? formatDate(profile.created_at) : '–';

    // A brief nudge when the number goes up, so a print visibly registers.
    if (profile && lastCount !== null && printed > lastCount) {
      ui.count.classList.remove('bump');
      void ui.count.offsetWidth;
      ui.count.classList.add('bump');
    }
    lastCount = profile ? printed : lastCount;
  }

  return { render };
}
