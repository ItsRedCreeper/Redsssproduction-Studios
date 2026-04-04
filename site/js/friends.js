/* ───────────────────────────────────────────────
   Friends — RedsssProduction Studios v2
   Friend requests, list, search, DM creation
   ─────────────────────────────────────────────── */

const Friends = (() => {
  let currentTab = 'online';
  let friendsData = []; // array of user profiles for friends
  let pendingData = []; // incoming friend requests

  function init() {
    if (!currentUser || !currentProfile) return;

    // Tab switching
    document.querySelectorAll('.friends-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        currentTab = tab.dataset.ftab;
        document.querySelectorAll('.friends-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        render();
      });
    });

    // Add friend button
    document.getElementById('add-friend-btn').addEventListener('click', sendFriendRequest);
    document.getElementById('add-friend-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendFriendRequest();
    });

    // Search
    document.getElementById('friends-search').addEventListener('input', render);

    // Listen for friend requests
    listenRequests();
    // Listen for friends list changes
    listenFriends();
  }

  function listenFriends() {
    db.collection('users').doc(currentUser.uid)
      .onSnapshot(async (doc) => {
        if (!doc.exists) return;
        const data = doc.data();
        currentProfile.friends = data.friends || [];

        // Fetch profiles of all friends
        friendsData = [];
        for (const fid of currentProfile.friends) {
          try {
            const fDoc = await db.collection('users').doc(fid).get();
            if (fDoc.exists) {
              friendsData.push({ id: fDoc.id, ...fDoc.data() });
            }
          } catch { /* skip */ }
        }
        render();
      });
  }

  function listenRequests() {
    db.collection('friendRequests')
      .where('to', '==', currentUser.uid)
      .where('status', '==', 'pending')
      .onSnapshot(async (snap) => {
        pendingData = [];
        for (const doc of snap.docs) {
          const req = { id: doc.id, ...doc.data() };
          try {
            const userDoc = await db.collection('users').doc(req.from).get();
            req.fromUser = userDoc.exists ? userDoc.data() : { username: 'Unknown' };
          } catch {
            req.fromUser = { username: 'Unknown' };
          }
          pendingData.push(req);
        }
        render();

        // Update pending tab count
        const pendingTab = document.querySelector('.friends-tab[data-ftab="pending"]');
        if (pendingData.length > 0) {
          pendingTab.textContent = 'Pending (' + pendingData.length + ')';
        } else {
          pendingTab.textContent = 'Pending';
        }
      });
  }

  function render() {
    const list = document.getElementById('friends-list');
    const search = (document.getElementById('friends-search').value || '').toLowerCase();

    if (currentTab === 'pending') {
      renderPending(list, search);
    } else {
      renderFriends(list, search);
    }
  }

  function renderFriends(list, search) {
    let filtered = friendsData;

    if (search) {
      filtered = filtered.filter(f => f.username.toLowerCase().includes(search));
    }

    if (currentTab === 'online') {
      filtered = filtered.filter(f => f.online);
    }

    if (filtered.length === 0) {
      list.innerHTML = '<p style="padding:12px;color:var(--text-muted);font-size:13px">' +
        (currentTab === 'online' ? 'No friends online' : 'No friends yet') + '</p>';
      return;
    }

    list.innerHTML = filtered.map(f => {
      const initial = (f.username || '?')[0].toUpperCase();
      const statusClass = f.online ? 'online' : 'offline';
      const statusText = f.online ? (f.status || 'Online') : 'Offline';

      return `
        <div class="friend-item" onclick="Friends.startDM('${f.id}')">
          <div class="friend-avatar">
            ${f.avatar ? '<img src="' + escapeHtml(f.avatar) + '" alt="">' : initial}
            <div class="status-dot ${statusClass}"></div>
          </div>
          <div class="friend-info">
            <div class="name">${escapeHtml(f.username)}</div>
            <div class="status">${escapeHtml(statusText)}</div>
          </div>
        </div>
      `;
    }).join('');
  }

  function renderPending(list, search) {
    let filtered = pendingData;
    if (search) {
      filtered = filtered.filter(r => r.fromUser.username.toLowerCase().includes(search));
    }

    if (filtered.length === 0) {
      list.innerHTML = '<p style="padding:12px;color:var(--text-muted);font-size:13px">No pending requests</p>';
      return;
    }

    list.innerHTML = filtered.map(r => {
      const initial = (r.fromUser.username || '?')[0].toUpperCase();
      return `
        <div class="friend-item">
          <div class="friend-avatar">
            ${r.fromUser.avatar ? '<img src="' + escapeHtml(r.fromUser.avatar) + '" alt="">' : initial}
          </div>
          <div class="friend-info">
            <div class="name">${escapeHtml(r.fromUser.username)}</div>
            <div class="status">Incoming request</div>
          </div>
          <div class="friend-actions">
            <button class="btn-accept" onclick="Friends.acceptRequest('${r.id}', '${r.from}')">✓</button>
            <button class="btn-reject" onclick="Friends.rejectRequest('${r.id}')">✕</button>
          </div>
        </div>
      `;
    }).join('');
  }

  async function sendFriendRequest() {
    const input = document.getElementById('add-friend-input');
    const username = input.value.trim();
    if (!username) return;

    if (username.toLowerCase() === currentProfile.username.toLowerCase()) {
      showToast("You can't add yourself.", 'error');
      return;
    }

    try {
      // Find user by username
      const snap = await db.collection('users')
        .where('usernameLower', '==', username.toLowerCase())
        .get();

      if (snap.empty) {
        showToast('User not found.', 'error');
        return;
      }

      const targetId = snap.docs[0].id;

      // Check if already friends
      if (currentProfile.friends && currentProfile.friends.includes(targetId)) {
        showToast('Already friends!', 'info');
        return;
      }

      // Check if request already exists
      const existing = await db.collection('friendRequests')
        .where('from', '==', currentUser.uid)
        .where('to', '==', targetId)
        .where('status', '==', 'pending')
        .get();

      if (!existing.empty) {
        showToast('Request already sent.', 'info');
        return;
      }

      await db.collection('friendRequests').add({
        from: currentUser.uid,
        to: targetId,
        status: 'pending',
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      input.value = '';
      showToast('Friend request sent!', 'success');
    } catch (err) {
      showToast('Failed to send request.', 'error');
    }
  }

  async function acceptRequest(requestId, fromId) {
    try {
      // Add each other as friends
      const batch = db.batch();
      batch.update(db.collection('users').doc(currentUser.uid), {
        friends: firebase.firestore.FieldValue.arrayUnion(fromId)
      });
      batch.update(db.collection('users').doc(fromId), {
        friends: firebase.firestore.FieldValue.arrayUnion(currentUser.uid)
      });
      batch.update(db.collection('friendRequests').doc(requestId), {
        status: 'accepted'
      });
      await batch.commit();
      showToast('Friend added!', 'success');
    } catch (err) {
      showToast('Failed to accept.', 'error');
    }
  }

  async function rejectRequest(requestId) {
    try {
      await db.collection('friendRequests').doc(requestId).update({ status: 'rejected' });
      showToast('Request rejected.', 'info');
    } catch (err) {
      showToast('Failed to reject.', 'error');
    }
  }

  async function startDM(friendId) {
    // Check if a conversation already exists
    const ids = [currentUser.uid, friendId].sort();
    const snap = await db.collection('conversations')
      .where('participantKey', '==', ids.join('_'))
      .get();

    if (!snap.empty) {
      // Open messenger with this convo
      window.location.href = 'messenger.html';
      return;
    }

    // Create new conversation
    try {
      await db.collection('conversations').add({
        participants: ids,
        participantKey: ids.join('_'),
        lastMessage: firebase.firestore.FieldValue.serverTimestamp()
      });
      window.location.href = 'messenger.html';
    } catch (err) {
      showToast('Failed to start DM.', 'error');
    }
  }

  return { init, acceptRequest, rejectRequest, startDM };
})();
