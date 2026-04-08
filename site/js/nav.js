/* ───────────────────────────────────────────────
   nav.js — Shared navbar for all protected pages
   Usage: Nav.init('pageId').then(({ user, profile }) => ...)
   Pages: games.html, messenger.html, support.html
   ─────────────────────────────────────────────── */

const Nav = (() => {

  /* ── Public init ── */
  function init(activePageId) {
    return new Promise(resolve => {
      auth.onAuthStateChanged(async user => {
        if (!user) {
          window.location.replace('index.html');
          return;
        }

        // Load Firestore profile
        let profile;
        try {
          const doc = await db.collection('users').doc(user.uid).get();
          profile = doc.exists
            ? doc.data()
            : { username: user.displayName || 'User', avatar: '', status: '' };
        } catch {
          profile = { username: user.displayName || 'User', avatar: '', status: '' };
        }

        // Show app
        document.getElementById('loading-screen').style.display = 'none';
        document.getElementById('app').style.display = '';

        // Wire everything
        _renderUserUI(user, profile);
        _setActive(activePageId);
        _setupEvents(user, profile);
        _setupPresence(user);
        _listenNotifications(user);

        resolve({ user, profile });
      });
    });
  }

  /* ── Render avatar + username in navbar and dropdown ── */
  function _renderUserUI(user, profile) {
    const name = profile.username || 'User';
    const av   = profile.avatar   || '';

    const navAv = document.getElementById('nav-avatar');
    navAv.innerHTML = av
      ? '<img src="' + _esc(av) + '" alt="">'
      : name.charAt(0).toUpperCase();

    document.getElementById('nav-username').textContent = name;

    const ddAv = document.getElementById('profile-dd-avatar');
    ddAv.innerHTML = av
      ? '<img src="' + _esc(av) + '" alt="">'
      : name.charAt(0).toUpperCase();

    document.getElementById('profile-dd-name').textContent  = name;
    document.getElementById('profile-dd-email').textContent = user.email || '';
    document.getElementById('profile-status').value         = profile.status || '';
  }

  /* ── Mark the correct nav link active ── */
  function _setActive(pageId) {
    document.querySelectorAll('.nav-link[data-page]').forEach(l => {
      l.classList.toggle('active', l.dataset.page === pageId);
    });
  }

  /* ── Wire all navbar event listeners ── */
  function _setupEvents(user, profile) {
    document.getElementById('nav-avatar').addEventListener('click', _toggleProfile);
    document.getElementById('nav-username').addEventListener('click', _toggleProfile);
    document.getElementById('notif-bell').addEventListener('click', _toggleNotifs);

    document.getElementById('profile-dd-avatar').addEventListener('click', () =>
      document.getElementById('avatar-upload').click()
    );
    document.getElementById('avatar-upload').addEventListener('change', e =>
      _handleAvatarChange(e, user, profile)
    );
    document.getElementById('save-profile-btn').addEventListener('click', () =>
      _saveProfile(user, profile)
    );
    document.getElementById('btn-logout').addEventListener('click', () =>
      auth.signOut().then(() => window.location.replace('index.html'))
    );

    // Close dropdowns on outside click
    document.addEventListener('click', e => {
      const pd = document.getElementById('profile-dropdown');
      const nd = document.getElementById('notif-dropdown');
      if (pd.classList.contains('open') &&
          !pd.contains(e.target) &&
          !document.getElementById('nav-avatar').contains(e.target) &&
          e.target.id !== 'nav-username') {
        pd.classList.remove('open');
      }
      if (nd.classList.contains('open') &&
          !nd.contains(e.target) &&
          !document.getElementById('notif-bell').contains(e.target)) {
        nd.classList.remove('open');
      }
    });
  }

  function _toggleProfile() {
    document.getElementById('profile-dropdown').classList.toggle('open');
    document.getElementById('notif-dropdown').classList.remove('open');
  }

  function _toggleNotifs() {
    document.getElementById('notif-dropdown').classList.toggle('open');
    document.getElementById('profile-dropdown').classList.remove('open');
  }

  /* ── Avatar upload via Cloudinary ── */
  async function _handleAvatarChange(e, user, profile) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { showToast('Image must be under 5 MB', 'error'); return; }
    showToast('Uploading...', 'info');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('upload_preset', CLOUDINARY_PRESET);
      const res = await fetch(
        'https://api.cloudinary.com/v1_1/' + CLOUDINARY_CLOUD + '/image/upload',
        { method: 'POST', body: fd }
      );
      const data = await res.json();
      if (data.secure_url) {
        await db.collection('users').doc(user.uid).update({ avatar: data.secure_url });
        profile.avatar = data.secure_url;
        _renderUserUI(user, profile);
        showToast('Avatar updated!', 'success');
      }
    } catch { showToast('Upload failed.', 'error'); }
  }

  /* ── Save status ── */
  async function _saveProfile(user, profile) {
    const status = document.getElementById('profile-status').value.trim();
    try {
      await db.collection('users').doc(user.uid).update({ status });
      profile.status = status;
      showToast('Profile saved!', 'success');
      document.getElementById('profile-dropdown').classList.remove('open');
    } catch { showToast('Failed to save.', 'error'); }
  }

  /* ── Real-time notifications ── */
  function _listenNotifications(user) {
    db.collection('users').doc(user.uid)
      .collection('notifications')
      .orderBy('createdAt', 'desc')
      .limit(20)
      .onSnapshot(snap => {
        const list  = document.getElementById('notif-list');
        const badge = document.getElementById('notif-badge');
        const bell  = document.getElementById('notif-bell');

        const notifs = [];
        snap.forEach(d => notifs.push({ id: d.id, ...d.data() }));
        const unread = notifs.filter(n => !n.read).length;

        if (unread > 0) {
          badge.textContent = unread > 9 ? '9+' : unread;
          badge.classList.add('visible');
          bell.classList.add('ringing');
          setTimeout(() => bell.classList.remove('ringing'), 2000);
        } else {
          badge.classList.remove('visible');
          bell.classList.remove('ringing');
        }

        list.innerHTML = notifs.length
          ? notifs.map(n =>
              '<div class="notif-item' + (n.read ? '' : ' unread') +
              '" data-id="' + _esc(n.id) + '">' +
              _esc(n.message || 'New notification') + '</div>'
            ).join('')
          : '<div class="notif-empty">No notifications</div>';

        list.querySelectorAll('.notif-item').forEach(el =>
          el.addEventListener('click', () => _markRead(user, el.dataset.id))
        );
      });
  }

  async function _markRead(user, notifId) {
    try {
      await db.collection('users').doc(user.uid)
        .collection('notifications').doc(notifId).update({ read: true });
    } catch { /* ignore */ }
  }

  /* ── Online presence ── */
  function _setupPresence(user) {
    const ref = db.collection('users').doc(user.uid);
    ref.update({
      online:   true,
      lastSeen: firebase.firestore.FieldValue.serverTimestamp()
    }).catch(() => {});

    window.addEventListener('beforeunload', () => {
      ref.update({ online: false, lastSeen: firebase.firestore.FieldValue.serverTimestamp() });
    });

    setInterval(() => {
      ref.update({ lastSeen: firebase.firestore.FieldValue.serverTimestamp() }).catch(() => {});
    }, 60000);
  }

  function _esc(str) {
    const d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
  }

  return { init };
})();

/* ── showToast — global helper available on all pages that load nav.js ── */
function showToast(msg, type) {
  type = type || 'info';
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}
