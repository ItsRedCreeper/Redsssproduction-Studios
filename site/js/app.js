/* ───────────────────────────────────────────────
   app.js — Home page (index.html)
   Auth state, navbar, featured games, notifications,
   profile dropdown, game player, presence.
   ─────────────────────────────────────────────── */

const App = (() => {
  let currentUser = null;
  let userProfile = null;
  let notifUnsubscribe = null;

  /* ── Init ── */
  function init() {
    Auth.init();

    auth.onAuthStateChanged(async (user) => {
      document.getElementById('loading-screen').style.display = 'none';

      if (user) {
        currentUser = user;
        Auth.hideAll();
        document.getElementById('app').style.display = '';
        await _loadUserProfile();
        _renderUserUI();
        _setupPresence();
        _listenNotifications();
        _loadFeaturedGames();
      } else {
        currentUser = null;
        userProfile = null;
        document.getElementById('app').style.display = 'none';
        if (notifUnsubscribe) { notifUnsubscribe(); notifUnsubscribe = null; }
        Auth.showLogin();
      }
    });

    // Profile dropdown
    document.getElementById('nav-avatar').addEventListener('click', _toggleProfile);
    document.getElementById('nav-username').addEventListener('click', _toggleProfile);
    document.getElementById('profile-dd-avatar').addEventListener('click', () => {
      document.getElementById('avatar-upload').click();
    });
    document.getElementById('avatar-upload').addEventListener('change', _handleAvatarChange);
    document.getElementById('save-profile-btn').addEventListener('click', _saveProfile);
    document.getElementById('btn-logout').addEventListener('click', () => auth.signOut());

    // Notifications bell
    document.getElementById('notif-bell').addEventListener('click', _toggleNotifs);

    // Game player close
    document.getElementById('game-player-close').addEventListener('click', _closeGamePlayer);

    // Close dropdowns on outside click
    document.addEventListener('click', (e) => {
      const profDD  = document.getElementById('profile-dropdown');
      const notifDD = document.getElementById('notif-dropdown');
      if (profDD.classList.contains('open') &&
          !profDD.contains(e.target) &&
          !document.getElementById('nav-avatar').contains(e.target) &&
          e.target.id !== 'nav-username') {
        profDD.classList.remove('open');
      }
      if (notifDD.classList.contains('open') &&
          !notifDD.contains(e.target) &&
          !document.getElementById('notif-bell').contains(e.target)) {
        notifDD.classList.remove('open');
      }
    });
  }

  /* ── Load user profile from Firestore ── */
  async function _loadUserProfile() {
    try {
      const doc = await db.collection('users').doc(currentUser.uid).get();
      userProfile = doc.exists
        ? doc.data()
        : { username: currentUser.displayName || 'User', avatar: '', status: '' };
    } catch {
      userProfile = { username: currentUser.displayName || 'User', avatar: '', status: '' };
    }
  }

  /* ── Render avatar, username, profile dropdown ── */
  function _renderUserUI() {
    const name   = userProfile.username || 'User';
    const avatar = userProfile.avatar   || '';

    const navAv = document.getElementById('nav-avatar');
    navAv.innerHTML = avatar
      ? '<img src="' + _esc(avatar) + '" alt="">'
      : name.charAt(0).toUpperCase();

    document.getElementById('nav-username').textContent = name;

    const ddAv = document.getElementById('profile-dd-avatar');
    ddAv.innerHTML = avatar
      ? '<img src="' + _esc(avatar) + '" alt="">'
      : name.charAt(0).toUpperCase();

    document.getElementById('profile-dd-name').textContent  = name;
    document.getElementById('profile-dd-email').textContent = currentUser.email || '';
    document.getElementById('profile-status').value         = userProfile.status || '';
  }

  /* ── Profile dropdown toggles ── */
  function _toggleProfile() {
    document.getElementById('profile-dropdown').classList.toggle('open');
    document.getElementById('notif-dropdown').classList.remove('open');
  }

  function _toggleNotifs() {
    document.getElementById('notif-dropdown').classList.toggle('open');
    document.getElementById('profile-dropdown').classList.remove('open');
  }

  /* ── Avatar upload via Cloudinary ── */
  async function _handleAvatarChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { showToast('Image must be under 5 MB', 'error'); return; }
    showToast('Uploading avatar...', 'info');
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
        await db.collection('users').doc(currentUser.uid).update({ avatar: data.secure_url });
        userProfile.avatar = data.secure_url;
        _renderUserUI();
        showToast('Avatar updated!', 'success');
      }
    } catch { showToast('Upload failed.', 'error'); }
  }

  /* ── Save status ── */
  async function _saveProfile() {
    const status = document.getElementById('profile-status').value.trim();
    try {
      await db.collection('users').doc(currentUser.uid).update({ status });
      userProfile.status = status;
      showToast('Profile saved!', 'success');
      document.getElementById('profile-dropdown').classList.remove('open');
    } catch { showToast('Failed to save.', 'error'); }
  }

  /* ── Notifications real-time listener ── */
  function _listenNotifications() {
    if (notifUnsubscribe) notifUnsubscribe();

    notifUnsubscribe = db.collection('users').doc(currentUser.uid)
      .collection('notifications')
      .orderBy('createdAt', 'desc')
      .limit(20)
      .onSnapshot(snap => {
        const list  = document.getElementById('notif-list');
        const badge = document.getElementById('notif-badge');
        const bell  = document.getElementById('notif-bell');

        const notifs = [];
        snap.forEach(doc => notifs.push({ id: doc.id, ...doc.data() }));
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
              '<div class="notif-item' + (n.read ? '' : ' unread') + '" data-id="' + n.id + '">' +
              _esc(n.message || 'New notification') + '</div>'
            ).join('')
          : '<div class="notif-empty">No notifications</div>';

        list.querySelectorAll('.notif-item').forEach(el => {
          el.addEventListener('click', () => _markRead(el.dataset.id));
        });
      });
  }

  async function _markRead(notifId) {
    try {
      await db.collection('users').doc(currentUser.uid)
        .collection('notifications').doc(notifId).update({ read: true });
    } catch { /* ignore */ }
  }

  /* ── Featured games on home page ── */
  async function _loadFeaturedGames() {
    try {
      const snap = await db.collection('games').orderBy('title').limit(4).get();
      const games = [];
      snap.forEach(doc => games.push({ id: doc.id, ...doc.data() }));

      const grid = document.getElementById('home-featured');
      const gamepadSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="12" x2="10" y2="12"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="15" y1="13" x2="15.01" y2="13"/><line x1="18" y1="11" x2="18.01" y2="11"/><rect x="2" y="6" width="20" height="12" rx="2"/></svg>';

      grid.innerHTML = games.length
        ? games.map(g => {
            const sClass = g.status === 'released' ? 'badge-released'
              : g.status === 'early' ? 'badge-early' : 'badge-coming';
            const sText = g.status === 'released' ? 'Released'
              : g.status === 'early' ? 'Early Access' : 'Coming Soon';
            return '<div class="game-card" data-url="' + _esc(g.url || '') + '" data-title="' + _esc(g.title) + '">' +
              '<div class="game-card-img">' + (g.image ? '<img src="' + _esc(g.image) + '" alt="">' : gamepadSvg) + '</div>' +
              '<div class="game-card-body"><h3>' + _esc(g.title) + '</h3>' +
              '<p>' + _esc(g.description || '') + '</p>' +
              '<span class="badge ' + sClass + '">' + sText + '</span></div></div>';
          }).join('')
        : '<p style="color:var(--text-muted)">No games yet. Check back soon!</p>';

      grid.querySelectorAll('.game-card').forEach(card => {
        card.addEventListener('click', () => {
          const url = card.dataset.url;
          if (!url) { showToast('This game is not available yet.', 'info'); return; }
          _openGamePlayer(card.dataset.title, url);
        });
      });
    } catch (err) {
      console.error('Failed to load games:', err);
    }
  }

  function _openGamePlayer(title, url) {
    document.getElementById('game-player-title').textContent = title;
    document.getElementById('game-iframe').src = url;
    document.getElementById('game-player').classList.add('active');
  }

  function _closeGamePlayer() {
    document.getElementById('game-player').classList.remove('active');
    document.getElementById('game-iframe').src = '';
  }

  /* ── Online presence ── */
  function _setupPresence() {
    const ref = db.collection('users').doc(currentUser.uid);
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
    d.textContent = str;
    return d.innerHTML;
  }

  return { init };
})();

/* ── showToast — global helper for index.html ── */
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

/* ── Boot ── */
document.addEventListener('DOMContentLoaded', () => App.init());
