// ─── Supabase Auth Module ─────────────────────────────────────────────────────
// Loaded by all pages via <script src="/auth.js">.
// Requires: <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2">
//           loaded BEFORE this file in each page's <head>.

(function () {
  // ── Config ─────────────────────────────────────────────────────────────────
  // Replace these two values with your Supabase project's URL and anon key.
  // Find them at: Supabase Dashboard → Project Settings → API
  const SUPABASE_URL  = 'https://phyxlpdfvruyigmpdqqi.supabase.co';
  const SUPABASE_ANON = 'sb_publishable_h5ytx958k5ACPKdD92Ob_w_H7_1LN1-';

  const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

  // ── Fetch interceptor ──────────────────────────────────────────────────────
  // Patches window.fetch so every /api/* request automatically gets
  // Authorization: Bearer <token>.  All existing fetch() calls in the pages
  // are unmodified — this layer is invisible to them.
  // getSession() is called on every request (not a cached token) so Supabase
  // can silently refresh the access token when it expires (~1 hour).
  const _nativeFetch = window.fetch.bind(window);

  window.fetch = async function (input, init) {
    init = init || {};
    const url = typeof input === 'string' ? input : (input && input.url);
    if (url && url.startsWith('/api/')) {
      const { data } = await supabase.auth.getSession();
      const token = data && data.session && data.session.access_token;
      if (token) {
        init = {
          ...init,
          headers: {
            ...init.headers,
            'Authorization': 'Bearer ' + token
          }
        };
      }
    }
    return _nativeFetch(input, init);
  };

  // ── requireAuth ────────────────────────────────────────────────────────────
  // Call at the very start of each page's init, before loading any data.
  //   allowedRoles: string[]  e.g. ['admin'] or ['admin', 'proclean']
  // Returns the user object (with .role and .fullName) on success.
  // Redirects and never resolves on failure.
  window.requireAuth = async function (allowedRoles) {
    // Hide the page immediately to prevent a flash of unstyled/unauth content.
    document.body.style.visibility = 'hidden';

    const { data: { session }, error } = await supabase.auth.getSession();

    if (error || !session) {
      const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.replace('/login.html?redirect=' + returnTo);
      return new Promise(function () {}); // never resolves — page is navigating away
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('role, full_name, email')
      .eq('id', session.user.id)
      .single();

    if (profileError || !profile) {
      window.location.replace('/login.html?error=profile_missing');
      return new Promise(function () {});
    }

    if (!allowedRoles.includes(profile.role)) {
      // Redirect to the page the user IS allowed on
      const roleDefaults = {
        admin:      '/',
        proclean:   '/proclean.html',
        production: '/production'
      };
      window.location.replace(roleDefaults[profile.role] || '/login.html?error=forbidden');
      return new Promise(function () {});
    }

    // Auth passed — reveal the page and return the user.
    // Must use 'visible' (not '') because '' just removes the inline style,
    // leaving the CSS rule `body { visibility: hidden }` still active.
    document.documentElement.style.visibility = 'visible';
    document.body.style.visibility = 'visible';
    return {
      id:       session.user.id,
      email:    session.user.email,
      role:     profile.role,
      fullName: profile.full_name
    };
  };

  // ── signOut ────────────────────────────────────────────────────────────────
  window.signOut = async function () {
    await supabase.auth.signOut();
    window.location.replace('/login.html');
  };

  // ── Expose the client (used by login.html) ─────────────────────────────────
  window._supabaseClient = supabase;
})();
