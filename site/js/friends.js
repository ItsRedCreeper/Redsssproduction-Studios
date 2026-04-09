/* ───────────────────────────────────────────────
   friends.js — Friends page
   Friend management, search, requests, profiles.
   ─────────────────────────────────────────────── */

const Friends = (() => {
  let currentUser = null;
  let userProfile = null;
  let friendProfiles = [];
  let _myFriendUids = []; // keep in sync with live listener

  function init(user, profile) {
    currentUser = user;
    userProfile = profile;

    // Add friend toggle
    document.getElementById('add-friend-toggle').addEventListener('click', _toggleAddFriend);

    // Friend search (3+ chars)
    document.getElementById('friend-search-input').addEventListener('input', _onSearchInput);

    // Filter friends
    document.getElementById('friends-filter').addEventListener('input', _filterFriends);

    // Load data
    _loadFriends();
    _loadPendingRequests();
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
            '<div class="friend-avatar">' + avatarHtml + '</div>' +
            '<span class="friend-name">' + _esc(u.username) + '</span>' +
            (alreadyFriend
              ? '<button class="btn btn-sm friends-add-btn" disabled style="opacity:.5;cursor:default">Friends</button>'
              : '<button class="btn btn-primary btn-sm friends-add-btn" data-uid="' + doc.id + '" data-name="' + _esc(u.username) + '">Add</button>');
          results.appendChild(div);
        });

        results.querySelectorAll('.friends-add-btn:not([disabled])').forEach(btn => {
          btn.addEventListener('click', () => _sendFriendRequest(btn.dataset.uid, btn.dataset.name, btn));
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

      // Check if request already exists
      const existing = await db.collection('friend_requests')
        .where('from', '==', currentUser.uid)
        .where('to', '==', targetUid)
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

      // Notify target
      await db.collection('users').doc(targetUid).collection('notifications').add({
        message: userProfile.username + ' sent you a friend request!',
        type: 'friend_request',
        fromUid: currentUser.uid,
        read: false,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
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
      .where('status', '==', 'pending')
      .onSnapshot(snap => {
        const container = document.getElementById('pending-list');
        const badge = document.getElementById('pending-count');
        const section = document.getElementById('friends-pending-section');

        badge.textContent = snap.size;
        badge.style.display = snap.size > 0 ? 'inline-flex' : 'none';

        if (snap.empty) {
          container.innerHTML = '<div class="friends-search-hint">No pending requests</div>';
          return;
        }

        container.innerHTML = '';
        snap.forEach(doc => {
          const req = doc.data();
          const div = document.createElement('div');
          div.className = 'pending-item';
          div.innerHTML =
            '<span>' + _esc(req.fromUsername) + '</span>' +
            '<div class="pending-actions">' +
              '<button class="pending-accept" data-id="' + doc.id + '" data-uid="' + req.from + '">Accept</button>' +
              '<button class="pending-deny" data-id="' + doc.id + '">Deny</button>' +
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

  /* ── Load friends list (real-time, per-friend listeners) ── */
  const _friendListeners = new Map();     // uid → Firestore unsubscribe fn
  const _rtdbFriendListeners = new Map(); // uid → RTDB off fn

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
          const idx = friendProfiles.findIndex(p => p.uid === uid);
          if (idx >= 0) {
            friendProfiles[idx] = profile;
          } else {
            friendProfiles.push(profile);
          }
          _renderFriendsList(friendProfiles.slice());
        });
        _friendListeners.set(uid, unsub);
        // RTDB presence listener — detects hard browser close / shutdown
        if (!_rtdbFriendListeners.has(uid)) {
          try {
            const presRef = firebase.database().ref('presence/' + uid);
            const rtdbHandler = snap => {
              const val = snap.val();
              if (val && val.online === false) {
                const idx = friendProfiles.findIndex(p => p.uid === uid);
                if (idx >= 0 && friendProfiles[idx].effectiveStatus !== 'offline') {
                  friendProfiles[idx] = { ...friendProfiles[idx], effectiveStatus: 'offline' };
                  _renderFriendsList(friendProfiles.slice());
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

  function _renderFriendsList(profiles) {
    const list = document.getElementById('friends-list');

    // Sort: online first
    const order = { online: 0, away: 1, dnd: 2, offline: 3 };
    profiles.sort((a, b) => (order[a.effectiveStatus] || 3) - (order[b.effectiveStatus] || 3));

    list.innerHTML = profiles.map(f => {
      const initial = (f.username || 'U').charAt(0).toUpperCase();
      const avatarHtml = f.avatar
        ? '<img src="' + _esc(f.avatar) + '" alt="">'
        : initial;
      const eStatus = f.effectiveStatus || 'offline';
      const activity = _resolveActivity(f);

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
      el.addEventListener('click', () => {
        list.querySelectorAll('.friend-item').forEach(f => f.classList.remove('active'));
        el.classList.add('active');
        _selectFriend(el.dataset.uid);
      });
    });
  }

  /* ── Resolve activity text ── */
  function _resolveActivity(profile) {
    const eStatus = profile.effectiveStatus || 'offline';
    if (eStatus === 'offline') return 'Offline';
    if (eStatus === 'dnd') return 'Do Not Disturb';

    const activity = profile.activity || {};
    if (activity.page === 'games' && activity.game) return 'Playing ' + activity.game;
    if (activity.page === 'messenger' && activity.server) return 'In RedsssMessenger — ' + activity.server;
    if (activity.page === 'messenger' && activity.dm)     return 'Messaging ' + activity.dm;
    if (activity.page === 'messenger') return 'In RedsssMessenger';
    if (activity.page === 'games') return 'Browsing Games';
    if (activity.page === 'support') return 'Viewing Support';
    if (activity.page === 'home') return 'Online';
    if (activity.page === 'friends') return 'Viewing Friends';

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
  function _selectFriend(uid) {
    const f = friendProfiles.find(p => p.uid === uid);
    if (!f) return;

    const main = document.getElementById('friends-main');
    const initial = (f.username || 'U').charAt(0).toUpperCase();
    const avatarHtml = f.avatar
      ? '<img src="' + _esc(f.avatar) + '" alt="">'
      : '<span class="friend-profile-initial">' + initial + '</span>';
    const eStatus = f.effectiveStatus || 'offline';
    const activity = _resolveActivity(f);
    const joined = f.createdAt
      ? new Date(f.createdAt.toDate()).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      : 'Unknown';

    // Show Join Friend button if they're in a game
    const activityObj = f.activity || {};
    const showJoin = activityObj.page === 'games' && activityObj.game;

    main.innerHTML =
      '<div class="friend-profile">' +
        '<div class="friend-profile-avatar">' + avatarHtml +
          '<span class="status-dot ' + eStatus + '"></span>' +
        '</div>' +
        '<h2 class="friend-profile-name">' + _esc(f.username) + '</h2>' +
        '<div class="friend-profile-status">' +
          '<span class="status-dot-inline ' + eStatus + '"></span>' +
          _esc(activity) +
        '</div>' +
        '<div class="friend-profile-joined">Member since ' + joined + '</div>' +
        '<div class="friend-profile-actions">' +
          '<button class="btn btn-primary" id="friend-message-btn">Message</button>' +
          (showJoin ? '<button class="btn" id="friend-join-btn" style="border:1px solid var(--border);color:var(--text)">Join Friend</button>' : '') +
        '</div>' +
      '</div>';

    document.getElementById('friend-message-btn').addEventListener('click', () => {
      window.location.href = 'messenger.html?dm=' + uid;
    });

    if (showJoin) {
      document.getElementById('friend-join-btn').addEventListener('click', () => {
        window.location.href = 'games.html?join=' + uid;
      });
    }
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
