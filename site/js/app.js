/* ───────────────────────────────────────────────
   App — RedsssProduction Studios
   Auth state, navigation, games, notifications,
   profile dropdown, presence, support form
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
        await loadUserProfile();
        renderUserUI();
        Messenger.init(currentUser, userProfile);
        setupPresence();
        listenNotifications();
        loadGames();
      } else {
        currentUser = null;
        userProfile = null;
        document.getElementById('app').style.display = 'none';
        if (notifUnsubscribe) { notifUnsubscribe(); notifUnsubscribe = null; }
        Auth.showLogin();
      }
    });

    // Navigation
    document.querySelectorAll('.nav-link[data-page]').forEach(btn => {
      btn.addEventListener('click', () => {
        switchPage(btn.dataset.page);
      });
    });

    // Profile dropdown
    document.getElementById('nav-avatar').addEventListener('click', toggleProfile);
    document.getElementById('nav-username').addEventListener('click', toggleProfile);
    document.getElementById('profile-dd-avatar').addEventListener('click', () => {
      document.getElementById('avatar-upload').click();
    });
    document.getElementById('avatar-upload').addEventListener('change', handleAvatarChange);
    document.getElementById('save-profile-btn').addEventListener('click', saveProfile);
    document.getElementById('btn-logout').addEventListener('click', () => auth.signOut());

    // Notifications bell
    document.getElementById('notif-bell').addEventListener('click', toggleNotifs);

    // Game player close
    document.getElementById('game-player-close').addEventListener('click', closeGamePlayer);

    // Support form
    document.getElementById('submit-support')?.addEventListener('click', submitSupport);

    // Close dropdowns on outside click
    document.addEventListener('click', (e) => {
      const profDD = document.getElementById('profile-dropdown');
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
  async function loadUserProfile() {
    const doc = await db.collection('users').doc(currentUser.uid).get();
    if (doc.exists) {
      userProfile = doc.data();
    } else {
      userProfile = { username: currentUser.displayName || 'User', avatar: '', status: '' };
    }
  }

  /* ── Render avatar, username, profile dropdown ── */
  function renderUserUI() {
    const name = userProfile.username || 'User';
    const avatar = userProfile.avatar;

    // Nav avatar
    const navAv = document.getElementById('nav-avatar');
    if (avatar) {
      navAv.innerHTML = '<img src="' + escapeHtml(avatar) + '" alt="">';
    } else {
      navAv.textContent = name.charAt(0).toUpperCase();
    }

    // Nav username
    document.getElementById('nav-username').textContent = name;

    // Profile dropdown
    const ddAv = document.getElementById('profile-dd-avatar');
    if (avatar) {
      ddAv.innerHTML = '<img src="' + escapeHtml(avatar) + '" alt="">';
    } else {
      ddAv.textContent = name.charAt(0).toUpperCase();
    }

    document.getElementById('profile-dd-name').textContent = name;
    document.getElementById('profile-dd-email').textContent = currentUser.email || '';
    document.getElementById('profile-status').value = userProfile.status || '';
  }

  /* ── Navigation ── */
  function switchPage(pageId) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-link[data-page]').forEach(l => l.classList.remove('active'));

    const page = document.getElementById('page-' + pageId);
    if (page) page.classList.add('active');

    const link = document.querySelector('.nav-link[data-page="' + pageId + '"]');
    if (link) link.classList.add('active');
  }

  /* ── Profile Dropdown ── */
  function toggleProfile() {
    document.getElementById('profile-dropdown').classList.toggle('open');
    document.getElementById('notif-dropdown').classList.remove('open');
  }

  async function handleAvatarChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      showToast('Image must be under 5 MB', 'error');
      return;
    }

    showToast('Uploading avatar...', 'info');

    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('upload_preset', CLOUDINARY_PRESET);
      const res = await fetch('https://api.cloudinary.com/v1_1/' + CLOUDINARY_CLOUD + '/image/upload', {
        method: 'POST', body: fd
      });
      const data = await res.json();
      const url = data.secure_url;

      if (url) {
        await db.collection('users').doc(currentUser.uid).update({ avatar: url });
        userProfile.avatar = url;
        renderUserUI();
        showToast('Avatar updated!', 'success');
      }
    } catch {
      showToast('Upload failed.', 'error');
    }
  }

  async function saveProfile() {
    const status = document.getElementById('profile-status').value.trim();
    try {
      await db.collection('users').doc(currentUser.uid).update({ status });
      userProfile.status = status;
      showToast('Profile saved!', 'success');
      document.getElementById('profile-dropdown').classList.remove('open');
    } catch {
      showToast('Failed to save.', 'error');
    }
  }

  /* ── Notifications ── */
  function listenNotifications() {
    if (notifUnsubscribe) notifUnsubscribe();

    notifUnsubscribe = db.collection('users').doc(currentUser.uid)
      .collection('notifications')
      .orderBy('createdAt', 'desc')
      .limit(20)
      .onSnapshot(snap => {
        const list = document.getElementById('notif-list');
        const badge = document.getElementById('notif-badge');
        const bell = document.getElementById('notif-bell');

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

        if (notifs.length === 0) {
          list.innerHTML = '<div class="notif-empty">No notifications</div>';
        } else {
          list.innerHTML = notifs.map(n =>
            '<div class="notif-item' + (n.read ? '' : ' unread') + '" data-id="' + n.id + '">' +
            escapeHtml(n.message || 'New notification') +
            '</div>'
          ).join('');

          list.querySelectorAll('.notif-item').forEach(el => {
            el.addEventListener('click', () => markRead(el.dataset.id));
          });
        }
      });
  }

  function toggleNotifs() {
    document.getElementById('notif-dropdown').classList.toggle('open');
    document.getElementById('profile-dropdown').classList.remove('open');
  }

  async function markRead(notifId) {
    try {
      await db.collection('users').doc(currentUser.uid)
        .collection('notifications').doc(notifId).update({ read: true });
    } catch { /* ignore */ }
  }

  /* ── Games ── */
  async function loadGames() {
    try {
      const snap = await db.collection('games').orderBy('title').get();
      const games = [];
      snap.forEach(doc => games.push({ id: doc.id, ...doc.data() }));

      const homeGrid = document.getElementById('home-featured');
      const gamesGrid = document.getElementById('games-grid');

      const gamepadSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="12" x2="10" y2="12"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="15" y1="13" x2="15.01" y2="13"/><line x1="18" y1="11" x2="18.01" y2="11"/><rect x="2" y="6" width="20" height="12" rx="2"/></svg>';

      function gameCardHtml(g) {
        const sClass = g.status === 'released' ? 'badge-released'
          : g.status === 'early' ? 'badge-early' : 'badge-coming';
        const sText = g.status === 'released' ? 'Released'
          : g.status === 'early' ? 'Early Access' : 'Coming Soon';
        return '<div class="game-card" data-url="' + escapeHtml(g.url || '') + '" data-title="' + escapeHtml(g.title) + '">' +
          '<div class="game-card-img">' +
            (g.image ? '<img src="' + escapeHtml(g.image) + '" alt="">' : gamepadSvg) +
          '</div>' +
          '<div class="game-card-body">' +
            '<h3>' + escapeHtml(g.title) + '</h3>' +
            '<p>' + escapeHtml(g.description || '') + '</p>' +
            '<span class="badge ' + sClass + '">' + sText + '</span>' +
          '</div></div>';
      }

      const noGames = '<p style="color:var(--text-muted)">No games yet. Check back soon!</p>';
      homeGrid.innerHTML = games.length ? games.slice(0, 4).map(gameCardHtml).join('') : noGames;
      gamesGrid.innerHTML = games.length ? games.map(gameCardHtml).join('') : noGames;

      // Game click handlers
      document.querySelectorAll('.game-card').forEach(card => {
        card.addEventListener('click', () => {
          const url = card.dataset.url;
          if (!url) { showToast('This game is not available yet.', 'info'); return; }
          openGamePlayer(card.dataset.title, url);
        });
      });
    } catch (err) {
      console.error('Failed to load games:', err);
    }
  }

  function openGamePlayer(title, url) {
    document.getElementById('game-player-title').textContent = title;
    document.getElementById('game-iframe').src = url;
    document.getElementById('game-player').classList.add('active');
  }

  function closeGamePlayer() {
    document.getElementById('game-player').classList.remove('active');
    document.getElementById('game-iframe').src = '';
  }

  /* ── Presence ── */
  function setupPresence() {
    const userRef = db.collection('users').doc(currentUser.uid);

    userRef.update({
      online: true,
      lastSeen: firebase.firestore.FieldValue.serverTimestamp()
    }).catch(() => {});

    window.addEventListener('beforeunload', () => {
      userRef.update({
        online: false,
        lastSeen: firebase.firestore.FieldValue.serverTimestamp()
      });
    });

    // Periodic heartbeat every 60s
    setInterval(() => {
      userRef.update({
        lastSeen: firebase.firestore.FieldValue.serverTimestamp()
      }).catch(() => {});
    }, 60000);
  }

  /* ── Support Form ── */
  async function submitSupport() {
    const subject = document.getElementById('support-subject').value.trim();
    const message = document.getElementById('support-message').value.trim();

    if (!subject || !message) {
      showToast('Please fill in both fields.', 'error');
      return;
    }

    try {
      await db.collection('support_tickets').add({
        uid: currentUser.uid,
        username: userProfile.username || '',
        subject,
        message,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        status: 'open'
      });

      document.getElementById('support-subject').value = '';
      document.getElementById('support-message').value = '';
      showToast('Message sent! We\'ll get back to you.', 'success');
    } catch {
      showToast('Failed to send. Try again later.', 'error');
    }
  }

  /* ── Utilities ── */
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  return { init };
})();

/* ── Toast helper (global) ── */
function showToast(msg, type) {
  type = type || 'info';
  const container = document.getElementById('toast-container');
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
