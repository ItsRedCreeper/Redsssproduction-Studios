(() => {
  const STREAM_STATE_KEY = 'rps_stream_state_v1';

  const titleEl = document.getElementById('stream-chat-popup-title');
  const subtitleEl = document.getElementById('stream-chat-popup-subtitle');
  const messagesEl = document.getElementById('stream-chat-popup-messages');
  const inputEl = document.getElementById('stream-chat-popup-input');
  const sendBtn = document.getElementById('stream-chat-popup-send');
  const refreshBtn = document.getElementById('stream-chat-popup-refresh');

  let currentUser = null;
  let streamCtx = null;
  let unsub = null;
  const profileCache = new Map();

  auth.onAuthStateChanged(user => {
    if (!user) {
      window.location.replace('index.html');
      return;
    }
    currentUser = user;
    _init();
  });

  function _init() {
    _resolveStreamContext();
    _renderHeader();
    _bind();
    _listen();
  }

  function _bind() {
    sendBtn.addEventListener('click', _send);
    inputEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        _send();
      }
    });
    refreshBtn.addEventListener('click', () => {
      _resolveStreamContext();
      _renderHeader();
      _listen();
    });
  }

  function _resolveStreamContext() {
    const qs = new URLSearchParams(window.location.search);
    const serverId = qs.get('serverId') || '';
    const channelId = qs.get('channelId') || '';
    const channelName = qs.get('channelName') || '';

    if (serverId && channelId) {
      streamCtx = { serverId, channelId, channelName: channelName || 'Streaming Channel' };
      return;
    }

    try {
      const raw = localStorage.getItem(STREAM_STATE_KEY);
      const state = raw ? JSON.parse(raw) : null;
      if (state && state.live && state.serverId && state.channelId) {
        streamCtx = {
          serverId: state.serverId,
          channelId: state.channelId,
          channelName: state.channelName || 'Streaming Channel'
        };
      } else {
        streamCtx = null;
      }
    } catch (_) {
      streamCtx = null;
    }
  }

  function _renderHeader() {
    if (!streamCtx) {
      titleEl.textContent = 'Stream Chat';
      subtitleEl.textContent = 'No active stream channel found.';
      messagesEl.innerHTML = '<div class="chat-empty">No active stream chat. Start streaming first.</div>';
      return;
    }
    titleEl.textContent = 'Stream Chat';
    subtitleEl.textContent = streamCtx.channelName || 'Streaming Channel';
  }

  function _listen() {
    if (unsub) {
      unsub();
      unsub = null;
    }
    if (!streamCtx) return;

    messagesEl.innerHTML = '<div class="chat-empty">Loading stream chat...</div>';
    unsub = db.collection('servers').doc(streamCtx.serverId)
      .collection('channels').doc(streamCtx.channelId)
      .collection('messages')
      .orderBy('createdAt', 'asc')
      .limitToLast(100)
      .onSnapshot(snap => {
        messagesEl.innerHTML = '';
        if (snap.empty) {
          messagesEl.innerHTML = '<div class="chat-empty">No messages yet. Start the conversation!</div>';
          return;
        }

        snap.forEach(doc => {
          const data = doc.data() || {};
          if (data.uid) _ensureProfileCached(data.uid);
          messagesEl.appendChild(_renderMessage(data));
        });
        messagesEl.scrollTop = messagesEl.scrollHeight;
      });
  }

  async function _ensureProfileCached(uid) {
    if (!uid || profileCache.has(uid)) return;
    try {
      const doc = await db.collection('users').doc(uid).get();
      if (!doc.exists) return;
      const d = doc.data() || {};
      profileCache.set(uid, {
        username: d.username || 'User',
        avatar: d.avatar || '',
        effectiveStatus: d.effectiveStatus || 'offline'
      });
      _patchRendered(uid);
    } catch (_) {}
  }

  function _renderMessage(data) {
    const row = document.createElement('div');
    row.className = 'stream-chat-msg';
    row.dataset.uid = data.uid || '';

    const prof = profileCache.get(data.uid) || {};
    const name = prof.username || data.username || 'User';
    const avatar = prof.avatar || data.avatar || '';
    const status = prof.effectiveStatus || 'offline';
    const initial = (name || 'U').charAt(0).toUpperCase();

    let time = '';
    if (data.createdAt && data.createdAt.toDate) {
      time = data.createdAt.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    const parts = [];
    if (data.text) parts.push('<div class="stream-chat-msg-text">' + _esc(data.text) + '</div>');
    if (data.images && data.images.length) {
      data.images.forEach(url => parts.push('<div class="stream-chat-msg-text"><a href="' + _esc(url) + '" target="_blank" rel="noopener">Image</a></div>'));
    }
    if (data.videoUrl) parts.push('<div class="stream-chat-msg-text"><a href="' + _esc(data.videoUrl) + '" target="_blank" rel="noopener">Video</a></div>');

    const avatarHtml = avatar ? '<img src="' + _esc(avatar) + '" alt="">' : _esc(initial);

    row.innerHTML =
      '<div class="stream-chat-msg-avatar">' + avatarHtml +
        '<span class="status-dot ' + _esc(status) + '"></span>' +
      '</div>' +
      '<div class="stream-chat-msg-main">' +
        '<div class="stream-chat-msg-head">' +
          '<span class="stream-chat-msg-author">' + _esc(name) + '</span><span>' + _esc(time) + '</span>' +
        '</div>' +
        parts.join('') +
      '</div>';

    return row;
  }

  function _patchRendered(uid) {
    const cached = profileCache.get(uid);
    if (!cached) return;

    const initial = (cached.username || 'U').charAt(0).toUpperCase();
    const avatarHTML = cached.avatar
      ? '<img src="' + _esc(cached.avatar) + '" alt="">'
      : _esc(initial);

    document.querySelectorAll('.stream-chat-msg[data-uid="' + uid + '"]').forEach(div => {
      const av = div.querySelector('.stream-chat-msg-avatar');
      if (av) av.innerHTML = avatarHTML + '<span class="status-dot ' + (cached.effectiveStatus || 'offline') + '"></span>';
      const author = div.querySelector('.stream-chat-msg-author');
      if (author) author.textContent = cached.username || 'Unknown';
    });
  }

  async function _send() {
    if (!streamCtx || !currentUser) return;
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';

    try {
      await db.collection('servers').doc(streamCtx.serverId)
        .collection('channels').doc(streamCtx.channelId)
        .collection('messages')
        .add({
          uid: currentUser.uid,
          text,
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    } catch (_) {
      inputEl.value = text;
    }
  }

  function _esc(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }
})();
