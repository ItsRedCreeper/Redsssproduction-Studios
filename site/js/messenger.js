/* ───────────────────────────────────────────────
   Messenger — RedsssProduction Studios v2
   Servers, Channels, DMs, real-time chat
   ─────────────────────────────────────────────── */

let msgUser = null;
let msgProfile = null;
let currentView = 'dm'; // 'dm' or server id
let currentChannel = null; // channel id or DM conversation id
let messageListener = null;

/* ─── TOAST (guarded: app.js defines this on main page) ─── */

if (typeof showToast === 'undefined') {
  // eslint-disable-next-line no-inner-declarations
  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3500);
  }
}

if (typeof escapeHtml === 'undefined') {
  // eslint-disable-next-line no-inner-declarations
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str || ''));
    return div.innerHTML;
  }
}

/* ─── AUTH STATE ─── */

auth.onAuthStateChanged(async (user) => {
  if (user) {
    msgUser = user;
    const doc = await db.collection('users').doc(user.uid).get();
    if (doc.exists) {
      msgProfile = { id: doc.id, ...doc.data() };
    } else {
      // Profile not found — stay on page, auth.js handles access control
      return;
    }

    renderUserArea();
    loadServers();
    loadDMs();
    document.getElementById('messenger-app').style.display = 'flex';
  } else {
    // Not authenticated — app.js handles login gating
    return;
  }

  const loading = document.getElementById('loading-screen');
  if (loading) loading.style.display = 'none';
});

/* ─── USER AREA ─── */

function renderUserArea() {
  const avatar = document.getElementById('msg-user-avatar');
  const name = document.getElementById('msg-user-name');
  const initial = (msgProfile.username || '?')[0].toUpperCase();

  if (msgProfile.avatar) {
    avatar.innerHTML = '<img src="' + escapeHtml(msgProfile.avatar) + '" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover">';
  } else {
    avatar.textContent = initial;
  }
  name.textContent = msgProfile.username;
}

/* ─── SERVERS ─── */

let serversCache = [];

async function loadServers() {
  // Listen for servers the user is a member of
  db.collection('servers')
    .where('members', 'array-contains', msgUser.uid)
    .orderBy('name')
    .onSnapshot(snap => {
      serversCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderServerIcons();
    });
}

function renderServerIcons() {
  const container = document.getElementById('server-icons');
  container.innerHTML = serversCache.map(s => `
    <div class="server-icon ${currentView === s.id ? 'active' : ''}"
         onclick="switchToServer('${s.id}')"
         title="${escapeHtml(s.name)}">
      ${escapeHtml((s.name || '?')[0].toUpperCase())}
    </div>
  `).join('');
}

document.getElementById('dm-tab').addEventListener('click', () => {
  currentView = 'dm';
  currentChannel = null;
  document.getElementById('sidebar-title').textContent = 'Direct Messages';
  document.getElementById('server-settings-btn').style.display = 'none';
  document.getElementById('members-sidebar').style.display = 'none';
  loadDMs();
  clearChat();
  renderServerIcons();
  document.getElementById('dm-tab').classList.add('active');
});

function switchToServer(serverId) {
  currentView = serverId;
  currentChannel = null;
  document.getElementById('dm-tab').classList.remove('active');
  renderServerIcons();

  const server = serversCache.find(s => s.id === serverId);
  document.getElementById('sidebar-title').textContent = server ? server.name : 'Server';
  document.getElementById('server-settings-btn').style.display =
    (server && server.owner === msgUser.uid) ? '' : 'none';
  document.getElementById('members-sidebar').style.display = '';

  loadChannels(serverId);
  loadMembers(serverId);
  clearChat();
}

/* ─── CREATE SERVER ─── */

document.getElementById('create-server-btn').addEventListener('click', () => {
  document.getElementById('create-server-modal').classList.add('active');
  document.getElementById('server-name-input').value = '';
  document.getElementById('server-name-input').focus();
});

