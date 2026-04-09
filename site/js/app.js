/* ───────────────────────────────────────────────
   app.js — Home page (index.html)
   Auth state, navbar, featured games, notifications,
   profile dropdown, game player, presence.
   ─────────────────────────────────────────────── */

const App = (() => {
  let currentUser = null;
  let userProfile = null;
  let notifUnsubscribe = null;
  let _idleTimer = null;
  const IDLE_MS = 10 * 60 * 1000; // 10 minutes

  // Slideshow
  let _slideIndex = 0;
  let _slideInterval = null;
  const _slides = [
    {
      emoji: '🎮',
      bg: 'linear-gradient(135deg, #1a0a0a 0%, #8b1a1a 100%)',
      title: 'Play Games',
      sub: 'Explore a growing library of browser games',
      href: 'games.html'
    },
    {
      emoji: '💬',
      bg: 'linear-gradient(135deg, #0a0a1a 0%, #1a1a6e 100%)',
      title: 'RedsssMessenger',
      sub: 'Chat with friends and join community servers',
      href: 'messenger.html'
    },
    {
      emoji: '👥',
      bg: 'linear-gradient(135deg, #0a1a0a 0%, #1a4a1a 100%)',
      title: 'Friends',
      sub: 'Add friends, see who is online, send messages',
      href: 'friends.html'
    }
  ];

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
        _loadCommunityStats();
      } else {
        currentUser = null;
        userProfile = null;
        document.getElementById('app').style.display = 'none';
        if (notifUnsubscribe) { notifUnsubscribe(); notifUnsubscribe = null; }
        Auth.showLogin();
      }
    });

    // Slideshow UI
    _buildSlideshow();

    // Profile dropdown
    const avatarWrapper = document.querySelector('.nav-avatar-wrapper');
    if (avatarWrapper) avatarWrapper.addEventListener('click', _toggleProfile);
    document.getElementById('nav-username').addEventListener('click', _toggleProfile);
    document.getElementById('profile-dd-avatar').addEventListener('click', () => {
      document.getElementById('avatar-upload').click();
    });
    document.getElementById('avatar-upload').addEventListener('change', _handleAvatarChange);
    document.getElementById('save-profile-btn').addEventListener('click', _saveProfile);

    // Username edit: click name to toggle input
    document.getElementById('profile-dd-name').addEventListener('click', function () {
      this.style.display = 'none';
      var inp = document.getElementById('profile-dd-name-input');
      inp.style.display = '';
      inp.value = userProfile.username || '';
      inp.focus();
    });

    document.getElementById('btn-logout').addEventListener('click', () => {
      if (currentUser) {
        db.collection('users').doc(currentUser.uid).update({
          online: false, effectiveStatus: 'offline',
          lastSeen: firebase.firestore.FieldValue.serverTimestamp()
        }).catch(() => {});
      }
      auth.signOut();
    });

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
          !document.querySelector('.nav-avatar-wrapper')?.contains(e.target) &&
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
        : { username: currentUser.displayName || 'User', avatar: '', status: 'auto', effectiveStatus: 'online' };
    } catch {
      userProfile = { username: currentUser.displayName || 'User', avatar: '', status: 'auto', effectiveStatus: 'online' };
    }
  }

  /* ── Render avatar, username, profile dropdown ── */
  function _renderUserUI() {
    const name   = userProfile.username || 'User';
    const avatar = userProfile.avatar   || '';
    const eStatus = userProfile.effectiveStatus || 'offline';

    const navAv = document.getElementById('nav-avatar');
    navAv.innerHTML = avatar
      ? '<img src="' + _esc(avatar) + '" alt="">'
      : name.charAt(0).toUpperCase();

    // Status dot on nav avatar
    const navDot = document.getElementById('nav-status-dot');
    if (navDot) navDot.className = 'status-dot ' + eStatus;

    document.getElementById('nav-username').textContent = name;

    const ddAv = document.getElementById('profile-dd-avatar');
    ddAv.innerHTML = avatar
      ? '<img src="' + _esc(avatar) + '" alt="">'
      : name.charAt(0).toUpperCase();

    document.getElementById('profile-dd-name').textContent  = name;
    document.getElementById('profile-dd-name').style.display = '';
    var nameInp = document.getElementById('profile-dd-name-input');
    if (nameInp) { nameInp.style.display = 'none'; nameInp.value = name; }
    document.getElementById('profile-dd-email').textContent = currentUser.email || '';

    const statusSelect = document.getElementById('profile-status');
    if (statusSelect) statusSelect.value = userProfile.status || 'auto';
  }

  /* ── Profile dropdown toggles ── */
  function _toggleProfile(e) {
    e.stopPropagation();
    document.getElementById('profile-dropdown').classList.toggle('open');
    document.getElementById('notif-dropdown').classList.remove('open');
  }

  function _toggleNotifs() {
    document.getElementById('notif-dropdown').classList.toggle('open');
    document.getElementById('profile-dropdown').classList.remove('open');
  }

  /* ── Avatar upload with crop ── */
  async function _handleAvatarChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { showToast('Image must be under 5 MB', 'error'); return; }
    var blob;
    try { blob = await CropperUtil.open(file, { aspectRatio: 1, width: 256, height: 256 }); }
    catch { return; } // cancelled
    showToast('Uploading avatar...', 'info');
    try {
      const fd = new FormData();
      fd.append('file', blob);
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
    e.target.value = '';
  }

  /* ── Save status + optional username ── */
  async function _saveProfile() {
    var status = document.getElementById('profile-status').value;
    var updates = {};

    // Username change?
    var nameInp = document.getElementById('profile-dd-name-input');
    if (nameInp && nameInp.style.display !== 'none') {
      var newName = nameInp.value.trim();
      if (newName && newName !== userProfile.username) {
        if (newName.length < 3 || newName.length > 20) {
          showToast('Username must be 3-20 characters.', 'error'); return;
        }
        if (!/^[a-zA-Z0-9_ ]+$/.test(newName)) {
          showToast('Only letters, numbers, underscores, and spaces.', 'error'); return;
        }
        var lower = newName.toLowerCase();
        var snap = await db.collection('users')
          .where('usernameLower', '==', lower).limit(1).get();
        if (!snap.empty && snap.docs[0].id !== currentUser.uid) {
          showToast('Username already taken.', 'error'); return;
        }
        updates.username = newName;
        updates.usernameLower = lower;
      }
    }

    try {
      var effectiveStatus = _computeEffective(status);
      updates.status = status;
      updates.effectiveStatus = effectiveStatus;
      await db.collection('users').doc(currentUser.uid).update(updates);
      if (updates.username) {
        userProfile.username = updates.username;
        userProfile.usernameLower = updates.usernameLower;
      }
      userProfile.status = status;
      userProfile.effectiveStatus = effectiveStatus;
      _renderUserUI();
      showToast('Profile saved!', 'success');
      document.getElementById('profile-dropdown').classList.remove('open');
    } catch { showToast('Failed to save.', 'error'); }
  }

  /* ── Compute effective status ── */
  function _computeEffective(status) {
    if (status === 'auto') return document.hidden ? 'away' : 'online';
    return status;
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

  /* ── Online presence + Auto status ── */
  function _setupPresence() {
    const ref = db.collection('users').doc(currentUser.uid);
    const effective = _computeEffective(userProfile.status || 'auto');

    ref.update({
      online: true,
      effectiveStatus: effective,
      lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
      'activity.page': 'home'
    }).catch(() => {});

    userProfile.effectiveStatus = effective;
    _renderUserUI();

    // RTDB presence — fires server-side even on hard close/shutdown
    try {
      const rtdb = firebase.database();
      const presenceRef = rtdb.ref('presence/' + currentUser.uid);
      rtdb.ref('.info/connected').on('value', snap => {
        if (!snap.val()) return;
        presenceRef.onDisconnect().update({ effectiveStatus: 'offline', online: false })
          .then(() => presenceRef.update({ effectiveStatus: effective, online: true }));
        presenceRef.on('value', pSnap => {
          const pVal = pSnap.val();
          if (pVal && pVal.online === false) {
            ref.update({ effectiveStatus: 'offline', online: false }).catch(() => {});
          }
        });
      });
    } catch (e) { console.warn('RTDB presence unavailable', e); }

    // Visibility change (tab hidden/shown)
    // Delay 'away' write so page-close events (pagehide/beforeunload) can cancel it
    let _awayTimer = null;
    let _pageClosing = false;

    function _cancelAwayWrite() {
      _pageClosing = true;
      clearTimeout(_awayTimer);
      _awayTimer = null;
    }
    window.addEventListener('pagehide', _cancelAwayWrite);

    document.addEventListener('visibilitychange', () => {
      if (userProfile.status !== 'auto') return;
      if (!document.hidden) {
        clearTimeout(_awayTimer);
        _awayTimer = null;
        _pageClosing = false;
        ref.update({ effectiveStatus: 'online', lastSeen: firebase.firestore.FieldValue.serverTimestamp() }).catch(() => {});
        userProfile.effectiveStatus = 'online';
        _renderUserUI();
        _resetIdleTimer();
        return;
      }
      // Page hidden — wait before writing 'away' so close events can cancel it
      _awayTimer = setTimeout(() => {
        if (_pageClosing) return;
        ref.update({ effectiveStatus: 'away', lastSeen: firebase.firestore.FieldValue.serverTimestamp() }).catch(() => {});
        userProfile.effectiveStatus = 'away';
        _renderUserUI();
      }, 500);
    });

    // Idle detection
    const resetIdle = () => _resetIdleTimer();
    document.addEventListener('mousemove', resetIdle, { passive: true });
    document.addEventListener('keydown', resetIdle, { passive: true });
    _resetIdleTimer();

    // Beforeunload → offline
    window.addEventListener('beforeunload', () => {
      _cancelAwayWrite();
      ref.update({
        online: false,
        effectiveStatus: userProfile.status === 'auto' ? 'offline' : userProfile.effectiveStatus,
        lastSeen: firebase.firestore.FieldValue.serverTimestamp()
      });
    });

    // Heartbeat
    setInterval(() => {
      ref.update({ lastSeen: firebase.firestore.FieldValue.serverTimestamp() }).catch(() => {});
    }, 60000);
  }

  function _resetIdleTimer() {
    if (userProfile.status !== 'auto') return;
    clearTimeout(_idleTimer);
    if (userProfile.effectiveStatus === 'away' && !document.hidden) {
      const ref = db.collection('users').doc(currentUser.uid);
      ref.update({ effectiveStatus: 'online' }).catch(() => {});
      userProfile.effectiveStatus = 'online';
      _renderUserUI();
    }
    _idleTimer = setTimeout(() => {
      if (userProfile.status !== 'auto') return;
      const ref = db.collection('users').doc(currentUser.uid);
      ref.update({ effectiveStatus: 'away' }).catch(() => {});
      userProfile.effectiveStatus = 'away';
      _renderUserUI();
    }, IDLE_MS);
  }

  function _esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  /* ── Slideshow ── */
  function _buildSlideshow() {
    const track = document.getElementById('slideshow-track');
    const dotsEl = document.getElementById('slideshow-dots');
    if (!track || !dotsEl) return;

    // Build slides
    track.innerHTML = _slides.map(s =>
      '<div class="slide">' +
        '<div class="slide-bg" style="background:' + s.bg + '"></div>' +
        '<div class="slide-bg-fallback">' + s.emoji + '</div>' +
        '<div class="slide-caption">' +
          '<div class="slide-caption-text">' +
            '<div class="slide-caption-title">' + _esc(s.title) + '</div>' +
            '<div class="slide-caption-sub">' + _esc(s.sub) + '</div>' +
          '</div>' +
          '<a href="' + _esc(s.href) + '" class="slide-caption-btn">Learn More</a>' +
        '</div>' +
      '</div>'
    ).join('');

    // Build dots
    dotsEl.innerHTML = _slides.map((_, i) =>
      '<button class="slideshow-dot' + (i === 0 ? ' active' : '') + '" data-i="' + i + '" aria-label="Slide ' + (i + 1) + '"></button>'
    ).join('');
    dotsEl.querySelectorAll('.slideshow-dot').forEach(btn =>
      btn.addEventListener('click', () => _goToSlide(parseInt(btn.dataset.i)))
    );

    // Arrows
    document.getElementById('slide-prev').addEventListener('click', () =>
      _goToSlide((_slideIndex - 1 + _slides.length) % _slides.length)
    );
    document.getElementById('slide-next').addEventListener('click', () =>
      _goToSlide((_slideIndex + 1) % _slides.length)
    );

    // Auto-advance every 5s
    _startSlideshowTimer();

    // Pause on hover
    const ss = document.getElementById('home-slideshow');
    if (ss) {
      ss.addEventListener('mouseenter', () => { clearInterval(_slideInterval); _slideInterval = null; });
      ss.addEventListener('mouseleave', _startSlideshowTimer);
    }
  }

  function _goToSlide(idx) {
    _slideIndex = idx;
    const track = document.getElementById('slideshow-track');
    if (track) track.style.transform = 'translateX(-' + (idx * 100) + '%)';
    document.querySelectorAll('.slideshow-dot').forEach((d, i) =>
      d.classList.toggle('active', i === idx)
    );
  }

  function _startSlideshowTimer() {
    clearInterval(_slideInterval);
    _slideInterval = setInterval(() =>
      _goToSlide((_slideIndex + 1) % _slides.length)
    , 5000);
  }

  /* ── Community stats ── */
  async function _loadCommunityStats() {
    try {
      const [gamesSnap, membersSnap, onlineSnap] = await Promise.all([
        db.collection('games').get(),
        db.collection('users').get(),
        db.collection('users').where('online', '==', true).get()
      ]);
      const statEl = id => document.getElementById(id);
      if (statEl('stat-games')) statEl('stat-games').textContent = gamesSnap.size;
      if (statEl('stat-members')) statEl('stat-members').textContent = membersSnap.size;
      if (statEl('stat-online')) statEl('stat-online').textContent = onlineSnap.size;
    } catch (e) {
      // stats unavailable — leave as —
    }
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
