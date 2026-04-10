/* ───────────────────────────────────────────────
   nav.js — Shared navbar for all protected pages
   Usage: Nav.init('pageId').then(({ user, profile }) => ...)
   Pages: games.html, messenger.html, support.html, friends.html
   ─────────────────────────────────────────────── */

const Nav = (() => {

  let _idleTimer = null;
  const IDLE_MS = 10 * 60 * 1000; // 10 minutes

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
            : { username: user.displayName || 'User', avatar: '', status: 'auto', effectiveStatus: 'online' };
        } catch {
          profile = { username: user.displayName || 'User', avatar: '', status: 'auto', effectiveStatus: 'online' };
        }

        // Show app
        document.getElementById('loading-screen').style.display = 'none';
        document.getElementById('app').style.display = '';

        // Wire everything
        _renderUserUI(user, profile);
        _setActive(activePageId);
        _setupEvents(user, profile);
        _setupPresence(user, profile);
        _listenNotifications(user);

        // Track activity
        db.collection('users').doc(user.uid).update({
          'activity.page': activePageId
        }).catch(() => {});

        resolve({ user, profile });
      });
    });
  }

  /* ── Render avatar + username in navbar and dropdown ── */
  function _renderUserUI(user, profile) {
    const name = profile.username || 'User';
    const av   = profile.avatar   || '';
    const eStatus = profile.effectiveStatus || 'offline';

    const navAv = document.getElementById('nav-avatar');
    navAv.innerHTML = av
      ? '<img src="' + _esc(av) + '" alt="">'
      : name.charAt(0).toUpperCase();

    // Status dot on nav avatar
    const navDot = document.getElementById('nav-status-dot');
    if (navDot) {
      navDot.className = 'status-dot ' + eStatus;
    }

    document.getElementById('nav-username').textContent = name;

    const ddAv = document.getElementById('profile-dd-avatar');
    ddAv.innerHTML = av
      ? '<img src="' + _esc(av) + '" alt="">'
      : name.charAt(0).toUpperCase();

    document.getElementById('profile-dd-name').textContent  = name;
    document.getElementById('profile-dd-name').style.display = '';
    var nameInp = document.getElementById('profile-dd-name-input');
    if (nameInp) { nameInp.style.display = 'none'; nameInp.value = name; }
    document.getElementById('profile-dd-email').textContent = user.email || '';

    const statusSelect = document.getElementById('profile-status');
    if (statusSelect) statusSelect.value = profile.status || 'auto';

    const bioTa = document.getElementById('profile-dd-bio');
    if (bioTa) bioTa.value = profile.description || '';
  }

  /* ── Mark the correct nav link active ── */
  function _setActive(pageId) {
    document.querySelectorAll('.nav-link[data-page]').forEach(l => {
      l.classList.toggle('active', l.dataset.page === pageId);
    });
  }

  /* ── Wire all navbar event listeners ── */
  function _setupEvents(user, profile) {
    // Avatar wrapper click opens profile
    const avatarWrapper = document.querySelector('.nav-avatar-wrapper');
    if (avatarWrapper) avatarWrapper.addEventListener('click', _toggleProfile);
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

    // Username edit: click name to toggle input
    document.getElementById('profile-dd-name').addEventListener('click', function () {
      this.style.display = 'none';
      var inp = document.getElementById('profile-dd-name-input');
      inp.style.display = '';
      inp.value = profile.username || '';
      inp.focus();
    });

    document.getElementById('btn-logout').addEventListener('click', () => {
      const ref = db.collection('users').doc(user.uid);
      ref.update({ online: false, effectiveStatus: 'offline', lastSeen: firebase.firestore.FieldValue.serverTimestamp() }).catch(() => {});
      auth.signOut().then(() => window.location.replace('index.html'));
    });

    // Close dropdowns on outside click
    document.addEventListener('click', e => {
      const pd = document.getElementById('profile-dropdown');
      const nd = document.getElementById('notif-dropdown');
      if (pd.classList.contains('open') &&
          !pd.contains(e.target) &&
          !document.querySelector('.nav-avatar-wrapper')?.contains(e.target) &&
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
  async function _handleAvatarChange(e, user, profile) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { showToast('Image must be under 5 MB', 'error'); return; }
    var blob;
    try { blob = await CropperUtil.open(file, { aspectRatio: 1, width: 256, height: 256 }); }
    catch { return; }
    showToast('Uploading...', 'info');
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
        await db.collection('users').doc(user.uid).update({ avatar: data.secure_url });
        profile.avatar = data.secure_url;
        _renderUserUI(user, profile);
        showToast('Avatar updated!', 'success');
      }
    } catch { showToast('Upload failed.', 'error'); }
    e.target.value = '';
  }

  /* ── Save status + optional username ── */
  async function _saveProfile(user, profile) {
    var status = document.getElementById('profile-status').value;
    var updates = {};

    var nameInp = document.getElementById('profile-dd-name-input');
    if (nameInp && nameInp.style.display !== 'none') {
      var newName = nameInp.value.trim();
      if (newName && newName !== profile.username) {
        if (newName.length < 3 || newName.length > 20) {
          showToast('Username must be 3-20 characters.', 'error'); return;
        }
        if (!/^[a-zA-Z0-9_ ]+$/.test(newName)) {
          showToast('Only letters, numbers, underscores, and spaces.', 'error'); return;
        }
        var lower = newName.toLowerCase();
        var snap = await db.collection('users')
          .where('usernameLower', '==', lower).limit(1).get();
        if (!snap.empty && snap.docs[0].id !== user.uid) {
          showToast('Username already taken.', 'error'); return;
        }
        updates.username = newName;
        updates.usernameLower = lower;
      }
    }

    var bioInp = document.getElementById('profile-dd-bio');
    if (bioInp) updates.description = bioInp.value.trim().slice(0, 150);

    try {
      var effectiveStatus = _computeEffective(status);
      updates.status = status;
      updates.effectiveStatus = effectiveStatus;
      await db.collection('users').doc(user.uid).update(updates);
      if (updates.username) {
        profile.username = updates.username;
        profile.usernameLower = updates.usernameLower;
      }
      if (updates.description !== undefined) profile.description = updates.description;
      profile.status = status;
      profile.effectiveStatus = effectiveStatus;
      _renderUserUI(user, profile);
      showToast('Profile saved!', 'success');
      document.getElementById('profile-dropdown').classList.remove('open');
    } catch { showToast('Failed to save.', 'error'); }
  }

  /* ── Compute effective status from chosen status ── */
  function _computeEffective(status) {
    if (status === 'auto') {
      return document.hidden ? 'away' : 'online';
    }
    return status; // online, away, dnd, offline
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

  /* ── Online presence + Auto status (visibility, idle) ── */
  function _setupPresence(user, profile) {
    sessionStorage.removeItem('_siteNav'); // clear any leftover flag from same-site navigation
    const ref = db.collection('users').doc(user.uid);
    const effective = _computeEffective(profile.status || 'auto');

    ref.update({
      online: true,
      effectiveStatus: effective,
      lastSeen: firebase.firestore.FieldValue.serverTimestamp()
    }).catch(() => {});

    profile.effectiveStatus = effective;
    _renderUserUI(user, profile);

    // RTDB presence — fires server-side even on hard close/shutdown
    let presenceRef = null;
    let _cachedToken = null;
    // Cache the auth token so _goOffline can use it synchronously in pagehide
    function _refreshToken() {
      user.getIdToken().then(t => { _cachedToken = t; }).catch(() => {});
    }
    _refreshToken();
    setInterval(_refreshToken, 55 * 60 * 1000); // refresh before 1h expiry

    try {
      const rtdb = firebase.database();
      presenceRef = rtdb.ref('presence/' + user.uid);
      rtdb.ref('.info/connected').on('value', snap => {
        if (!snap.val()) return;
        presenceRef.onDisconnect().update({ effectiveStatus: 'offline', online: false })
          .then(() => {
            // Guard: don't write online:true if _goOffline already ran
            if (!_pageClosing) presenceRef.update({ effectiveStatus: effective, online: true });
          });
        // Sync RTDB offline flag to Firestore for other clients
        presenceRef.on('value', pSnap => {
          const pVal = pSnap.val();
          if (pVal && pVal.online === false) {
            if (_pageClosing) {
              ref.update({ effectiveStatus: 'offline', online: false }).catch(() => {});
            } else {
              // Another tab disconnected — re-assert our presence
              const myEff = _computeEffective(profile.status || 'auto');
              presenceRef.update({ effectiveStatus: myEff, online: true }).catch(() => {});
              ref.update({ effectiveStatus: myEff, online: true, lastSeen: firebase.firestore.FieldValue.serverTimestamp() }).catch(() => {});
            }
          }
        });
      });
    } catch (e) { console.warn('RTDB presence unavailable', e); }

    const _rtdbRestUrl = 'https://redsssproduction-studios-86bec-default-rtdb.firebaseio.com/presence/' + user.uid + '.json';
    const _fsRestUrl = 'https://firestore.googleapis.com/v1/projects/redsssproduction-studios-86bec/databases/(default)/documents/users/' + user.uid
      + '?updateMask.fieldPaths=online&updateMask.fieldPaths=effectiveStatus';

    let _awayTimer = null;
    let _pageClosing = false;

    function _goOffline() {
      if (_pageClosing) return;
      // If navigating to another page on this site, skip going offline
      if (sessionStorage.getItem('_siteNav')) { sessionStorage.removeItem('_siteNav'); return; }
      _pageClosing = true;
      clearTimeout(_awayTimer);
      const rtdbPayload = JSON.stringify({ online: false, effectiveStatus: 'offline' });
      const fsPayload = JSON.stringify({ fields: { online: { booleanValue: false }, effectiveStatus: { stringValue: 'offline' } } });
      const hdrs = { 'Content-Type': 'application/json' };
      if (_cachedToken) hdrs['Authorization'] = 'Bearer ' + _cachedToken;
      // keepalive fetch — spec-guaranteed to complete even after page unload
      try { fetch(_rtdbRestUrl + (_cachedToken ? '?auth=' + _cachedToken : ''), { method: 'PATCH', body: rtdbPayload, headers: { 'Content-Type': 'application/json' }, keepalive: true }); } catch(e) {}
      try { fetch(_fsRestUrl, { method: 'PATCH', body: fsPayload, headers: hdrs, keepalive: true }); } catch(e) {}
      // RTDB SDK write — works if WebSocket still open
      if (presenceRef) presenceRef.update({ online: false, effectiveStatus: 'offline' }).catch(() => {});
      // Firestore SDK write — fallback for browsers where keepalive fetch may not complete on full close
      ref.update({
        online: false,
        effectiveStatus: profile.status === 'auto' ? 'offline' : profile.effectiveStatus,
        lastSeen: firebase.firestore.FieldValue.serverTimestamp()
      }).catch(() => {});
    }

    window.addEventListener('pagehide', _goOffline);
    window.addEventListener('beforeunload', _goOffline);

    // Flag same-site link clicks so _goOffline knows not to write offline
    document.addEventListener('click', e => {
      const a = e.target.closest('a[href]');
      if (a && a.origin === location.origin) sessionStorage.setItem('_siteNav', '1');
    }, { capture: true });

    // Visibility change (tab hidden/shown)
    document.addEventListener('visibilitychange', () => {
      if (profile.status !== 'auto') return;
      if (!document.hidden) {
        clearTimeout(_awayTimer);
        _awayTimer = null;
        _pageClosing = false;
        ref.update({ effectiveStatus: 'online', lastSeen: firebase.firestore.FieldValue.serverTimestamp() }).catch(() => {});
        profile.effectiveStatus = 'online';
        _renderUserUI(user, profile);
        _resetIdleTimer(user, profile);
        return;
      }
      // Page hidden — delay away write so pagehide/beforeunload can cancel it
      _awayTimer = setTimeout(() => {
        if (_pageClosing) return;
        ref.update({ effectiveStatus: 'away', lastSeen: firebase.firestore.FieldValue.serverTimestamp() }).catch(() => {});
        profile.effectiveStatus = 'away';
        _renderUserUI(user, profile);
      }, 600);
    });

    // Idle detection (mouse/keyboard)
    const resetIdle = () => _resetIdleTimer(user, profile);
    document.addEventListener('mousemove', resetIdle, { passive: true });
    document.addEventListener('keydown', resetIdle, { passive: true });
    _resetIdleTimer(user, profile);

    // Heartbeat — keeps lastSeen fresh so stale detection works
    setInterval(() => {
      ref.update({ lastSeen: firebase.firestore.FieldValue.serverTimestamp() }).catch(() => {});
    }, 10000);

    // Auto-save status immediately when dropdown changes
    document.getElementById('profile-status')?.addEventListener('change', () => {
      const status = document.getElementById('profile-status').value;
      const effectiveStatus = _computeEffective(status);
      profile.status = status;
      profile.effectiveStatus = effectiveStatus;
      ref.update({ status, effectiveStatus }).catch(() => {});
      if (presenceRef) presenceRef.update({ effectiveStatus, online: effectiveStatus !== 'offline' }).catch(() => {});
      _renderUserUI(user, profile);
    });
  }

  function _resetIdleTimer(user, profile) {
    if (profile.status !== 'auto') return;
    clearTimeout(_idleTimer);
    // If we were away due to idle, go back online
    if (profile.effectiveStatus === 'away' && !document.hidden) {
      const ref = db.collection('users').doc(user.uid);
      ref.update({ effectiveStatus: 'online' }).catch(() => {});
      profile.effectiveStatus = 'online';
      _renderUserUI(user, profile);
    }
    _idleTimer = setTimeout(() => {
      if (profile.status !== 'auto') return;
      const ref = db.collection('users').doc(user.uid);
      ref.update({ effectiveStatus: 'away' }).catch(() => {});
      profile.effectiveStatus = 'away';
      _renderUserUI(user, profile);
    }, IDLE_MS);
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