document.getElementById('confirm-create-server').addEventListener('click', async () => {
  const name = document.getElementById('server-name-input').value.trim();
  if (!name) { showToast('Server name is required.', 'error'); return; }

  try {
    const ref = await db.collection('servers').add({
      name: name,
      owner: msgUser.uid,
      members: [msgUser.uid],
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    // Create a default #general channel
    await db.collection('servers').doc(ref.id).collection('channels').add({
      name: 'general',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    document.getElementById('create-server-modal').classList.remove('active');
    showToast('Server created!', 'success');
    switchToServer(ref.id);
  } catch (err) {
    showToast('Failed to create server.', 'error');
  }
});

/* ─── CHANNELS ─── */

async function loadChannels(serverId) {
  db.collection('servers').doc(serverId).collection('channels')
    .orderBy('name')
    .onSnapshot(snap => {
      const channels = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const list = document.getElementById('channel-list');
      list.innerHTML = channels.map(c => `
        <div class="channel-item ${currentChannel === c.id ? 'active' : ''}"
             onclick="openChannel('${serverId}', '${c.id}', '${escapeHtml(c.name)}')">
          <span class="hash">#</span> ${escapeHtml(c.name)}
        </div>
      `).join('');
    });
}

function openChannel(serverId, channelId, channelName) {
  currentChannel = channelId;
  document.getElementById('chat-header').style.display = 'flex';
  document.getElementById('chat-channel-name').textContent = channelName;
  document.getElementById('chat-input-area').style.display = 'flex';
  document.getElementById('chat-input').placeholder = 'Message #' + channelName;

  // Update active state
  document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
  event.currentTarget.classList.add('active');

  listenMessages('servers/' + serverId + '/channels/' + channelId + '/messages');
}

/* ─── DMs ─── */

async function loadDMs() {
  const list = document.getElementById('channel-list');

  db.collection('conversations')
    .where('participants', 'array-contains', msgUser.uid)
    .orderBy('lastMessage', 'desc')
    .onSnapshot(async snap => {
      if (currentView !== 'dm') return;

      const convos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      let html = '';

      for (const c of convos) {
        const otherId = c.participants.find(p => p !== msgUser.uid);
        if (!otherId) continue;

        let otherUser;
        try {
          const userDoc = await db.collection('users').doc(otherId).get();
          otherUser = userDoc.exists ? userDoc.data() : { username: 'Deleted User', avatar: '' };
        } catch {
          otherUser = { username: 'Unknown', avatar: '' };
        }

        const initial = (otherUser.username || '?')[0].toUpperCase();
        html += `
          <div class="dm-item ${currentChannel === c.id ? 'active' : ''}"
               onclick="openDM('${c.id}', '${escapeHtml(otherUser.username)}')">
            <div class="friend-avatar">
              ${otherUser.avatar ? '<img src="' + escapeHtml(otherUser.avatar) + '" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover">' : initial}
            </div>
            <span class="name">${escapeHtml(otherUser.username)}</span>
          </div>
        `;
      }

      list.innerHTML = html || '<p style="padding:12px;color:var(--text-muted);font-size:13px">No conversations yet</p>';
    });
}

function openDM(convoId, name) {
  currentChannel = convoId;
  document.getElementById('chat-header').style.display = 'flex';
  document.querySelector('.chat-header .hash').textContent = '@';
  document.getElementById('chat-channel-name').textContent = name;
  document.getElementById('chat-input-area').style.display = 'flex';
  document.getElementById('chat-input').placeholder = 'Message @' + name;
  document.getElementById('members-sidebar').style.display = 'none';

  listenMessages('conversations/' + convoId + '/messages');
}

/* ─── MEMBERS ─── */

async function loadMembers(serverId) {
  const server = serversCache.find(s => s.id === serverId);
  if (!server) return;

  const list = document.getElementById('members-list');
  let html = '';

  for (const uid of server.members) {
    try {
      const doc = await db.collection('users').doc(uid).get();
      if (!doc.exists) continue;
      const u = doc.data();
      const initial = (u.username || '?')[0].toUpperCase();
      html += `
        <div class="member-item">
          <div class="friend-avatar" style="position:relative">
            ${u.avatar ? '<img src="' + escapeHtml(u.avatar) + '" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover">' : initial}
            <div class="status-dot ${u.online ? 'online' : 'offline'}"></div>
          </div>
          <span class="name">${escapeHtml(u.username)}</span>
        </div>
      `;
    } catch { /* skip */ }
  }

  list.innerHTML = html;
}

/* ─── MESSAGES ─── */

function listenMessages(path) {
  if (messageListener) messageListener();

  const container = document.getElementById('chat-messages');
  container.innerHTML = '';

  messageListener = db.collection(path)
    .orderBy('timestamp')
    .limitToLast(100)
    .onSnapshot(snap => {
      container.innerHTML = '';
      snap.docs.forEach(doc => {
        const m = doc.data();
        const msgEl = createMessageEl(doc.id, m, path);
        container.appendChild(msgEl);
      });
      container.scrollTop = container.scrollHeight;
    });
}

function createMessageEl(id, m, path) {
  const div = document.createElement('div');
  div.className = 'message';

  const initial = (m.authorName || '?')[0].toUpperCase();
  const time = m.timestamp ? new Date(m.timestamp.toDate()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const isOwn = m.authorId === msgUser.uid;

  let contentHtml = escapeHtml(m.text || '');
  if (m.imageUrl) {
    contentHtml += '<img src="' + escapeHtml(m.imageUrl) + '" alt="image">';
  }

  div.innerHTML = `
    <div class="msg-avatar">
      ${m.authorAvatar ? '<img src="' + escapeHtml(m.authorAvatar) + '" alt="">' : initial}
    </div>
    <div class="msg-content">
      <div class="msg-header">
        <span class="msg-author">${escapeHtml(m.authorName)}</span>
        <span class="msg-time">${time}</span>
      </div>
      <div class="msg-text">${contentHtml}</div>
      ${isOwn ? `<div class="msg-actions">
        <button onclick="deleteMessage('${path}', '${id}')">Delete</button>
      </div>` : ''}
    </div>
  `;

  return div;
}

/* ─── SEND MESSAGE ─── */

document.getElementById('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

async function sendMessage() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || !currentChannel) return;

  let path;
  if (currentView === 'dm') {
    path = 'conversations/' + currentChannel + '/messages';
  } else {
    path = 'servers/' + currentView + '/channels/' + currentChannel + '/messages';
  }

  input.value = '';

  try {
    await db.collection(path).add({
      text: text,
      authorId: msgUser.uid,
      authorName: msgProfile.username,
      authorAvatar: msgProfile.avatar || '',
      timestamp: firebase.firestore.FieldValue.serverTimestamp()
    });

    // Update last message time for DMs
    if (currentView === 'dm') {
      db.collection('conversations').doc(currentChannel).update({
        lastMessage: firebase.firestore.FieldValue.serverTimestamp()
      }).catch(() => {});
    }
  } catch (err) {
    showToast('Failed to send message.', 'error');
  }
}

/* ─── IMAGE UPLOAD ─── */

document.getElementById('attach-btn').addEventListener('click', () => {
  document.getElementById('chat-file-input').click();
});

document.getElementById('chat-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { showToast('Image must be under 10MB.', 'error'); return; }
  if (!currentChannel) return;

  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', CLOUDINARY_PRESET);

  try {
    showToast('Uploading image...', 'info');
    const res = await fetch('https://api.cloudinary.com/v1_1/' + CLOUDINARY_CLOUD + '/image/upload', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();

    if (data.secure_url) {
      let path;
      if (currentView === 'dm') {
        path = 'conversations/' + currentChannel + '/messages';
      } else {
        path = 'servers/' + currentView + '/channels/' + currentChannel + '/messages';
      }

      await db.collection(path).add({
        text: '',
        imageUrl: data.secure_url,
        authorId: msgUser.uid,
        authorName: msgProfile.username,
        authorAvatar: msgProfile.avatar || '',
        timestamp: firebase.firestore.FieldValue.serverTimestamp()
      });
    }
  } catch (err) {
    showToast('Upload failed.', 'error');
  }

  e.target.value = '';
});

/* ─── DELETE MESSAGE ─── */

async function deleteMessage(path, msgId) {
  try {
    await db.collection(path).doc(msgId).delete();
  } catch (err) {
    showToast('Failed to delete message.', 'error');
  }
}

/* ─── CLEAR CHAT ─── */

function clearChat() {
  if (messageListener) { messageListener(); messageListener = null; }
  document.getElementById('chat-messages').innerHTML = '<div class="chat-empty">Select a conversation to start chatting</div>';
  document.getElementById('chat-header').style.display = 'none';
  document.getElementById('chat-input-area').style.display = 'none';
}

/* ─── SERVER SETTINGS ─── */

document.getElementById('server-settings-btn').addEventListener('click', () => {
  if (currentView === 'dm') return;
  const server = serversCache.find(s => s.id === currentView);
  if (!server || server.owner !== msgUser.uid) return;

  const action = prompt('Server: ' + server.name + '\n\nType one of:\n- invite USERNAME\n- kick USERNAME\n- delete\n- channel CHANNELNAME');
  if (!action) return;

  const parts = action.split(' ');
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(' ').trim();

  if (cmd === 'invite' && arg) inviteToServer(arg);
  else if (cmd === 'kick' && arg) kickFromServer(arg);
  else if (cmd === 'delete') deleteServer();
  else if (cmd === 'channel' && arg) createChannel(arg);
  else showToast('Unknown command.', 'error');
});

async function inviteToServer(username) {
  try {
    const snap = await db.collection('users').where('usernameLower', '==', username.toLowerCase()).get();
    if (snap.empty) { showToast('User not found.', 'error'); return; }
    const userId = snap.docs[0].id;

    await db.collection('servers').doc(currentView).update({
      members: firebase.firestore.FieldValue.arrayUnion(userId)
    });
    showToast(username + ' invited!', 'success');
    loadMembers(currentView);
  } catch (err) {
    showToast('Failed to invite.', 'error');
  }
}

async function kickFromServer(username) {
  try {
    const snap = await db.collection('users').where('usernameLower', '==', username.toLowerCase()).get();
    if (snap.empty) { showToast('User not found.', 'error'); return; }
    const userId = snap.docs[0].id;

    if (userId === msgUser.uid) { showToast("You can't kick yourself.", 'error'); return; }

    await db.collection('servers').doc(currentView).update({
      members: firebase.firestore.FieldValue.arrayRemove(userId)
    });
    showToast(username + ' kicked.', 'success');
    loadMembers(currentView);
  } catch (err) {
    showToast('Failed to kick.', 'error');
  }
}

async function deleteServer() {
  if (!confirm('Delete this server permanently?')) return;
  try {
    await db.collection('servers').doc(currentView).delete();
    showToast('Server deleted.', 'success');
    currentView = 'dm';
    currentChannel = null;
    document.getElementById('dm-tab').click();
  } catch (err) {
    showToast('Failed to delete server.', 'error');
  }
}

async function createChannel(name) {
  try {
    await db.collection('servers').doc(currentView).collection('channels').add({
      name: name.toLowerCase().replace(/\s+/g, '-'),
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    showToast('Channel #' + name + ' created!', 'success');
  } catch (err) {
    showToast('Failed to create channel.', 'error');
  }
}
