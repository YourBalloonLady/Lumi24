(function () {
  'use strict';

  const ADMIN_EMAIL = 'luminaweight@gmail.com';
  const BACKUP_KEY = 'lumina_admin_session_backup_v1';

  function storage() {
    try {
      return window.localStorage;
    } catch (_) {
      return null;
    }
  }

  function projectStorageKey(url) {
    try {
      const projectRef = new URL(url).hostname.split('.')[0];
      return projectRef ? `sb-${projectRef}-auth-token` : '';
    } catch (_) {
      return '';
    }
  }

  function readBackup(store) {
    if (!store) return null;
    try {
      const value = JSON.parse(store.getItem(BACKUP_KEY) || 'null');
      const session = value?.session;
      const email = String(session?.user?.email || '').trim().toLowerCase();
      if (email !== ADMIN_EMAIL || !session?.access_token || !session?.refresh_token) return null;
      return session;
    } catch (_) {
      return null;
    }
  }

  function saveAdminSession(store, session) {
    if (!store || !session) return;
    const email = String(session?.user?.email || '').trim().toLowerCase();
    if (email !== ADMIN_EMAIL || !session.access_token || !session.refresh_token) return;
    try {
      store.setItem(BACKUP_KEY, JSON.stringify({
        session,
        saved_at: new Date().toISOString()
      }));
    } catch (_) {}
  }

  function clearAdminSession(store) {
    if (!store) return;
    try {
      store.removeItem(BACKUP_KEY);
    } catch (_) {}
  }

  function createClient(url, anonKey, options) {
    const store = storage();
    const storageKey = projectStorageKey(url);
    const backup = readBackup(store);

    // Restore the owner's last refreshable session before Supabase initializes.
    // Other accounts continue to use Supabase's normal session behaviour.
    if (store && storageKey && backup && !store.getItem(storageKey)) {
      try {
        store.setItem(storageKey, JSON.stringify(backup));
      } catch (_) {}
    }

    const supplied = options || {};
    const client = window.supabase.createClient(url, anonKey, {
      ...supplied,
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        ...(supplied.auth || {}),
        storage: supplied.auth?.storage || store || undefined
      }
    });

    client.auth.onAuthStateChange((_event, session) => {
      saveAdminSession(store, session);
    });

    client.auth.getSession()
      .then(({ data }) => saveAdminSession(store, data?.session))
      .catch(() => {});

    const originalSignOut = client.auth.signOut.bind(client.auth);
    client.auth.signOut = async function (...args) {
      clearAdminSession(store);
      return originalSignOut(...args);
    };

    return client;
  }

  window.LuminaAuth = Object.freeze({
    createClient,
    clearAdminSession: function () {
      clearAdminSession(storage());
    }
  });
})();
