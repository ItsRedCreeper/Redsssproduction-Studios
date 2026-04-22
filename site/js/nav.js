/* ───────────────────────────────────────────────
   nav.js — Shared navbar for all protected pages
   Usage: Nav.init('pageId').then(({ user, profile }) => ...)
   Pages: games.html, messenger.html, support.html, friends.html
   ─────────────────────────────────────────────── */

// Write the heartbeat immediately when this script is parsed so the
// stream-core tab sees a live timestamp even during same-site navigation
// (before auth resolves and _startMainHeartbeat() runs).
try { localStorage.setItem('rps_main_heartbeat_v1', String(Date.now())); } catch (_) {}

const Nav = (() => {

  let _idleTimer = null;
  let _currentProfile = null;
  const IDLE_MS = 10 * 60 * 1000; // 10 minutes
  const STREAM_STATE_KEY = 'rps_stream_state_v1';
  const STREAM_CMD_KEY = 'rps_stream_cmd_v1';
  const MAIN_HEARTBEAT_KEY = 'rps_main_heartbeat_v1';
  let _mainHeartbeatTimer = null;
  let _streamStateTimer = null;
  let _streamControlChannel = null;
  let _navStreamChatUnsub = null;
  let _navStreamChatCurrentUser = null;
  const _navStreamProfileCache = new Map();
  let _navStreamReplyState = null;

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
        _currentProfile = profile;
        _renderUserUI(user, profile);
        _setActive(activePageId);
        _setupEvents(user, profile);
        _setupPresence(user, profile);
        _listenNotifications(user);
        _listenFriendRequests(user);
        _initStreamManager(user);

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

  function _initStreamManager(user) {
    _ensureStreamManagerUI();
    _navStreamChatCurrentUser = user;
    const isMessengerPage = document.body.classList.contains('messenger-page');

    // Main-site heartbeat — tells the stream-core tab that a real site page is
    // still open. If this stops writing, the core tab self-destructs.
    _startMainHeartbeat();

    const navBtn = document.getElementById('stream-manage-nav-btn');
    const panel = document.getElementById('stream-manage-panel');
    const closeBtn = document.getElementById('stream-manage-close');
    const chatBtn = document.getElementById('stream-manage-chat-btn');
    const stopBtn = document.getElementById('stream-manage-stop-btn');

    if (!isMessengerPage) {
      navBtn?.addEventListener('click', () => {
        if (panel.style.display === 'none' || !panel.style.display) panel.style.display = 'block';
        else panel.style.display = 'none';
      });
      closeBtn?.addEventListener('click', () => { panel.style.display = 'none'; });

      // Make panels draggable
      _makeDraggable(panel, panel.querySelector('.stream-manage-header'));

      chatBtn?.addEventListener('click', () => {
        const state = _readStreamState();
        if (!state || !state.live) {
          showToast('No active stream right now.', 'info');
          return;
        }
        _openNavStreamChat(state);
      });

      // Take Picture (snapshot of current remote stream)
      const snapBtn = document.getElementById('stream-manage-snap-btn');
      if (snapBtn) snapBtn.addEventListener('click', _navTakeSnapshot);

      // Pause / Resume stream
      const pauseBtn = document.getElementById('stream-manage-pause-btn');
      if (pauseBtn) pauseBtn.addEventListener('click', () => {
        const state = _readStreamState();
        const shared = _readSharedState();
        const action = (shared && shared.streamPaused) ? 'resumeStream' : 'pauseStream';
        if (state && state.live) _sendStreamCommand({ action, by: user.uid });
      });

      // Record toggle
      const recBtn = document.getElementById('stream-manage-record-btn');
      if (recBtn) recBtn.addEventListener('click', () => {
        const state = _readStreamState();
        if (state && state.live) _sendStreamCommand({ action: 'toggleRecord', by: user.uid });
      });

      // Pause / Resume recording
      const recPauseBtn = document.getElementById('stream-manage-record-pause-btn');
      if (recPauseBtn) recPauseBtn.addEventListener('click', () => {
        const shared = _readSharedState();
        const action = (shared && shared.recordStatus === 'paused') ? 'resumeRecord' : 'pauseRecord';
        const state = _readStreamState();
        if (state && state.live) _sendStreamCommand({ action, by: user.uid });
      });

      // Quality selects
      const resEl = document.getElementById('stream-manage-res');
      const fpsEl = document.getElementById('stream-manage-fps');
      if (resEl && fpsEl) {
        const QUALITY_KEY = 'rps_stream_quality_v1';
        const _loadQuality = () => {
          try {
            const q = JSON.parse(localStorage.getItem(QUALITY_KEY) || '{}');
            if (q.resolution) resEl.value = q.resolution;
            if (q.fps) fpsEl.value = String(q.fps);
          } catch (_) {}
        };
        const _saveQuality = () => {
          try {
            localStorage.setItem(QUALITY_KEY, JSON.stringify({ resolution: resEl.value, fps: Number(fpsEl.value) }));
          } catch (_) {}
        };
        _loadQuality();
        resEl.addEventListener('change', _saveQuality);
        fpsEl.addEventListener('change', _saveQuality);
      }

      const navChatClose = document.getElementById('nav-stream-chat-close');
      if (navChatClose) navChatClose.addEventListener('click', () => {
        const p = document.getElementById('nav-stream-chat-panel');
        if (p) p.style.display = 'none';
        if (_navStreamChatUnsub) { _navStreamChatUnsub(); _navStreamChatUnsub = null; }
        _navCancelReply();
      });
      const navChatPanel = document.getElementById('nav-stream-chat-panel');
      if (navChatPanel) _makeDraggable(navChatPanel, navChatPanel.querySelector('.stream-chat-header'));

      const navChatSend = document.getElementById('nav-stream-chat-send');
      const navChatInput = document.getElementById('nav-stream-chat-input');
      if (navChatSend) navChatSend.addEventListener('click', () => _sendNavStreamMessage());
      if (navChatInput) navChatInput.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _sendNavStreamMessage(); }
      });
      const navReplyCancel = document.getElementById('nav-stream-reply-cancel');
      if (navReplyCancel) navReplyCancel.addEventListener('click', () => _navCancelReply());

      stopBtn?.addEventListener('click', () => {
        const state = _readStreamState();
        if (!state || !state.live) {
          showToast('No active stream right now.', 'info');
          return;
        }
        _sendStreamCommand({ action: 'stop', by: user.uid });
      });
    }

    if (_streamStateTimer) clearInterval(_streamStateTimer);
    _streamStateTimer = setInterval(_refreshStreamManagerUI, 1000);
    _refreshStreamManagerUI();

    window.addEventListener('storage', e => {
      if (e.key === STREAM_STATE_KEY) _refreshStreamManagerUI();
    });

    try {
      _streamControlChannel = new BroadcastChannel('rps-stream-control');
      _streamControlChannel.onmessage = evt => {
        if (evt && evt.data && evt.data.type === 'stream-state') {
          _refreshStreamManagerUI();
        }
      };
    } catch (_) {}
  }

  function _startMainHeartbeat() {
    if (_mainHeartbeatTimer) clearInterval(_mainHeartbeatTimer);

    // Give this tab a unique id so we can track how many site tabs are open.
    const MAIN_TABS_KEY = 'rps_main_tabs_v1';
    const TAB_STALE_MS = 6000;
    const myTabId = 'tab_' + Date.now() + '_' + Math.random().toString(16).slice(2);

    function _readTabs() {
      try { return JSON.parse(localStorage.getItem(MAIN_TABS_KEY) || '{}'); }
      catch (_) { return {}; }
    }
    function _writeTabs(tabs) {
      try { localStorage.setItem(MAIN_TABS_KEY, JSON.stringify(tabs)); } catch (_) {}
    }

    const write = () => {
      try { localStorage.setItem(MAIN_HEARTBEAT_KEY, String(Date.now())); } catch (_) {}
      // Refresh our registry entry and prune stale ones
      const tabs = _readTabs();
      const now = Date.now();
      tabs[myTabId] = now;
      for (const id of Object.keys(tabs)) {
        if (now - tabs[id] > TAB_STALE_MS) delete tabs[id];
      }
      _writeTabs(tabs);
    };
    write();
    // 1 s interval — gives stream-core fast close detection while still
    // tolerating the brief gap during same-site page navigation.
    _mainHeartbeatTimer = setInterval(write, 1000);

    // On tab close: only remove ourselves from the registry. We deliberately
    // do NOT write rps_force_stop_v1 or remove the heartbeat here — when the
    // user navigates between same-site pages, the OLD page unloads BEFORE the
    // NEW page has had a chance to register, which would otherwise look like
    // "all tabs gone" and force-stop a healthy stream.
    //
    // Real "all tabs gone" cases (browser quit, OS shutdown, last tab closed)
    // are caught by the stream-core heartbeat watcher: it sees the registry
    // stop refreshing and the heartbeat go stale, then cleans up itself.
    const _onUnload = () => {
      try {
        const tabs = _readTabs();
        delete tabs[myTabId];
        _writeTabs(tabs);
      } catch (_) {}
    };
    window.addEventListener('pagehide', _onUnload);
    window.addEventListener('beforeunload', _onUnload);
  }

  function _ensureStreamManagerUI() {
    const navRight = document.querySelector('.nav-right');
    if (!navRight) return;

    if (!document.getElementById('stream-manage-nav-btn')) {
      const btn = document.createElement('button');
      btn.id = 'stream-manage-nav-btn';
      btn.className = 'stream-manage-nav-btn';
      btn.style.display = 'none';
      btn.title = 'Stream Manager';
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/><circle cx="8" cy="10" r="1.2"/><circle cx="12" cy="10" r="1.2"/><circle cx="16" cy="10" r="1.2"/></svg>';
      const notifWrap = navRight.querySelector('.notif-wrapper');
      if (notifWrap) navRight.insertBefore(btn, notifWrap);
      else navRight.prepend(btn);
    }

    if (!document.getElementById('stream-manage-panel')) {
      const panel = document.createElement('div');
      panel.id = 'stream-manage-panel';
      panel.className = 'stream-manage-panel';
      panel.style.display = 'none';
      panel.innerHTML =
        '<div class="stream-manage-header">' +
          '<span>Stream Manager</span>' +
          '<button class="stream-manage-close" id="stream-manage-close" title="Close">' +
            '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
          '</button>' +
        '</div>' +
        '<div class="stream-manage-body">' +
          '<div class="stream-manage-row"><span>Status</span><strong id="stream-manage-status">Offline</strong></div>' +
          '<div class="stream-manage-row"><span>Channel</span><strong id="stream-manage-channel">None</strong></div>' +
          '<div class="stream-manage-row"><span>Uptime</span><strong id="stream-manage-uptime">00:00:00</strong></div>' +
          '<div class="stream-manage-row" id="stream-manage-rec-row" style="display:none">' +
            '<span>Recording</span><strong id="stream-manage-rec-time">00:00:00</strong>' +
          '</div>' +
          '<div class="stream-manage-row" style="padding:8px 0 2px;border:none">' +
            '<span style="font-size:11px;color:var(--text-muted)">Resolution</span>' +
            '<select class="stream-quality-select" id="stream-manage-res" style="font-size:11px">' +
              '<option value="720">720p</option>' +
              '<option value="1080" selected>1080p</option>' +
              '<option value="1440">1440p</option>' +
              '<option value="4k">4K</option>' +
            '</select>' +
          '</div>' +
          '<div class="stream-manage-row" style="padding:2px 0 8px;border:none">' +
            '<span style="font-size:11px;color:var(--text-muted)">Frame Rate</span>' +
            '<select class="stream-quality-select" id="stream-manage-fps" style="font-size:11px">' +
              '<option value="30" selected>30 fps</option>' +
              '<option value="60">60 fps</option>' +
            '</select>' +
          '</div>' +
          '<div class="stream-manage-actions">' +
            '<button class="btn btn-sm" id="stream-manage-chat-btn">Chat</button>' +
            '<button class="btn btn-sm" id="stream-manage-snap-btn">Take Picture</button>' +
            '<button class="btn btn-sm" id="stream-manage-pause-btn">Pause Stream</button>' +
            '<button class="btn btn-sm" id="stream-manage-record-btn">Start Recording</button>' +
            '<button class="btn btn-sm" id="stream-manage-record-pause-btn" style="display:none">Pause Rec</button>' +
            '<button class="btn btn-danger btn-sm" id="stream-manage-stop-btn">Stop Stream</button>' +
          '</div>' +
        '</div>';
      const app = document.getElementById('app') || document.body;
      app.appendChild(panel);
    }

    if (!document.getElementById('nav-stream-chat-panel')) {
      const chatPanel = document.createElement('div');
      chatPanel.id = 'nav-stream-chat-panel';
      chatPanel.className = 'stream-chat-window';
      chatPanel.style.display = 'none';
      chatPanel.innerHTML =
        '<div class="stream-chat-header">' +
          '<span id="nav-stream-chat-title">Stream Chat</span>' +
          '<button class="stream-chat-close" id="nav-stream-chat-close" title="Close">' +
            '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
          '</button>' +
        '</div>' +
        '<div class="chat-messages" id="nav-stream-chat-messages">' +
          '<div class="chat-empty">No active stream chat.</div>' +
        '</div>' +
        '<div class="reply-bar" id="nav-stream-reply-bar" style="display:none">' +
          '<span class="reply-bar-label">Replying to <strong id="nav-stream-reply-name"></strong>: <span id="nav-stream-reply-preview"></span></span>' +
          '<button class="reply-bar-cancel" id="nav-stream-reply-cancel" title="Cancel reply">' +
            '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
          '</button>' +
        '</div>' +
        '<div class="stream-chat-input-row">' +
          '<input class="chat-input" id="nav-stream-chat-input" placeholder="Message stream chat..." maxlength="2000">' +
          '<button class="chat-send" id="nav-stream-chat-send" title="Send">' +
            '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>' +
          '</button>' +
        '</div>';
      const appEl = document.getElementById('app') || document.body;
      appEl.appendChild(chatPanel);
    }

    if (!document.getElementById('user-popup-overlay')) {
      const ov = document.createElement('div');
      ov.id = 'user-popup-overlay';
      ov.className = 'user-popup-overlay';
      const pu = document.createElement('div');
      pu.id = 'user-popup';
      pu.className = 'user-popup';
      ov.appendChild(pu);
      document.body.appendChild(ov);
    }
  }

  function _sendStreamCommand(cmd) {
    const payload = { ...cmd, id: Date.now() + ':' + Math.random().toString(16).slice(2), ts: Date.now() };
    localStorage.setItem(STREAM_CMD_KEY, JSON.stringify(payload));
    try {
      const bc = _streamControlChannel || new BroadcastChannel('rps-stream-control');
      bc.postMessage({ type: 'stream-cmd', payload });
    } catch (_) {}
  }

  function _readStreamState() {
    try {
      const raw = localStorage.getItem(STREAM_STATE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function _resolveStreamManagerUrl(state) {
    const raw = (state && (state.controllerUrl || state.hostUrl)) || '';
    if (!raw) return 'messenger.html';
    if (/stream-core\.html/i.test(raw)) return 'messenger.html';
    return raw;
  }

  function _openNavStreamChat(state) {
    const panel = document.getElementById('nav-stream-chat-panel');
    if (!panel) return;
    panel.style.display = 'flex';
    const titleEl = document.getElementById('nav-stream-chat-title');
    if (titleEl) titleEl.textContent = 'Stream Chat \u2014 ' + _esc(state.channelName || 'Streaming Channel');
    if (!state.serverId || !state.channelId) return;
    if (_navStreamChatUnsub) { _navStreamChatUnsub(); _navStreamChatUnsub = null; }
    const messagesEl = document.getElementById('nav-stream-chat-messages');
    if (!messagesEl) return;
    messagesEl.innerHTML = '<div class="chat-empty">Loading...</div>';
    _navStreamChatUnsub = db.collection('servers').doc(state.serverId)
      .collection('channels').doc(state.channelId)
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
          if (data.uid) _ensureNavProfileCached(data.uid);
          messagesEl.appendChild(_renderNavStreamMessage(data, doc.ref, doc.id));
        });
        messagesEl.scrollTop = messagesEl.scrollHeight;
      });
  }

  function _renderNavStreamMessage(data, docRef, docId) {
    const div = document.createElement('div');
    div.className = 'msg';
    div.dataset.uid = data.uid || '';
    if (docId) div.dataset.msgId = docId;
    const cached = _navStreamProfileCache.get(data.uid);
    const username = cached ? cached.username : (data.username || 'Unknown');
    const avatar = cached ? cached.avatar : (data.avatar || '');
    const eStatus = cached ? cached.effectiveStatus : 'offline';
    const initial = (username || 'U').charAt(0).toUpperCase();
    const avatarContent = avatar ? '<img src="' + _esc(avatar) + '" alt="">' : initial;
    const time = data.createdAt
      ? new Date(data.createdAt.toDate()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';

    // Reply quote block
    let replyQuoteHTML = '';
    if (data.replyTo) {
      const rAuthor = _esc(data.replyTo.username || 'Unknown');
      let rText = (data.replyTo.text || '').slice(0, 100);
      if (!rText) {
        if (data.replyTo.gifUrl) rText = '[GIF]';
        else if (data.replyTo.videoUrl) rText = '[video]';
        else if (data.replyTo.images && data.replyTo.images.length) rText = '[image]';
        else rText = '[message]';
      }
      const rCached = _navStreamProfileCache.get(data.replyTo.uid);
      const rAvatar = (rCached && rCached.avatar)
        ? '<img src="' + _esc(rCached.avatar) + '" alt="">'
        : _esc((data.replyTo.username || 'U').charAt(0).toUpperCase());
      replyQuoteHTML = '<div class="msg-reply-quote"' + (data.replyTo.docId ? ' data-reply-id="' + _esc(data.replyTo.docId) + '"' : '') + '>' +
        '<span class="reply-curve-line"></span>' +
        '<span class="reply-avatar-mini">' + rAvatar + '</span>' +
        '<span class="reply-name">' + rAuthor + '</span>' +
        '<span class="reply-text">' + _esc(rText) + '</span>' +
        '</div>';
    }

    let contentHTML = '';
    if (data.gifUrl) contentHTML += '<div class="msg-gif-wrap"><img class="msg-gif" src="' + _esc(data.gifUrl) + '" alt="GIF" loading="lazy"></div>';
    if (data.text) contentHTML += '<div class="msg-text">' + _esc(data.text) + (data.edited ? '<span class="msg-edited-tag">(edited)</span>' : '') + '</div>';
    if (data.images && data.images.length) {
      contentHTML += '<div class="msg-images' + (data.images.length === 1 ? ' single' : '') + '">' +
        data.images.map(url => '<img class="msg-image" src="' + _esc(url) + '" alt="" loading="lazy">').join('') +
        '</div>';
    }
    if (data.videoUrl) contentHTML += '<div class="msg-video-wrap"><video class="msg-video" src="' + _esc(data.videoUrl) + '" controls preload="metadata"></video></div>';

    const isOwn = _navStreamChatCurrentUser && data.uid === _navStreamChatCurrentUser.uid;
    const canDelete = isOwn && !!docRef;
    const canEdit   = isOwn && !!docRef && !data.gifUrl && !(data.images && data.images.length && !data.text);
    const replyBtn  = docRef ? '<button class="msg-action-btn reply" title="Reply"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg></button>' : '';
    const editBtn   = canEdit ? '<button class="msg-action-btn edit" title="Edit"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>' : '';
    const deleteBtn = canDelete ? '<button class="msg-action-btn delete" title="Delete"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg></button>' : '';
    const actionsHTML = (replyBtn || editBtn || deleteBtn) ? '<div class="msg-actions">' + replyBtn + editBtn + deleteBtn + '</div>' : '';

    div.innerHTML =
      '<div class="msg-avatar">' + avatarContent +
        '<span class="status-dot ' + _esc(eStatus) + '"></span>' +
      '</div>' +
      '<div class="msg-body">' +
        replyQuoteHTML +
        '<div class="msg-header">' +
          '<span class="msg-author">' + _esc(username) + '</span>' +
          '<span class="msg-time">' + _esc(time) + '</span>' +
        '</div>' +
        contentHTML +
      '</div>' +
      actionsHTML;

    if (data.uid && _navStreamChatCurrentUser && data.uid !== _navStreamChatCurrentUser.uid) {
      const avatarEl = div.querySelector('.msg-avatar');
      const authorEl = div.querySelector('.msg-author');
      if (avatarEl) avatarEl.addEventListener('click', e => { e.stopPropagation(); _showNavUserPopup(data.uid, avatarEl); });
      if (authorEl) authorEl.addEventListener('click', e => { e.stopPropagation(); _showNavUserPopup(data.uid, authorEl); });
    }
    const replyBtnEl = div.querySelector('.msg-action-btn.reply');
    if (replyBtnEl) replyBtnEl.addEventListener('click', () => _navSetReply(data, docId));
    const editBtnEl = div.querySelector('.msg-action-btn.edit');
    if (editBtnEl) editBtnEl.addEventListener('click', () => _navEditMessage(docRef, data.text || '', div));
    const deleteBtnEl = div.querySelector('.msg-action-btn.delete');
    if (deleteBtnEl) deleteBtnEl.addEventListener('click', async () => {
      try { await docRef.delete(); } catch (_) { showToast('Failed to delete message.', 'error'); }
    });
    const quoteEl = div.querySelector('.msg-reply-quote[data-reply-id]');
    if (quoteEl) quoteEl.addEventListener('click', () => {
      const target = document.querySelector('#nav-stream-chat-messages [data-msg-id="' + quoteEl.dataset.replyId + '"]');
      if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); target.classList.add('msg-highlight'); setTimeout(() => target.classList.remove('msg-highlight'), 2000); }
    });
    return div;
  }

  async function _ensureNavProfileCached(uid) {
    if (!uid || _navStreamProfileCache.has(uid)) return;
    try {
      const doc = await db.collection('users').doc(uid).get();
      if (!doc.exists) return;
      const d = doc.data() || {};
      _navStreamProfileCache.set(uid, {
        username: d.username || 'User',
        avatar: d.avatar || '',
        effectiveStatus: d.effectiveStatus || 'offline'
      });
      _patchNavStreamMessages(uid);
    } catch (_) {}
  }

  function _patchNavStreamMessages(uid) {
    const cached = _navStreamProfileCache.get(uid);
    if (!cached) return;
    const initial = (cached.username || 'U').charAt(0).toUpperCase();
    const avatarHTML = cached.avatar ? '<img src="' + _esc(cached.avatar) + '" alt="">' : initial;
    document.querySelectorAll('#nav-stream-chat-messages .msg[data-uid="' + uid + '"]').forEach(div => {
      const av = div.querySelector('.msg-avatar');
      if (av) av.innerHTML = avatarHTML + '<span class="status-dot ' + (cached.effectiveStatus || 'offline') + '"></span>';
      const author = div.querySelector('.msg-author');
      if (author) author.textContent = cached.username || 'Unknown';
    });
  }

  async function _sendNavStreamMessage() {
    if (!_navStreamChatCurrentUser) return;
    const state = _readStreamState();
    if (!state || !state.live || !state.serverId || !state.channelId) return;
    const input = document.getElementById('nav-stream-chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    const msgData = { uid: _navStreamChatCurrentUser.uid, text, createdAt: firebase.firestore.FieldValue.serverTimestamp() };
    if (_navStreamReplyState) {
      msgData.replyTo = _navStreamReplyState;
      _navCancelReply();
    }
    try {
      await db.collection('servers').doc(state.serverId)
        .collection('channels').doc(state.channelId)
        .collection('messages')
        .add(msgData);
    } catch (_) {
      input.value = text;
      showToast('Failed to send message.', 'error');
    }
  }

  function _navSetReply(data, docId) {
    const cached = _navStreamProfileCache.get(data.uid);
    const username = cached ? cached.username : (data.username || 'Unknown');
    let displayText = data.text || '';
    if (!displayText) {
      if (data.gifUrl) displayText = '[GIF]';
      else if (data.videoUrl) displayText = '[video]';
      else if (data.images && data.images.length) displayText = '[image]';
      else displayText = '[message]';
    }
    const preview = displayText.slice(0, 80) + (displayText.length > 80 ? '\u2026' : '');
    _navStreamReplyState = {
      uid: data.uid,
      username,
      text: data.text || '',
      docId: docId || '',
      images: data.images || [],
      gifUrl: data.gifUrl || '',
      videoUrl: data.videoUrl || ''
    };
    const nameEl = document.getElementById('nav-stream-reply-name');
    const previewEl = document.getElementById('nav-stream-reply-preview');
    const bar = document.getElementById('nav-stream-reply-bar');
    if (nameEl) nameEl.textContent = username;
    if (previewEl) previewEl.textContent = preview;
    if (bar) bar.style.display = 'flex';
    const inp = document.getElementById('nav-stream-chat-input');
    if (inp) inp.focus();
  }

  function _navCancelReply() {
    _navStreamReplyState = null;
    const bar = document.getElementById('nav-stream-reply-bar');
    if (bar) bar.style.display = 'none';
    const nameEl = document.getElementById('nav-stream-reply-name');
    const previewEl = document.getElementById('nav-stream-reply-preview');
    if (nameEl) nameEl.textContent = '';
    if (previewEl) previewEl.textContent = '';
  }

  function _navEditMessage(docRef, currentText, msgEl) {
    const msgTextEl = msgEl.querySelector('.msg-text');
    if (!msgTextEl || msgEl.querySelector('.msg-edit-wrapper')) return;
    const original = msgTextEl.innerHTML;
    msgTextEl.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'msg-edit-wrapper';
    const label = document.createElement('div');
    label.className = 'msg-edit-label';
    label.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Editing message';
    const textarea = document.createElement('textarea');
    textarea.className = 'msg-edit-input';
    textarea.value = currentText;
    function autoGrow() { textarea.style.height = 'auto'; textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px'; }
    textarea.addEventListener('input', autoGrow);
    const footer = document.createElement('div');
    footer.className = 'msg-edit-footer';
    const charCount = document.createElement('span');
    charCount.className = 'msg-edit-char-count';
    function updateCount() { charCount.textContent = (2000 - textarea.value.length) + ' left'; }
    updateCount();
    textarea.addEventListener('input', updateCount);
    const actions = document.createElement('div');
    actions.className = 'msg-edit-actions';
    const hint = document.createElement('span');
    hint.className = 'msg-edit-hint';
    hint.textContent = 'Esc to cancel';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'msg-edit-cancel';
    cancelBtn.textContent = 'Cancel';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'msg-edit-save';
    saveBtn.textContent = 'Save Changes';
    actions.appendChild(hint);
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    footer.appendChild(charCount);
    footer.appendChild(actions);
    wrapper.appendChild(label);
    wrapper.appendChild(textarea);
    wrapper.appendChild(footer);
    msgTextEl.appendChild(wrapper);
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    setTimeout(autoGrow, 0);
    async function save() {
      const newText = textarea.value.trim();
      if (!newText || newText === currentText) { cancel(); return; }
      try { await docRef.update({ text: newText, edited: true }); }
      catch (_) { showToast('Failed to edit message.', 'error'); cancel(); }
    }
    function cancel() { msgTextEl.innerHTML = original; }
    saveBtn.addEventListener('click', save);
    cancelBtn.addEventListener('click', cancel);
    textarea.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
      if (e.key === 'Escape') { cancel(); }
    });
  }

  async function _showNavUserPopup(uid, anchorEl) {
    const overlay = document.getElementById('user-popup-overlay');
    const popup = document.getElementById('user-popup');
    if (!overlay || !popup) return;
    let u = _navStreamProfileCache.get(uid);
    let fullData = null;
    try {
      const doc = await db.collection('users').doc(uid).get();
      if (doc.exists) {
        fullData = doc.data();
        u = {
          username: fullData.username || (u ? u.username : 'Unknown'),
          avatar: fullData.avatar || (u ? u.avatar : ''),
          effectiveStatus: fullData.effectiveStatus || (u ? u.effectiveStatus : 'offline')
        };
      }
    } catch (_) {}
    if (!u) return;
    const initial = (u.username || 'U').charAt(0).toUpperCase();
    const avatarHtml = u.avatar
      ? '<img src="' + _esc(u.avatar) + '" alt="">'
      : '<span class="user-popup-initial">' + initial + '</span>';
    const eStatus = u.effectiveStatus || 'offline';
    const statusText = _navResolveActivity(fullData || u, eStatus);
    const desc = fullData && fullData.description ? fullData.description : '';
    let isFriend = false;
    try {
      if (_navStreamChatCurrentUser) {
        const myDoc = await db.collection('users').doc(_navStreamChatCurrentUser.uid).get();
        const myFriends = (myDoc.data() || {}).friends || [];
        isFriend = myFriends.includes(uid);
      }
    } catch (_) {}
    popup.innerHTML =
      '<div class="user-popup-banner"></div>' +
      '<div class="user-popup-body">' +
        '<div class="user-popup-avatar-wrap">' +
          '<div class="user-popup-avatar">' + avatarHtml +
            '<span class="status-dot ' + eStatus + '"></span>' +
          '</div>' +
        '</div>' +
        '<h3 class="user-popup-name">' + _esc(u.username) + '</h3>' +
        '<span class="user-popup-status ' + eStatus + '">' + _esc(statusText) + '</span>' +
        (desc ? '<div class="user-popup-desc">' + _esc(desc) + '</div>' : '') +
        '<hr class="user-popup-divider">' +
        '<div class="user-popup-actions">' +
          (isFriend
            ? '<button class="btn btn-sm" disabled style="opacity:.5;cursor:default;flex:1">Already Friends</button>'
            : '<button class="btn btn-primary btn-sm" id="nav-popup-add-friend">Add Friend</button>') +
          '<button class="btn btn-sm" id="nav-popup-dm-btn">Message</button>' +
        '</div>' +
        '<button class="user-popup-view-more" id="nav-popup-view-more">View Full Profile</button>' +
      '</div>';
    const rect = anchorEl.getBoundingClientRect();
    let top = rect.top, left = rect.right + 10;
    const popupW = 300, popupH = 340;
    if (left + popupW > window.innerWidth) left = rect.left - popupW - 10;
    if (left < 0) left = 10;
    if (top + popupH > window.innerHeight) top = window.innerHeight - popupH - 10;
    if (top < 10) top = 10;
    popup.style.top = top + 'px';
    popup.style.left = left + 'px';
    overlay.classList.add('open');
    overlay.addEventListener('click', function _close(e) {
      if (e.target === overlay) { overlay.classList.remove('open'); overlay.removeEventListener('click', _close); }
    });
    const addBtn = document.getElementById('nav-popup-add-friend');
    if (addBtn) {
      addBtn.addEventListener('click', async () => {
        addBtn.disabled = true;
        addBtn.textContent = 'Sending...';
        try {
          if (!_navStreamChatCurrentUser) return;
          const reverseReqs = await db.collection('friend_requests')
            .where('from', '==', uid).where('to', '==', _navStreamChatCurrentUser.uid).get();
          let reverseDoc = null;
          reverseReqs.forEach(d => { if (d.data().status === 'pending') reverseDoc = d; });
          if (reverseDoc) {
            const batch = db.batch();
            batch.update(db.collection('users').doc(_navStreamChatCurrentUser.uid), { friends: firebase.firestore.FieldValue.arrayUnion(uid) });
            batch.update(db.collection('users').doc(uid), { friends: firebase.firestore.FieldValue.arrayUnion(_navStreamChatCurrentUser.uid) });
            batch.update(db.collection('friend_requests').doc(reverseDoc.id), { status: 'accepted' });
            await batch.commit();
            addBtn.textContent = 'Friends!';
            showToast('Friend added!', 'success');
            return;
          }
          const existing = await db.collection('friend_requests')
            .where('from', '==', _navStreamChatCurrentUser.uid).where('to', '==', uid).get();
          let hasPending = false;
          existing.forEach(d => { if (d.data().status === 'pending') hasPending = true; });
          if (hasPending) { showToast('Request already sent.', 'info'); addBtn.textContent = 'Sent'; return; }
          await db.collection('friend_requests').add({
            from: _navStreamChatCurrentUser.uid,
            fromUsername: (_currentProfile || {}).username || 'User',
            to: uid,
            toUsername: u.username,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            status: 'pending'
          });
          addBtn.textContent = 'Sent!';
          showToast('Friend request sent!', 'success');
        } catch (_) {
          addBtn.textContent = 'Failed';
          showToast('Failed to send request.', 'error');
        }
      });
    }
    document.getElementById('nav-popup-dm-btn').addEventListener('click', () => {
      overlay.classList.remove('open');
      window.location.href = 'messenger.html?dm=' + encodeURIComponent(uid);
    });
    document.getElementById('nav-popup-view-more').addEventListener('click', () => {
      overlay.classList.remove('open');
      window.location.href = 'friends.html?view=' + uid;
    });
  }

  function _navResolveActivity(profile, eStatus) {
    if (eStatus === 'offline') return 'Offline';
    if (eStatus === 'dnd') return 'Do Not Disturb';
    const activity = profile.activity || {};
    if (activity.page === 'games' && activity.game) return 'Playing ' + activity.game;
    if (activity.page === 'messenger' && activity.server) return 'In RedsssMessenger \u2014 ' + activity.server;
    if (activity.page === 'messenger' && activity.dm) return 'Messaging ' + activity.dm;
    if (activity.page === 'messenger') return 'In RedsssMessenger';
    if (activity.page === 'games') return 'Browsing Games';
    if (activity.page === 'support') return 'Viewing Support';
    if (activity.page === 'home') return eStatus === 'away' ? 'Away' : 'Online';
    if (activity.page === 'friends') return eStatus === 'away' ? 'Away' : 'Viewing Friends';
    return eStatus === 'away' ? 'Away' : 'Online';
  }

  function _refreshStreamManagerUI() {
    const state = _readStreamState();
    const shared = _readSharedState();
    const navBtn = document.getElementById('stream-manage-nav-btn');
    const statusEl = document.getElementById('stream-manage-status');
    const channelEl = document.getElementById('stream-manage-channel');
    const uptimeEl = document.getElementById('stream-manage-uptime');
    const pauseBtn = document.getElementById('stream-manage-pause-btn');
    const recBtn = document.getElementById('stream-manage-record-btn');
    const recPauseBtn = document.getElementById('stream-manage-record-pause-btn');
    const recRow = document.getElementById('stream-manage-rec-row');
    const recTimeEl = document.getElementById('stream-manage-rec-time');

    // If the stream-core tab has gone silent for more than ~4s, treat the
    // stream as dead so we don't keep a ghost button around after a crash.
    let live = !!(state && state.live);
    if (live && shared && shared.ts) {
      if (Date.now() - Number(shared.ts || 0) > 4000) live = false;
    }
    if (navBtn) {
      navBtn.style.display = live ? 'inline-flex' : 'none';
      navBtn.classList.toggle('live', live);
    }
    if (!statusEl || !channelEl || !uptimeEl) return;

    if (!live) {
      const navChatPanel = document.getElementById('nav-stream-chat-panel');
      if (navChatPanel && navChatPanel.style.display !== 'none') {
        navChatPanel.style.display = 'none';
        if (_navStreamChatUnsub) { _navStreamChatUnsub(); _navStreamChatUnsub = null; }
      }
      const managePanel = document.getElementById('stream-manage-panel');
      if (managePanel && managePanel.style.display !== 'none') {
        managePanel.style.display = 'none';
      }
      statusEl.textContent = 'Offline';
      channelEl.textContent = 'None';
      uptimeEl.textContent = '00:00:00';
      return;
    }

    const streamPaused = !!(shared && shared.streamPaused);
    statusEl.textContent = streamPaused ? 'Paused' : 'Live';
    channelEl.textContent = state.channelName || 'Streaming Channel';
    const startedAt = Number(state.startedAt || 0);
    const dur = startedAt ? Math.max(0, Date.now() - startedAt) : 0;
    const total = Math.floor(dur / 1000);
    const hh = String(Math.floor(total / 3600)).padStart(2, '0');
    const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    uptimeEl.textContent = hh + ':' + mm + ':' + ss;

    if (pauseBtn) pauseBtn.textContent = streamPaused ? 'Resume Stream' : 'Pause Stream';

    const recStatus = shared && shared.recordStatus;
    const recording = recStatus === 'recording' || recStatus === 'paused';
    if (recBtn) recBtn.textContent = recording ? 'Stop Recording' : 'Start Recording';
    if (recPauseBtn) {
      recPauseBtn.style.display = recording ? '' : 'none';
      recPauseBtn.textContent = recStatus === 'paused' ? 'Resume Rec' : 'Pause Rec';
    }
    if (recRow && recTimeEl) {
      if (recording && shared && shared.recordStartedAt) {
        recRow.style.display = '';
        let elapsed = Date.now() - shared.recordStartedAt - (shared.recordPausedAccumulatedMs || 0);
        if (recStatus === 'paused' && shared.recordPausedAt) elapsed -= (Date.now() - shared.recordPausedAt);
        const t = Math.max(0, Math.floor(elapsed / 1000));
        recTimeEl.textContent =
          String(Math.floor(t / 3600)).padStart(2, '0') + ':' +
          String(Math.floor((t % 3600) / 60)).padStart(2, '0') + ':' +
          String(t % 60).padStart(2, '0');
      } else {
        recRow.style.display = 'none';
      }
    }
  }

  // Read the stream-core shared state (recording/pause info)
  function _readSharedState() {
    try { return JSON.parse(localStorage.getItem('rps_stream_state_v1') || 'null'); } catch (_) { return null; }
  }

  // Snapshot: open any visible remote video and download a frame
  function _navTakeSnapshot() {
    const video = document.querySelector('.stream-card video') || document.querySelector('video');
    if (!video || !video.videoWidth) { showToast('No stream video to capture.', 'info'); return; }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      canvas.toBlob(blob => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'snapshot-' + Date.now() + '.png';
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
      }, 'image/png');
    } catch (_) { showToast('Snapshot failed.', 'error'); }
  }

  // Make a fixed-position floating panel draggable by its header element.
  function _makeDraggable(panel, handle) {
    if (!panel || !handle) return;
    let dragging = false, startX = 0, startY = 0, origLeft = 0, origTop = 0;
    handle.addEventListener('mousedown', e => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      dragging = true;
      const rect = panel.getBoundingClientRect();
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.left = rect.left + 'px';
      panel.style.top  = rect.top  + 'px';
      startX = e.clientX; startY = e.clientY;
      origLeft = rect.left; origTop = rect.top;
      handle.style.cursor = 'grabbing';
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      let newLeft = origLeft + (e.clientX - startX);
      let newTop  = origTop  + (e.clientY - startY);
      newLeft = Math.max(0, Math.min(newLeft, window.innerWidth  - panel.offsetWidth));
      newTop  = Math.max(0, Math.min(newTop,  window.innerHeight - panel.offsetHeight));
      panel.style.left = newLeft + 'px';
      panel.style.top  = newTop  + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (dragging) { dragging = false; handle.style.cursor = ''; }
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

        // Suppress badge/bell when user is in DND mode
        const isDnd = _currentProfile && _currentProfile.effectiveStatus === 'dnd';
        if (unread > 0 && !isDnd) {
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

  function _listenFriendRequests(user) {
    db.collection('friend_requests')
      .where('to', '==', user.uid)
      .onSnapshot(snap => {
        const badge = document.getElementById('friend-req-badge');
        if (!badge) return;
        let count = 0;
        snap.forEach(d => { if (d.data().status === 'pending') count++; });
        if (count > 0) {
          badge.textContent = count > 9 ? '9+' : count;
          badge.style.display = 'flex';
        } else {
          badge.style.display = 'none';
        }
      });
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
        // Include statusMode so observer clients (messenger/friends) know whether to
      // sync effectiveStatus:'offline' back to Firestore for this user.
      presenceRef.onDisconnect().update({ effectiveStatus: 'offline', online: false, statusMode: profile.status || 'auto' })
          .then(() => {
            // Guard: don't write online:true if _goOffline already ran
            if (!_pageClosing) presenceRef.update({ effectiveStatus: effective, online: true, statusMode: profile.status || 'auto' });
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
      const isAuto = (profile.status || 'auto') === 'auto';
      const rtdbPayload = JSON.stringify({ online: false, effectiveStatus: 'offline', statusMode: profile.status || 'auto' });
      const hdrs = { 'Content-Type': 'application/json' };
      if (_cachedToken) hdrs['Authorization'] = 'Bearer ' + _cachedToken;
      // RTDB keepalive — always mark RTDB offline so observer clients detect the disconnect
      try { fetch(_rtdbRestUrl + (_cachedToken ? '?auth=' + _cachedToken : ''), { method: 'PATCH', body: rtdbPayload, headers: { 'Content-Type': 'application/json' }, keepalive: true }); } catch(e) {}
      // RTDB SDK write
      if (presenceRef) presenceRef.update({ online: false, effectiveStatus: 'offline', statusMode: profile.status || 'auto' }).catch(() => {});
      // Firestore — auto users: write offline. Manual users: only update lastSeen so their
      // chosen status persists even after the browser is fully closed.
      if (isAuto) {
        const fsPayload = JSON.stringify({ fields: { online: { booleanValue: false }, effectiveStatus: { stringValue: 'offline' } } });
        try { fetch(_fsRestUrl, { method: 'PATCH', body: fsPayload, headers: hdrs, keepalive: true }); } catch(e) {}
        ref.update({ online: false, effectiveStatus: 'offline', lastSeen: firebase.firestore.FieldValue.serverTimestamp() }).catch(() => {});
      } else {
        ref.update({ lastSeen: firebase.firestore.FieldValue.serverTimestamp() }).catch(() => {});
      }
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
        if (presenceRef) presenceRef.update({ effectiveStatus: 'online', online: true }).catch(() => {});
        profile.effectiveStatus = 'online';
        _renderUserUI(user, profile);
        _resetIdleTimer(user, profile);
        return;
      }
      // Page hidden — delay away write so pagehide/beforeunload can cancel it
      _awayTimer = setTimeout(() => {
        if (_pageClosing) return;
        ref.update({ effectiveStatus: 'away', lastSeen: firebase.firestore.FieldValue.serverTimestamp() }).catch(() => {});
        if (presenceRef) presenceRef.update({ effectiveStatus: 'away', online: true }).catch(() => {});
        profile.effectiveStatus = 'away';
        _renderUserUI(user, profile);
      }, 600);
    });

    // Idle detection (mouse/keyboard)
    const resetIdle = () => _resetIdleTimer(user, profile);
    document.addEventListener('mousemove', resetIdle, { passive: true });
    document.addEventListener('keydown', resetIdle, { passive: true });
    _resetIdleTimer(user, profile);

    // Heartbeat — keeps lastSeen fresh; also refreshes effectiveStatus for auto users.
    // Manual users only update lastSeen so their chosen status is never overwritten.
    setInterval(() => {
      const curStatus = profile.status || 'auto';
      const curEff = profile.effectiveStatus || 'online';
      if (curStatus === 'auto') {
        ref.update({ lastSeen: firebase.firestore.FieldValue.serverTimestamp(), effectiveStatus: curEff }).catch(() => {});
        if (presenceRef) presenceRef.update({ effectiveStatus: curEff, online: curEff !== 'offline', statusMode: 'auto' }).catch(() => {});
      } else {
        ref.update({ lastSeen: firebase.firestore.FieldValue.serverTimestamp() }).catch(() => {});
        if (presenceRef) presenceRef.update({ statusMode: curStatus, online: true }).catch(() => {});
      }
    }, 10000);

    // Auto-save status immediately when dropdown changes
    document.getElementById('profile-status')?.addEventListener('change', () => {
      const status = document.getElementById('profile-status').value;
      const effectiveStatus = _computeEffective(status);
      profile.status = status;
      profile.effectiveStatus = effectiveStatus;
      ref.update({ status, effectiveStatus }).catch(() => {});
      if (presenceRef) presenceRef.update({ effectiveStatus, online: effectiveStatus !== 'offline', statusMode: status }).catch(() => {});
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

  return { init, initStreamManager: _initStreamManager };
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
