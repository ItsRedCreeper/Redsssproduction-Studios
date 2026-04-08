/* ───────────────────────────────────────────────
   RedsssMessenger — Main JS
   Initialized by app.js after auth resolves.
   DMs, servers, channels, real-time chat.
   ─────────────────────────────────────────────── */

const Messenger = (() => {
  let currentUser = null;
  let userProfile = null;
  let chatUnsub = null;
  let currentChat = null;   // { type: 'dm', friendUid } | { type: 'channel', serverId, channelId }
  let currentServerId = null;

  /* ── Init — called by app.js after login ── */
  function init(user, profile) {
    currentUser = user;
    userProfile = profile;

    // DM button
    document.getElementById('dm-btn').addEventListener('click', showDMView);

    // Sidebar tabs
    document.querySelectorAll('.sidebar-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.sidebar-tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
      });
    });

    // Send message
    document.getElementById('chat-send').addEventListener('click', sendMessage);
    document.getElementById('chat-input').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });

    // Add friend
    document.getElementById('add-friend-btn').addEventListener('click', sendFriendRequest);
    document.getElementById('add-friend-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') sendFriendRequest();
    });

    // Create server
    document.getElementById('create-server-btn').addEventListener('click', () => {
      document.getElementById('create-server-modal').classList.add('open');
    });
    document.getElementById('cancel-server-btn').addEventListener('click', () => {
      document.getElementById('create-server-modal').classList.remove('open');
    });
    document.getElementById('confirm-server-btn').addEventListener('click', createServer);

    // Create channel
    document.getElementById('create-channel-btn').addEventListener('click', () => {
      document.getElementById('create-channel-modal').classList.add('open');
    });
    document.getElementById('cancel-channel-btn').addEventListener('click', () => {
      document.getElementById('create-channel-modal').classList.remove('open');
    });
    document.getElementById('confirm-channel-btn').addEventListener('click', createChannel);

    // Friend search filter
    document.getElementById('friend-search').addEventListener('input', filterFriends);

    // Initialize
    renderUserBar();
    loadFriends();
    loadServers();
    loadPendingRequests();
    showDMView();
  }

  /* ── Profile ── */
  function renderUserBar() {
    const av = document.getElementById('msg-avatar');
    if (userProfile.avatar) {
      av.innerHTML = '<img src="' + esc(userProfile.avatar) + '" alt="">';
    } else {
      av.textContent = (userProfile.username || 'U').charAt(0).toUpperCase();
    }
    document.getElementById('msg-username').textContent = userProfile.username || 'User';
    document.getElementById('msg-status').textContent = userProfile.status || 'Online';
  }

  /* ── DM View ── */
  function showDMView() {
    currentServerId = null;
    document.querySelectorAll('.server-icon').forEach(s => s.classList.remove('active'));
    document.getElementById('dm-btn').classList.add('active');

    document.getElementById('sidebar-header').textContent = 'Direct Messages';
    document.getElementById('dm-section').style.display = 'flex';
    document.getElementById('channel-section').style.display = 'none';
    document.getElementById('members-sidebar').style.display = 'none';
  }

  /* ── Friends ── */
  function loadFriends() {
    db.collection('users').doc(currentUser.uid).onSnapshot(doc => {
      if (!doc.exists) return;
      const friends = doc.data().friends || [];
      renderFriendsList(friends);
    });
  }

  async function renderFriendsList(friendUids) {
    const list = document.getElementById('friends-list');

    if (!friendUids.length) {
      list.innerHTML = '<div class="sidebar-empty">No friends yet</div>';
      return;
    }

    // Fetch friend profiles (batch up to 10 at a time for Firestore `in` query)
    const profiles = [];
    for (let i = 0; i < friendUids.length; i += 10) {
      const batch = friendUids.slice(i, i + 10);
      const snap = await db.collection('users')
        .where(firebase.firestore.FieldPath.documentId(), 'in', batch)
        .get();
      snap.forEach(d => profiles.push({ uid: d.id, ...d.data() }));
    }

    list.innerHTML = profiles.map(f => {
      const initial = (f.username || 'U').charAt(0).toUpperCase();
      const avatarHtml = f.avatar
        ? '<img src="' + esc(f.avatar) + '" alt="">'
        : initial;
      const onlineDot = f.online ? '<span class="online-dot"></span>' : '';

      return '<div class="friend-item" data-uid="' + f.uid + '">' +
        '<div class="friend-avatar">' + avatarHtml + onlineDot + '</div>' +
        '<div>' +
          '<div class="friend-name">' + esc(f.username) + '</div>' +
          '<div class="friend-status">' + esc(f.status || (f.online ? 'Online' : 'Offline')) + '</div>' +
        '</div></div>';
    }).join('');

    list.querySelectorAll('.friend-item').forEach(el => {
      el.addEventListener('click', () => openDM(el.dataset.uid, profiles.find(p => p.uid === el.dataset.uid)));
    });
  }

  function filterFriends() {
    const q = document.getElementById('friend-search').value.toLowerCase();
    document.querySelectorAll('#friends-list .friend-item').forEach(el => {
      const name = el.querySelector('.friend-name').textContent.toLowerCase();
      el.style.display = name.includes(q) ? '' : 'none';
    });
  }

  /* ── Friend Requests ── */
  async function sendFriendRequest() {
    const input = document.getElementById('add-friend-input');
    const username = input.value.trim();
    if (!username) return;

    try {
      const snap = await db.collection('users')
        .where('usernameLower', '==', username.toLowerCase())
        .limit(1)
        .get();

      if (snap.empty) {
        showToast('User not found.', 'error');
        return;
      }

      const targetDoc = snap.docs[0];
      if (targetDoc.id === currentUser.uid) {
        showToast("You can't add yourself.", 'error');
        return;
      }

      // Check if already friends
      const myDoc = await db.collection('users').doc(currentUser.uid).get();
      const myFriends = myDoc.data().friends || [];
      if (myFriends.includes(targetDoc.id)) {
        showToast('Already friends!', 'info');
        return;
      }

      // Check if request already exists
      const existing = await db.collection('friend_requests')
        .where('from', '==', currentUser.uid)
        .where('to', '==', targetDoc.id)
        .limit(1)
        .get();

      if (!existing.empty) {
        showToast('Request already sent.', 'info');
        return;
      }

      await db.collection('friend_requests').add({
        from: currentUser.uid,
        fromUsername: userProfile.username,
        to: targetDoc.id,
        toUsername: targetDoc.data().username,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        status: 'pending'
      });

      // Notify target
      await db.collection('users').doc(targetDoc.id).collection('notifications').add({
        message: userProfile.username + ' sent you a friend request!',
        type: 'friend_request',
        fromUid: currentUser.uid,
        read: false,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      input.value = '';
      showToast('Friend request sent!', 'success');
    } catch (err) {
      console.error(err);
      showToast('Failed to send request.', 'error');
    }
  }

  function loadPendingRequests() {
    db.collection('friend_requests')
      .where('to', '==', currentUser.uid)
      .where('status', '==', 'pending')
      .onSnapshot(snap => {
        const container = document.getElementById('pending-requests');
        if (snap.empty) {
          container.innerHTML = '<div class="sidebar-empty">No pending requests</div>';
          return;
        }

        container.innerHTML = '';
        snap.forEach(doc => {
          const req = doc.data();
          const div = document.createElement('div');
          div.className = 'pending-item';
          div.innerHTML =
            '<span>' + esc(req.fromUsername) + '</span>' +
            '<div class="pending-actions">' +
              '<button class="pending-accept" data-id="' + doc.id + '" data-uid="' + req.from + '">Accept</button>' +
              '<button class="pending-deny" data-id="' + doc.id + '">Deny</button>' +
            '</div>';
          container.appendChild(div);
        });

        container.querySelectorAll('.pending-accept').forEach(btn => {
          btn.addEventListener('click', () => acceptFriend(btn.dataset.id, btn.dataset.uid));
        });
        container.querySelectorAll('.pending-deny').forEach(btn => {
          btn.addEventListener('click', () => denyFriend(btn.dataset.id));
        });
      });
  }

  async function acceptFriend(requestId, fromUid) {
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

  async function denyFriend(requestId) {
    try {
      await db.collection('friend_requests').doc(requestId).update({ status: 'denied' });
      showToast('Request denied.', 'info');
    } catch { showToast('Failed.', 'error'); }
  }

  /* ── DM Chat ── */
  function openDM(friendUid, profile) {
    if (chatUnsub) { chatUnsub(); chatUnsub = null; }

    currentChat = { type: 'dm', friendUid };

    document.querySelectorAll('.friend-item').forEach(f => f.classList.remove('active'));
    const el = document.querySelector('.friend-item[data-uid="' + friendUid + '"]');
    if (el) el.classList.add('active');

    document.getElementById('chat-title').textContent = profile ? profile.username : 'Chat';
    document.getElementById('chat-input-bar').style.display = 'flex';
    document.getElementById('members-sidebar').style.display = 'none';

    // DM conversation ID (sorted UIDs)
    const convoId = [currentUser.uid, friendUid].sort().join('_');

    const messagesEl = document.getElementById('chat-messages');
    messagesEl.innerHTML = '<div class="chat-empty">Loading...</div>';

    chatUnsub = db.collection('dms').doc(convoId).collection('messages')
      .orderBy('createdAt', 'asc')
      .limitToLast(100)
      .onSnapshot(snap => {
        if (snap.empty) {
          messagesEl.innerHTML = '<div class="chat-empty">No messages yet. Say hi!</div>';
          return;
        }

        messagesEl.innerHTML = '';
        snap.forEach(doc => {
          messagesEl.appendChild(renderMessage(doc.data()));
        });
        messagesEl.scrollTop = messagesEl.scrollHeight;
      });
  }

  /* ── Servers ── */
  function loadServers() {
    db.collection('servers')
      .where('members', 'array-contains', currentUser.uid)
      .onSnapshot(snap => {
        const list = document.getElementById('server-list');
        list.innerHTML = '';
        snap.forEach(doc => {
          const s = doc.data();
          const icon = document.createElement('div');
          icon.className = 'server-icon';
          icon.title = s.name;
          icon.textContent = (s.name || 'S').charAt(0).toUpperCase();
          icon.dataset.id = doc.id;
          icon.addEventListener('click', () => openServer(doc.id, s));
          list.appendChild(icon);
        });
      });
  }

  async function createServer() {
    const name = document.getElementById('server-name-input').value.trim();
    if (!name) return;

    try {
      const ref = await db.collection('servers').add({
        name,
        owner: currentUser.uid,
        members: [currentUser.uid],
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      // Create default #general channel
      await db.collection('servers').doc(ref.id).collection('channels').add({
        name: 'general',
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      document.getElementById('server-name-input').value = '';
      document.getElementById('create-server-modal').classList.remove('open');
      showToast('Server created!', 'success');
    } catch {
      showToast('Failed to create server.', 'error');
    }
  }

  function openServer(serverId, serverData) {
    currentServerId = serverId;

    document.querySelectorAll('.server-icon').forEach(s => s.classList.remove('active'));
    const icon = document.querySelector('.server-icon[data-id="' + serverId + '"]');
    if (icon) icon.classList.add('active');

    document.getElementById('sidebar-header').textContent = serverData.name;
    document.getElementById('dm-section').style.display = 'none';
    document.getElementById('channel-section').style.display = 'flex';
    document.getElementById('members-sidebar').style.display = '';

    loadChannels(serverId);
    loadMembers(serverId, serverData.members);
  }

  function loadChannels(serverId) {
    db.collection('servers').doc(serverId).collection('channels')
      .orderBy('name')
      .onSnapshot(snap => {
        const list = document.getElementById('channel-list');
        list.innerHTML = '';
        snap.forEach(doc => {
          const ch = doc.data();
          const el = document.createElement('div');
          el.className = 'channel-item';
          el.dataset.id = doc.id;
          el.innerHTML = '<span class="channel-hash">#</span> ' + esc(ch.name);
          el.addEventListener('click', () => openChannel(serverId, doc.id, ch.name));
          list.appendChild(el);
        });

        // Auto-open first channel
        if (!snap.empty && !currentChat) {
          const first = snap.docs[0];
          openChannel(serverId, first.id, first.data().name);
        }
      });
  }

  async function createChannel() {
    if (!currentServerId) return;
    const name = document.getElementById('channel-name-input').value.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (!name) return;

    try {
      await db.collection('servers').doc(currentServerId).collection('channels').add({
        name,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      document.getElementById('channel-name-input').value = '';
      document.getElementById('create-channel-modal').classList.remove('open');
      showToast('Channel created!', 'success');
    } catch {
      showToast('Failed to create channel.', 'error');
    }
  }

  async function loadMembers(serverId, memberUids) {
    const list = document.getElementById('members-list');
    list.innerHTML = '';

    const profiles = [];
    for (let i = 0; i < memberUids.length; i += 10) {
      const batch = memberUids.slice(i, i + 10);
      const snap = await db.collection('users')
        .where(firebase.firestore.FieldPath.documentId(), 'in', batch)
        .get();
      snap.forEach(d => profiles.push({ uid: d.id, ...d.data() }));
    }

    profiles.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));

    list.innerHTML = profiles.map(m => {
      const initial = (m.username || 'U').charAt(0).toUpperCase();
      const avatarHtml = m.avatar ? '<img src="' + esc(m.avatar) + '" alt="">' : initial;
      return '<div class="member-item' + (m.online ? ' online' : '') + '">' +
        '<div class="member-avatar">' + avatarHtml + '</div>' +
        '<span class="member-name">' + esc(m.username) + '</span></div>';
    }).join('');
  }

  /* ── Channel Chat ── */
  function openChannel(serverId, channelId, channelName) {
    if (chatUnsub) { chatUnsub(); chatUnsub = null; }

    currentChat = { type: 'channel', serverId, channelId };

    document.querySelectorAll('.channel-item').forEach(c => c.classList.remove('active'));
    const el = document.querySelector('.channel-item[data-id="' + channelId + '"]');
    if (el) el.classList.add('active');

    document.getElementById('chat-title').textContent = '# ' + channelName;
    document.getElementById('chat-input-bar').style.display = 'flex';

    const messagesEl = document.getElementById('chat-messages');
    messagesEl.innerHTML = '<div class="chat-empty">Loading...</div>';

    chatUnsub = db.collection('servers').doc(serverId)
      .collection('channels').doc(channelId)
      .collection('messages')
      .orderBy('createdAt', 'asc')
      .limitToLast(100)
      .onSnapshot(snap => {
        if (snap.empty) {
          messagesEl.innerHTML = '<div class="chat-empty">No messages yet. Start the conversation!</div>';
          return;
        }

        messagesEl.innerHTML = '';
        snap.forEach(doc => {
          messagesEl.appendChild(renderMessage(doc.data()));
        });
        messagesEl.scrollTop = messagesEl.scrollHeight;
      });
  }

  /* ── Send Message ── */
  async function sendMessage() {
    if (!currentChat) return;
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;

    input.value = '';

    const msgData = {
      text,
      uid: currentUser.uid,
      username: userProfile.username,
      avatar: userProfile.avatar || '',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    try {
      if (currentChat.type === 'dm') {
        const convoId = [currentUser.uid, currentChat.friendUid].sort().join('_');
        await db.collection('dms').doc(convoId).collection('messages').add(msgData);

        // Notify friend
        await db.collection('users').doc(currentChat.friendUid).collection('notifications').add({
          message: userProfile.username + ': ' + (text.length > 60 ? text.slice(0, 60) + '...' : text),
          type: 'dm',
          fromUid: currentUser.uid,
          read: false,
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      } else if (currentChat.type === 'channel') {
        await db.collection('servers').doc(currentChat.serverId)
          .collection('channels').doc(currentChat.channelId)
          .collection('messages').add(msgData);
      }
    } catch (err) {
      console.error('Send failed:', err);
      showToast('Failed to send message.', 'error');
    }
  }

  /* ── Render a single message ── */
  function renderMessage(data) {
    const div = document.createElement('div');
    div.className = 'msg';

    const initial = (data.username || 'U').charAt(0).toUpperCase();
    const avatarContent = data.avatar
      ? '<img src="' + esc(data.avatar) + '" alt="">'
      : initial;

    const time = data.createdAt
      ? new Date(data.createdAt.toDate()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';

    div.innerHTML =
      '<div class="msg-avatar">' + avatarContent + '</div>' +
      '<div class="msg-body">' +
        '<div class="msg-header">' +
          '<span class="msg-author">' + esc(data.username || 'Unknown') + '</span>' +
          '<span class="msg-time">' + time + '</span>' +
        '</div>' +
        '<div class="msg-text">' + esc(data.text || '') + '</div>' +
      '</div>';
    return div;
  }

  /* ── Utility ── */
  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  return { init };
})();
