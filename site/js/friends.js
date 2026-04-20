/* ───────────────────────────────────────────────
   friends.js — Friends page
   Friend management, search, requests, profiles.
   ─────────────────────────────────────────────── */

const Friends = (() => {
  let currentUser = null;
  let userProfile = null;
  let friendProfiles = [];
  let _myFriendUids = []; // keep in sync with live listener
  let _selectedFriendUid = null; // currently open profile
  let _selectedFriendTab = 'about'; // active tab
  let _showOnlineOnly = false;
  const _rtdbOffline = new Set(); // uids RTDB has confirmed offline (takes priority over Firestore)

  function init(user, profile) {
    currentUser = user;
    userProfile = profile;

    // Add friend toggle
    document.getElementById('add-friend-toggle').addEventListener('click', _toggleAddFriend);

    // Friend search (3+ chars)
    document.getElementById('friend-search-input').addEventListener('input', _onSearchInput);

    // Filter friends
    document.getElementById('friends-filter').addEventListener('input', _filterFriends);

    // Online-only toggle
    const onlineToggle = document.getElementById('online-only-toggle');
    if (onlineToggle) {
      onlineToggle.addEventListener('click', () => {
        _showOnlineOnly = !_showOnlineOnly;
        onlineToggle.classList.toggle('active', _showOnlineOnly);
        _renderFriendsList(friendProfiles.slice());
      });
    }

    // Load data
    _loadFriends();
    _loadPendingRequests();
    _loadSentRequests();

    // Handle ?view=UID to show any user's full profile
    const viewUid = new URLSearchParams(window.location.search).get('view');
    if (viewUid && viewUid !== currentUser.uid) {
      _viewUserProfile(viewUid);
    }
  }

  /* ── Toggle Add Friend panel ── */
  function _toggleAddFriend() {
    const section = document.getElementById('friends-add-section');
    const btn = document.getElementById('add-friend-toggle');
    if (section.style.display === 'none') {
      section.style.display = 'block';
      btn.textContent = 'Cancel';
      document.getElementById('friend-search-input').focus();
    } else {
      section.style.display = 'none';
      btn.textContent = 'Add Friend';
      document.getElementById('friend-search-input').value = '';
      document.getElementById('friend-search-results').innerHTML = '';
    }
  }

  /* ── Search users (prefix match, min 3 chars) ── */
  let _searchTimeout = null;
  function _onSearchInput() {
    clearTimeout(_searchTimeout);
    const q = document.getElementById('friend-search-input').value.trim().toLowerCase();
    const results = document.getElementById('friend-search-results');

    if (q.length < 3) {
      results.innerHTML = q.length > 0
        ? '<div class="friends-search-hint">Type at least 3 characters...</div>'
        : '';
      return;
    }

    _searchTimeout = setTimeout(async () => {
      results.innerHTML = '<div class="friends-search-hint">Searching...</div>';
      try {
        const snap = await db.collection('users')
          .where('usernameLower', '>=', q)
          .where('usernameLower', '<', q + '\uf8ff')
          .limit(10)
          .get();

        if (snap.empty) {
          results.innerHTML = '<div class="friends-search-hint">No users found</div>';
          return;
        }

        results.innerHTML = '';
        snap.forEach(doc => {
          if (doc.id === currentUser.uid) return; // skip self
          const u = doc.data();
          const div = document.createElement('div');
          div.className = 'friends-search-item';

          const initial = (u.username || 'U').charAt(0).toUpperCase();
          const avatarHtml = u.avatar
            ? '<img src="' + _esc(u.avatar) + '" alt="">'
            : initial;

          const alreadyFriend = _myFriendUids.includes(doc.id);

          div.innerHTML =
            '<div class="friend-avatar search-clickable" data-uid="' + doc.id + '">' + avatarHtml + '</div>' +
            '<span class="friend-name search-clickable" data-uid="' + doc.id + '">' + _esc(u.username) + '</span>' +
            (alreadyFriend
              ? '<button class="btn btn-sm friends-add-btn" disabled style="opacity:.5;cursor:default">Friends</button>'
              : '<button class="btn btn-primary btn-sm friends-add-btn" data-uid="' + doc.id + '" data-name="' + _esc(u.username) + '">Add</button>');
          results.appendChild(div);
        });

        results.querySelectorAll('.friends-add-btn:not([disabled])').forEach(btn => {
          btn.addEventListener('click', () => _sendFriendRequest(btn.dataset.uid, btn.dataset.name, btn));
        });
        results.querySelectorAll('.search-clickable').forEach(el => {
          el.style.cursor = 'pointer';
          el.addEventListener('click', () => _viewUserProfile(el.dataset.uid));
        });
      } catch (err) {
        console.error(err);
        results.innerHTML = '<div class="friends-search-hint">Search failed</div>';
      }
    }, 300);
  }

  /* ── Send friend request ── */
  async function _sendFriendRequest(targetUid, targetName, btnEl) {
    try {
      // Check if already friends
      const myDoc = await db.collection('users').doc(currentUser.uid).get();
      const myFriends = myDoc.data().friends || [];
      if (myFriends.includes(targetUid)) {
        showToast('Already friends!', 'info');
        return;
      }

      // Check if they already sent us a pending request — auto-accept instead
      const reverseReqs = await db.collection('friend_requests')
        .where('from', '==', targetUid)
        .where('to', '==', currentUser.uid)
        .get();
      let reverseDoc = null;
      reverseReqs.forEach(d => { if (d.data().status === 'pending') reverseDoc = d; });
      if (reverseDoc) {
        await _acceptFriend(reverseDoc.id, targetUid);
        btnEl.textContent = 'Friends';
        btnEl.disabled = true;
        return;
      }

      // Check if a pending request already exists (denied ones are ignored so you can re-send)
      const existing = await db.collection('friend_requests')
        .where('from', '==', currentUser.uid)
        .where('to', '==', targetUid)
        .where('status', '==', 'pending')
        .limit(1)
        .get();

      if (!existing.empty) {
        showToast('Request already sent.', 'info');
        return;
      }

      await db.collection('friend_requests').add({
        from: currentUser.uid,
        fromUsername: userProfile.username,
        to: targetUid,
        toUsername: targetName,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        status: 'pending'
      });

      btnEl.textContent = 'Sent';
      btnEl.disabled = true;
      showToast('Friend request sent!', 'success');
    } catch (err) {
      console.error(err);
      showToast('Failed to send request.', 'error');
    }
  }

  /* ── Load pending requests (real-time) ── */
  function _loadPendingRequests() {
    db.collection('friend_requests')
      .where('to', '==', currentUser.uid)
      .onSnapshot(snap => {
        const container = document.getElementById('pending-list');
        const badge = document.getElementById('pending-count');
        const section = document.getElementById('friends-pending-section');

        const pending = [];
        snap.forEach(d => { if (d.data().status === 'pending') pending.push({ id: d.id, ...d.data() }); });

        badge.textContent = pending.length;
        badge.style.display = pending.length > 0 ? 'inline-flex' : 'none';

        if (!pending.length) {
          container.innerHTML = '<div class="friends-search-hint">No pending requests</div>';
          return;
        }

        container.innerHTML = '';
        pending.forEach(req => {
          const div = document.createElement('div');
          div.className = 'pending-item';
          div.innerHTML =
            '<span>' + _esc(req.fromUsername) + '</span>' +
            '<div class="pending-actions">' +
              '<button class="pending-accept" data-id="' + req.id + '" data-uid="' + req.from + '">Accept</button>' +
              '<button class="pending-deny" data-id="' + req.id + '">Deny</button>' +
            '</div>';
          container.appendChild(div);
        });

        container.querySelectorAll('.pending-accept').forEach(btn => {
          btn.addEventListener('click', () => _acceptFriend(btn.dataset.id, btn.dataset.uid));
        });
        container.querySelectorAll('.pending-deny').forEach(btn => {
          btn.addEventListener('click', () => _denyFriend(btn.dataset.id));
        });
      });
  }

  async function _acceptFriend(requestId, fromUid) {
    try {
      const batch = db.batch();
      const myRef = db.collection('users').doc(currentUser.uid);
      const theirRef = db.collection('users').doc(fromUid);
      const reqRef = db.collection('friend_requests').doc(requestId);

      batch.update(myRef, { friends: firebase.firestore.FieldValue.arrayUnion(fromUid) });
      batch.update(theirRef, { friends: firebase.firestore.FieldValue.arrayUnion(currentUser.uid) });
      batch.update(reqRef, { status: 'accepted' });

      await batch.commit();
      showToast('Friend added!', 'success');
    } catch (err) {
      console.error(err);
      showToast('Failed to accept.', 'error');
    }
  }

  async function _denyFriend(requestId) {
    try {
      await db.collection('friend_requests').doc(requestId).update({ status: 'denied' });
      showToast('Request denied.', 'info');
    } catch { showToast('Failed.', 'error'); }
  }

  /* ── Load sent requests (real-time) ── */
  function _loadSentRequests() {
    db.collection('friend_requests')
      .where('from', '==', currentUser.uid)
      .onSnapshot(snap => {
        const container = document.getElementById('sent-list');
        const badge = document.getElementById('sent-count');

        const sent = [];
        snap.forEach(d => { if (d.data().status === 'pending') sent.push({ id: d.id, ...d.data() }); });

        if (badge) {
          badge.textContent = sent.length;
          badge.style.display = sent.length > 0 ? 'inline-flex' : 'none';
        }

        if (!sent.length) {
          container.innerHTML = '<div class="friends-search-hint">No sent requests</div>';
          return;
        }

        container.innerHTML = '';
        sent.forEach(req => {
          const div = document.createElement('div');
          div.className = 'pending-item';
          div.innerHTML =
            '<span>' + _esc(req.toUsername) + '</span>' +
            '<div class="pending-actions">' +
              '<button class="pending-deny" data-id="' + req.id + '">Cancel</button>' +
            '</div>';
          container.appendChild(div);
        });

        container.querySelectorAll('.pending-deny').forEach(btn => {
          btn.addEventListener('click', () => _cancelFriendRequest(btn.dataset.id));
        });
      });
  }

  async function _cancelFriendRequest(requestId) {
    try {
      await db.collection('friend_requests').doc(requestId).update({ status: 'cancelled' });
      showToast('Request cancelled.', 'info');
    } catch { showToast('Failed to cancel.', 'error'); }
  }

  /* ── Load friends list (real-time, per-friend listeners) ── */
  const _friendListeners = new Map();     // uid → Firestore unsubscribe fn
  const _rtdbFriendListeners = new Map(); // uid → RTDB off fn

  // Periodically re-render so lastSeen staleness is re-evaluated even when Firestore doesn't push
  setInterval(() => {
    if (friendProfiles.length) _renderFriendsList(friendProfiles.slice());
  }, 10 * 1000);

  function _loadFriends() {
    // Watch the current user's friends array
    db.collection('users').doc(currentUser.uid).onSnapshot(doc => {
      if (!doc.exists) return;
      const friendUids = doc.data().friends || [];
      _myFriendUids = friendUids; // keep in sync for search button state

      if (!friendUids.length) {
        _friendListeners.forEach(unsub => unsub());
        _friendListeners.clear();
        _rtdbFriendListeners.forEach(off => off());
        _rtdbFriendListeners.clear();
        friendProfiles = [];
        document.getElementById('friends-list').innerHTML =
          '<div class="friends-search-hint">No friends yet. Add some!</div>';
        return;
      }

      // Remove listeners for UIDs no longer in the list
      _friendListeners.forEach((unsub, uid) => {
        if (!friendUids.includes(uid)) {
          unsub();
          _friendListeners.delete(uid);
          friendProfiles = friendProfiles.filter(p => p.uid !== uid);
          const rtdbOff = _rtdbFriendListeners.get(uid);
          if (rtdbOff) { rtdbOff(); _rtdbFriendListeners.delete(uid); }
        }
      });

      // Add per-friend listeners for any new UIDs
      friendUids.forEach(uid => {
        if (_friendListeners.has(uid)) return;
        const unsub = db.collection('users').doc(uid).onSnapshot(d => {
          if (!d.exists) return;
          const profile = { uid: d.id, ...d.data() };
          // RTDB takes priority for offline — prevents visibilitychange 'away' race condition
          if (_rtdbOffline.has(uid)) { profile.effectiveStatus = 'offline'; profile.online = false; }
          const idx = friendProfiles.findIndex(p => p.uid === uid);
          if (idx >= 0) {
            friendProfiles[idx] = profile;
          } else {
            friendProfiles.push(profile);
          }
          _renderFriendsList(friendProfiles.slice());
          // Live-update the profile panel if this friend is currently open
          if (uid === _selectedFriendUid) _updateFriendProfileLive(uid);
        });
        _friendListeners.set(uid, unsub);
        // RTDB presence listener — detects hard browser close / shutdown
        if (!_rtdbFriendListeners.has(uid)) {
          try {
            const presRef = firebase.database().ref('presence/' + uid);
            const rtdbHandler = snap => {
              const val = snap.val();
              if (val && val.online === false) {
                const fProf = friendProfiles.find(p => p.uid === uid);
                const friendIsAuto = !fProf || !fProf.status || fProf.status === 'auto';
                // Only sync effective offline to Firestore for auto-status users;
                // manual-status users keep their chosen status even when browser is closed.
                if (friendIsAuto) {
                  _rtdbOffline.add(uid);
                  db.collection('users').doc(uid).update({ effectiveStatus: 'offline', online: false }).catch(() => {});
                  const idx = friendProfiles.findIndex(p => p.uid === uid);
                  if (idx >= 0) {
                    friendProfiles[idx] = { ...friendProfiles[idx], effectiveStatus: 'offline' };
                    _renderFriendsList(friendProfiles.slice());
                  }
                }
              } else if (val && val.online === true) {
                _rtdbOffline.delete(uid);
                // Re-read the stored profile with the override removed and re-render
                const idx = friendProfiles.findIndex(p => p.uid === uid);
                if (idx >= 0 && friendProfiles[idx].effectiveStatus === 'offline') {
                  db.collection('users').doc(uid).get().then(docSnap => {
                    if (!docSnap.exists) return;
                    const d = docSnap.data();
                    const realStatus = d.effectiveStatus || 'offline';
                    friendProfiles[idx] = { ...friendProfiles[idx], ...d, effectiveStatus: realStatus };
                    _renderFriendsList(friendProfiles.slice());
                  }).catch(() => {});
                }
              }
            };
            presRef.on('value', rtdbHandler);
            _rtdbFriendListeners.set(uid, () => presRef.off('value', rtdbHandler));
          } catch (e) { /* RTDB unavailable */ }
        }
      });
    });
  }

  /* ── Resolve effective status (with lastSeen staleness fallback) ── */
  function _resolveStatus(profile) {
    const eStatus = profile.effectiveStatus || 'offline';
    if (eStatus === 'offline') return 'offline';
    // Manual status (not auto) — trust effectiveStatus directly; the RTDB offline
    // signal and _goOffline will write 'offline' when they truly disconnect.
    if (profile.status && profile.status !== 'auto') return eStatus;
    // Auto status — fall back to offline if the heartbeat has gone stale
    // (browser throttles background intervals to ~60s, so use 90s threshold)
    if (profile.lastSeen) {
      let ms = null;
      if (profile.lastSeen.toDate) ms = profile.lastSeen.toDate().getTime();
      else if (profile.lastSeen.seconds) ms = profile.lastSeen.seconds * 1000;
      if (ms !== null && Date.now() - ms > 90 * 1000) return 'offline';
    }
    return eStatus;
  }

  function _renderFriendsList(profiles) {
    const list = document.getElementById('friends-list');

    // Online-only filter
    if (_showOnlineOnly) {
      profiles = profiles.filter(f => _resolveStatus(f) !== 'offline');
    }

    // Sort: online first
    const order = { online: 0, away: 1, dnd: 2, offline: 3 };
    profiles.sort((a, b) => (order[_resolveStatus(a)] || 3) - (order[_resolveStatus(b)] || 3));

    if (!profiles.length) {
      list.innerHTML = _showOnlineOnly
        ? '<div class="friends-search-hint">No friends online</div>'
        : '<div class="friends-search-hint">No friends yet. Add some!</div>';
      return;
    }

    list.innerHTML = profiles.map(f => {
      const initial = (f.username || 'U').charAt(0).toUpperCase();
      const avatarHtml = f.avatar
        ? '<img src="' + _esc(f.avatar) + '" alt="">'
        : initial;
      const eStatus = _resolveStatus(f);
      const activity = _resolveActivity(f, eStatus);

      return '<div class="friend-item" data-uid="' + f.uid + '">' +
        '<div class="friend-avatar">' + avatarHtml +
          '<span class="status-dot ' + eStatus + '"></span>' +
        '</div>' +
        '<div class="friend-item-info">' +
          '<div class="friend-name">' + _esc(f.username) + '</div>' +
          '<div class="friend-status">' + _esc(activity) + '</div>' +
        '</div></div>';
    }).join('');

    list.querySelectorAll('.friend-item').forEach(el => {
      if (el.dataset.uid === _selectedFriendUid) el.classList.add('active');
      el.addEventListener('click', () => {
        list.querySelectorAll('.friend-item').forEach(f => f.classList.remove('active'));
        el.classList.add('active');
        _selectFriend(el.dataset.uid);
      });
    });
  }

  /* ── Resolve activity text ── */
  function _resolveActivity(profile, eStatus) {
    if (eStatus === undefined) eStatus = _resolveStatus(profile);
    if (eStatus === 'offline') return 'Offline';
    if (eStatus === 'dnd') return 'Do Not Disturb';

    const activity = profile.activity || {};
    if (activity.page === 'games' && activity.game) return 'Playing ' + activity.game;
    if (activity.page === 'messenger' && activity.server) return 'In RedsssMessenger — ' + activity.server;
    if (activity.page === 'messenger' && activity.dm)     return 'Messaging ' + activity.dm;
    if (activity.page === 'messenger') return 'In RedsssMessenger';
    if (activity.page === 'games') return 'Browsing Games';
    if (activity.page === 'support') return 'Viewing Support';
    if (activity.page === 'home') return eStatus === 'away' ? 'Away' : 'Online';
    if (activity.page === 'friends') return eStatus === 'away' ? 'Away' : 'Viewing Friends';

    return eStatus === 'away' ? 'Away' : 'Online';
  }

  /* ── Filter list ── */
  function _filterFriends() {
    const q = document.getElementById('friends-filter').value.toLowerCase();
    document.querySelectorAll('#friends-list .friend-item').forEach(el => {
      const name = el.querySelector('.friend-name').textContent.toLowerCase();
      el.style.display = name.includes(q) ? '' : 'none';
    });
  }

  /* ── Select friend → show profile ── */
  /* ── In-app confirm modal ── */
  function _fShowConfirm({ title, message, confirmLabel, danger, onConfirm }) {
    const overlay = document.getElementById('friends-confirm-modal');
    document.getElementById('fconfirm-title').textContent = title || 'Confirm';
    document.getElementById('fconfirm-message').textContent = message || '';
    const okBtn = document.getElementById('fconfirm-ok');
    okBtn.textContent = confirmLabel || 'Confirm';
    okBtn.className = 'btn ' + (danger ? 'friend-unfriend-btn' : 'btn-primary');
    overlay.classList.add('open');

    const okNew = okBtn.cloneNode(true);
    const cancel = document.getElementById('fconfirm-cancel');
    const cancelNew = cancel.cloneNode(true);
    okBtn.replaceWith(okNew);
    cancel.replaceWith(cancelNew);

    const close = () => overlay.classList.remove('open');
    okNew.addEventListener('click', () => { close(); onConfirm(); });
    cancelNew.addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); }, { once: true });
  }

  /* ── Format last seen timestamp ── */
  function _formatLastSeen(lastSeen) {
    let ms = null;
    if (lastSeen && lastSeen.toDate) ms = lastSeen.toDate().getTime();
    else if (lastSeen && lastSeen.seconds) ms = lastSeen.seconds * 1000;
    if (ms === null) return 'recently';
    const diff = Date.now() - ms;
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (mins < 2) return 'just now';
    if (mins < 60) return mins + ' minute' + (mins === 1 ? '' : 's') + ' ago';
    if (hours < 24) return hours + ' hour' + (hours === 1 ? '' : 's') + ' ago';
    if (days < 7) return days + ' day' + (days === 1 ? '' : 's') + ' ago';
    return 'a while ago';
  }

  /* ── Select friend → show profile ── */
  function _selectFriend(uid) {
    _selectedFriendUid = uid;
    _selectedFriendTab = 'about';
    _renderFriendProfile(uid);
  }

  function _renderFriendProfile(uid) {
    const f = friendProfiles.find(p => p.uid === uid);
    if (!f) return;

    const main = document.getElementById('friends-main');
    const initial = (f.username || 'U').charAt(0).toUpperCase();
    const avatarHtml = f.avatar
      ? '<img src="' + _esc(f.avatar) + '" alt="">'
      : '<span class="friend-profile-initial">' + initial + '</span>';
    const eStatus = _resolveStatus(f);
    const activity = _resolveActivity(f, eStatus);
    const activityObj = f.activity || {};
    const showJoin = activityObj.page === 'games' && activityObj.game;

    const joined = f.createdAt
      ? new Date(f.createdAt.toDate()).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' })
      : null;

    const statusLabels = { online: 'Online', away: 'Away', dnd: 'Do Not Disturb', offline: 'Offline' };

    // Activity icon
    let activityIcon = '';
    if (activityObj.page === 'games' && activityObj.game) {
      activityIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M12 12h.01"/><path d="M7 12h3"/><path d="M14 10v4"/><path d="M17 12h.01"/></svg>';
    } else if (activityObj.page === 'messenger') {
      activityIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    } else {
      activityIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
    }

    main.innerHTML =
      '<div class="friend-profile-card">' +
        '<div class="friend-profile-banner"></div>' +
        '<div class="friend-profile-body">' +
          '<div class="friend-profile-avatar-wrap">' +
            '<div class="friend-profile-avatar" id="fp-avatar-wrap">' + avatarHtml +
              '<span class="status-dot ' + eStatus + '" id="fp-status-dot"></span>' +
            '</div>' +
          '</div>' +
          '<div class="friend-profile-info">' +
            '<div class="friend-profile-top">' +
              '<h2 class="friend-profile-name">' + _esc(f.username) + '</h2>' +
              '<span class="friend-status-pill ' + eStatus + '" id="fp-status-pill">' + (statusLabels[eStatus] || 'Offline') + '</span>' +
            '</div>' +
            '<div class="friend-profile-activity">' +
              activityIcon + '<span id="fp-activity-text">' + _esc(activity) + '</span>' +
            '</div>' +
            (eStatus === 'offline' && f.lastSeen
              ? '<div class="friend-profile-lastseen" id="fp-last-seen">Last seen ' + _formatLastSeen(f.lastSeen) + '</div>'
              : '<div class="friend-profile-lastseen" id="fp-last-seen" style="display:none"></div>') +
          '</div>' +
        '</div>' +
        '<div class="friend-tabs">' +
          '<button class="friend-tab' + (_selectedFriendTab === 'about' ? ' active' : '') + '" data-tab="about">About</button>' +
          '<button class="friend-tab' + (_selectedFriendTab === 'mutual-friends' ? ' active' : '') + '" data-tab="mutual-friends" id="tab-mutual-friends">Mutual Friends</button>' +
          '<button class="friend-tab' + (_selectedFriendTab === 'mutual-servers' ? ' active' : '') + '" data-tab="mutual-servers" id="tab-mutual-servers">Mutual Servers</button>' +
        '</div>' +
        '<div class="friend-tab-panels">' +
          '<div class="friend-tab-panel' + (_selectedFriendTab === 'about' ? ' active' : '') + '" data-panel="about">' +
            (f.description
              ? '<div class="friend-profile-bio-card">' +
                  '<div class="friend-profile-bio-label">Description</div>' +
                  '<div class="friend-profile-bio-text">' + _esc(f.description) + '</div>' +
                '</div>'
              : '') +
            (joined
              ? '<div class="friend-profile-meta">' +
                  '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>' +
                  '<span>Member since ' + joined + '</span>' +
                '</div>'
              : '') +
            '<div class="friend-note-card">' +
              '<div class="friend-profile-bio-label">Note</div>' +
              '<textarea class="friend-note-area" id="friend-note-area" maxlength="200" placeholder="Add a private note about this person..."></textarea>' +
              '<button class="btn btn-sm friend-note-save" id="friend-note-save">Save Note</button>' +
            '</div>' +
            '<div class="friend-profile-actions">' +
              '<button class="btn btn-primary" id="friend-message-btn">Message</button>' +
              '<button class="btn friend-join-action-btn" id="friend-join-btn" style="display:' + (showJoin ? '' : 'none') + '">Join Game</button>' +
              '<button class="btn friend-unfriend-btn" id="friend-unfriend-btn">Unfriend</button>' +
            '</div>' +
          '</div>' +
          '<div class="friend-tab-panel' + (_selectedFriendTab === 'mutual-friends' ? ' active' : '') + '" data-panel="mutual-friends">' +
            '<div class="mutual-list" id="mutual-friends-list"><div class="friends-search-hint">Loading...</div></div>' +
          '</div>' +
          '<div class="friend-tab-panel' + (_selectedFriendTab === 'mutual-servers' ? ' active' : '') + '" data-panel="mutual-servers">' +
            '<div class="mutual-list" id="mutual-servers-list"><div class="friends-search-hint">Loading...</div></div>' +
          '</div>' +
        '</div>' +
      '</div>';

    // Tab switching
    main.querySelectorAll('.friend-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        _selectedFriendTab = btn.dataset.tab;
        main.querySelectorAll('.friend-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === _selectedFriendTab));
        main.querySelectorAll('.friend-tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === _selectedFriendTab));
        if (_selectedFriendTab === 'mutual-friends') _loadMutualFriends(uid);
        if (_selectedFriendTab === 'mutual-servers') _loadMutualServers(uid);
      });
    });

    // Button actions
    document.getElementById('friend-message-btn').addEventListener('click', () => {
      window.location.href = 'messenger.html?dm=' + uid;
    });
    document.getElementById('friend-join-btn').addEventListener('click', () => {
      window.location.href = 'games.html?join=' + uid;
    });
    document.getElementById('friend-unfriend-btn').addEventListener('click', () => {
      _unfriend(uid, f.username);
    });
    document.getElementById('friend-note-save').addEventListener('click', () => {
      _saveFriendNote(uid);
    });

    // Load note
    _loadFriendNote(uid);

    // Pre-load mutual counts for tab labels
    _loadMutualCounts(uid);

    // If tabs other than about are active, load their content
    if (_selectedFriendTab === 'mutual-friends') _loadMutualFriends(uid);
    if (_selectedFriendTab === 'mutual-servers') _loadMutualServers(uid);
  }

  /* ── View any user's full profile (not necessarily a friend) ── */
  async function _viewUserProfile(uid) {
    const main = document.getElementById('friends-main');
    main.innerHTML = '<div class="friends-empty">Loading profile...</div>';

    // Check if this uid is already a friend — if so, use _selectFriend directly
    const existingFriend = friendProfiles.find(p => p.uid === uid);
    if (existingFriend) {
      _selectFriend(uid);
      return;
    }

    // Fetch user from Firestore
    let f;
    try {
      const doc = await db.collection('users').doc(uid).get();
      if (!doc.exists) {
        main.innerHTML = '<div class="friends-empty">User not found</div>';
        return;
      }
      f = { uid: doc.id, ...doc.data() };
    } catch (err) {
      console.error(err);
      main.innerHTML = '<div class="friends-empty">Failed to load profile</div>';
      return;
    }

    const initial = (f.username || 'U').charAt(0).toUpperCase();
    const avatarHtml = f.avatar
      ? '<img src="' + _esc(f.avatar) + '" alt="">'
      : '<span class="friend-profile-initial">' + initial + '</span>';
    const eStatus = f.effectiveStatus || 'offline';
    const isFriend = _myFriendUids.includes(uid);

    const statusLabels = { online: 'Online', away: 'Away', dnd: 'Do Not Disturb', offline: 'Offline' };

    // Activity
    let activityText = '';
    const activityObj = f.activity || {};
    if (activityObj.page === 'games' && activityObj.game) activityText = 'Playing ' + activityObj.game;
    else if (activityObj.page === 'messenger' && activityObj.dm) activityText = 'Chatting with ' + activityObj.dm;
    else if (activityObj.page === 'messenger' && activityObj.server) activityText = 'In ' + activityObj.server;
    else if (activityObj.page === 'messenger') activityText = 'On Messenger';
    else if (activityObj.page === 'friends') activityText = 'On Friends page';
    else if (activityObj.page === 'games') activityText = 'Browsing Games';
    if (eStatus === 'offline') activityText = 'Offline';

    const joined = f.createdAt
      ? new Date(f.createdAt.toDate()).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' })
      : null;

    const lastSeenText = (eStatus === 'offline' && f.lastSeen) ? _formatLastSeen(f.lastSeen) : null;

    // Activity icon
    let activityIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
    if (activityObj.page === 'games' && activityObj.game) {
      activityIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M12 12h.01"/><path d="M7 12h3"/><path d="M14 10v4"/><path d="M17 12h.01"/></svg>';
    } else if (activityObj.page === 'messenger') {
      activityIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    }

    main.innerHTML =
      '<div class="friend-profile-card">' +
        '<div class="friend-profile-banner"></div>' +
        '<div class="friend-profile-body">' +
          '<div class="friend-profile-avatar-wrap">' +
            '<div class="friend-profile-avatar">' + avatarHtml +
              '<span class="status-dot ' + eStatus + '"></span>' +
            '</div>' +
          '</div>' +
          '<div class="friend-profile-info">' +
            '<div class="friend-profile-top">' +
              '<h2 class="friend-profile-name">' + _esc(f.username) + '</h2>' +
              '<span class="friend-status-pill ' + eStatus + '">' + (statusLabels[eStatus] || 'Offline') + '</span>' +
            '</div>' +
            '<div class="friend-profile-activity">' +
              activityIcon + '<span>' + _esc(activityText) + '</span>' +
            '</div>' +
            (lastSeenText
              ? '<div class="friend-profile-lastseen">Last seen ' + _esc(lastSeenText) + '</div>'
              : '') +
          '</div>' +
        '</div>' +
        '<div class="friend-tab-panels">' +
          '<div class="friend-tab-panel active" data-panel="about">' +
            (f.description
              ? '<div class="friend-profile-bio-card">' +
                  '<div class="friend-profile-bio-label">Description</div>' +
                  '<div class="friend-profile-bio-text">' + _esc(f.description) + '</div>' +
                '</div>'
              : '') +
            (joined
              ? '<div class="friend-profile-meta">' +
                  '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>' +
                  '<span>Member since ' + joined + '</span>' +
                '</div>'
              : '') +
            '<div class="friend-profile-actions">' +
              (isFriend
                ? '<button class="btn btn-sm" disabled style="opacity:.5;cursor:default">Already Friends</button>'
                : '<button class="btn btn-primary" id="view-add-friend-btn">Add Friend</button>') +
              '<button class="btn" id="view-dm-btn">Message</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    // Wire Add Friend
    const addBtn = document.getElementById('view-add-friend-btn');
    if (addBtn) {
      addBtn.addEventListener('click', async () => {
        addBtn.disabled = true;
        addBtn.textContent = 'Sending...';
        try {
          const existing = await db.collection('friend_requests')
            .where('from', '==', currentUser.uid)
            .where('to', '==', uid)
            .get();
          let hasPending = false;
          existing.forEach(d => { if (d.data().status === 'pending') hasPending = true; });
          if (hasPending) {
            showToast('Request already sent.', 'info');
            addBtn.textContent = 'Sent';
            return;
          }
          await db.collection('friend_requests').add({
            from: currentUser.uid,
            fromUsername: userProfile.username,
            to: uid,
            toUsername: f.username,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            status: 'pending'
          });
          addBtn.textContent = 'Sent!';
          showToast('Friend request sent!', 'success');
        } catch (err) {
          console.error(err);
          addBtn.textContent = 'Add Friend';
          addBtn.disabled = false;
          showToast('Failed to send request.', 'error');
        }
      });
    }

    // Wire DM
    document.getElementById('view-dm-btn').addEventListener('click', () => {
      window.location.href = 'messenger.html?dm=' + uid;
    });
  }

  /* ── Live update selected friend profile (preserves tabs + note) ── */
  function _updateFriendProfileLive(uid) {
    const f = friendProfiles.find(p => p.uid === uid);
    if (!f) return;
    const eStatus = _resolveStatus(f);
    const activity = _resolveActivity(f, eStatus);
    const statusLabels = { online: 'Online', away: 'Away', dnd: 'Do Not Disturb', offline: 'Offline' };

    const dot = document.getElementById('fp-status-dot');
    if (dot) dot.className = 'status-dot ' + eStatus;

    const pill = document.getElementById('fp-status-pill');
    if (pill) { pill.className = 'friend-status-pill ' + eStatus; pill.textContent = statusLabels[eStatus] || 'Offline'; }

    const actEl = document.getElementById('fp-activity-text');
    if (actEl) actEl.textContent = activity;

    const lsEl = document.getElementById('fp-last-seen');
    if (lsEl) {
      if (eStatus === 'offline' && f.lastSeen) {
        lsEl.textContent = 'Last seen ' + _formatLastSeen(f.lastSeen);
        lsEl.style.display = '';
      } else {
        lsEl.style.display = 'none';
      }
    }

    const joinBtn = document.getElementById('friend-join-btn');
    if (joinBtn) {
      const activityObj = f.activity || {};
      joinBtn.style.display = (activityObj.page === 'games' && activityObj.game) ? '' : 'none';
    }
  }

  /* ── Mutual counts for tab labels ── */
  async function _loadMutualCounts(uid) {
    try {
      const theirDoc = await db.collection('users').doc(uid).get();
      const theirFriends = ((theirDoc.data() || {}).friends) || [];
      const mutualFriendCount = _myFriendUids.filter(f => theirFriends.includes(f)).length;
      const tab1 = document.getElementById('tab-mutual-friends');
      if (tab1) tab1.textContent = 'Mutual Friends — ' + mutualFriendCount;
    } catch { /* ignore */ }
    try {
      const snap = await db.collection('servers').where('members', 'array-contains', currentUser.uid).get();
      let mutualServerCount = 0;
      snap.forEach(doc => { if ((doc.data().members || []).includes(uid)) mutualServerCount++; });
      const tab2 = document.getElementById('tab-mutual-servers');
      if (tab2) tab2.textContent = 'Mutual Servers — ' + mutualServerCount;
    } catch { /* ignore */ }
  }

  /* ── Mutual friends ── */
  async function _loadMutualFriends(uid) {
    const container = document.getElementById('mutual-friends-list');
    if (!container) return;
    try {
      const theirDoc = await db.collection('users').doc(uid).get();
      const theirFriends = ((theirDoc.data() || {}).friends) || [];
      const mutual = _myFriendUids.filter(f => theirFriends.includes(f));
      if (!mutual.length) {
        container.innerHTML = '<div class="friends-search-hint">No mutual friends</div>';
        return;
      }
      const profiles = mutual.map(fid => friendProfiles.find(p => p.uid === fid)).filter(Boolean);
      container.innerHTML = profiles.map(m => {
        const initial = (m.username || 'U').charAt(0).toUpperCase();
        const av = m.avatar ? '<img src="' + _esc(m.avatar) + '" alt="">' : initial;
        const s = _resolveStatus(m);
        return '<div class="mutual-item"><div class="friend-avatar" style="flex-shrink:0">' + av +
          '<span class="status-dot ' + s + '"></span></div>' +
          '<span class="friend-name">' + _esc(m.username) + '</span></div>';
      }).join('');
    } catch {
      container.innerHTML = '<div class="friends-search-hint">Failed to load</div>';
    }
  }

  /* ── Mutual servers ── */
  async function _loadMutualServers(uid) {
    const container = document.getElementById('mutual-servers-list');
    if (!container) return;
    try {
      const snap = await db.collection('servers')
        .where('members', 'array-contains', currentUser.uid)
        .get();
      const mutual = [];
      snap.forEach(doc => {
        const s = doc.data();
        if ((s.members || []).includes(uid)) mutual.push({ id: doc.id, ...s });
      });
      if (!mutual.length) {
        container.innerHTML = '<div class="friends-search-hint">No mutual servers</div>';
        return;
      }
      container.innerHTML = mutual.map(s => {
        const icon = s.image ? '<img src="' + _esc(s.image) + '" alt="">' : (s.name || 'S').charAt(0).toUpperCase();
        return '<div class="mutual-item"><div class="mutual-server-icon">' + icon + '</div>' +
          '<span class="friend-name">' + _esc(s.name) + '</span></div>';
      }).join('');
    } catch {
      container.innerHTML = '<div class="friends-search-hint">Failed to load</div>';
    }
  }

  /* ── Friend notes ── */
  async function _loadFriendNote(uid) {
    const area = document.getElementById('friend-note-area');
    if (!area) return;
    try {
      const doc = await db.collection('users').doc(currentUser.uid).get();
      const notes = ((doc.data() || {}).friendNotes) || {};
      area.value = notes[uid] || '';
    } catch { /* ignore */ }
  }

  async function _saveFriendNote(uid) {
    const area = document.getElementById('friend-note-area');
    if (!area) return;
    const note = area.value.slice(0, 200);
    try {
      await db.collection('users').doc(currentUser.uid).update({
        ['friendNotes.' + uid]: note
      });
      showToast('Note saved.', 'success');
    } catch { showToast('Failed to save note.', 'error'); }
  }

  /* ── Unfriend ── */
  function _unfriend(uid, username) {
    _fShowConfirm({
      title: 'Unfriend ' + _esc(username) + '?',
      message: 'You will no longer be friends. This cannot be undone.',
      confirmLabel: 'Unfriend',
      danger: true,
      onConfirm: async () => {
        try {
          const batch = db.batch();
          batch.update(db.collection('users').doc(currentUser.uid), {
            friends: firebase.firestore.FieldValue.arrayRemove(uid)
          });
          batch.update(db.collection('users').doc(uid), {
            friends: firebase.firestore.FieldValue.arrayRemove(currentUser.uid)
          });
          await batch.commit();
          _selectedFriendUid = null;
          document.getElementById('friends-main').innerHTML =
            '<div class="friends-empty">Select a friend to view their profile</div>';
          showToast('Unfriended ' + username + '.', 'info');
        } catch (err) {
          console.error(err);
          showToast('Failed to unfriend.', 'error');
        }
      }
    });
  }

  function _esc(str) {
    const d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
  }

  return { init };
})();

/* ── Boot ── */
Nav.init('friends').then(({ user, profile }) => {
  Friends.init(user, profile);
});
