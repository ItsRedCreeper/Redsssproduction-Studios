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

        // Load Firestore profile — 2 s timeout so a slow Firestore cold-start
        // never holds up the loading screen.  If we time out we show the app
        // with a sensible fallback and silently patch once the data arrives.
        const _fallbackProfile = () => ({
          username: user.displayName || 'User', avatar: '',
          status: 'auto', effectiveStatus: 'online'
        });
        let profile;
        let _timedOut = false;
        const _docPromise = db.collection('users').doc(user.uid).get();
        try {
          const timeoutP = new Promise((_, rej) =>
            setTimeout(() => rej(new Error('timeout')), 2000));
          const doc = await Promise.race([_docPromise, timeoutP]);
          profile = doc.exists ? doc.data() : _fallbackProfile();
        } catch {
          // Timed out or hard error — show the app now with a fallback profile,
          // then silently update the UI once the real data arrives.
          _timedOut = true;
          profile = _fallbackProfile();
          _docPromise.then(late => {
            if (!late.exists) return;
            _currentProfile = late.data();
            _renderUserUI(user, _currentProfile);
          }).catch(() => {});
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

    // Wire up the new channel-hub UI (works on every page).
    _wireChannelHub();
    _wireStreamListModal();
    _wireFloatingStreamViewer();
    _ensureLightbox();
    _wireLightboxDelegation();

    // Persist position/size of the stream manage panel and nav stream chat.
    const _managePanel = document.getElementById('stream-manage-panel');
    if (_managePanel) _trackLayout(_managePanel, 'rps_manage_panel_v1');
    const _navChatPanel = document.getElementById('nav-stream-chat-panel');
    if (_navChatPanel) _trackLayout(_navChatPanel, CHAT_WINDOW_LAYOUT_KEY);

    const navBtn = document.getElementById('stream-manage-nav-btn');
    const panel = document.getElementById('stream-manage-panel');
    const closeBtn = document.getElementById('stream-manage-close');
    const chatBtn = document.getElementById('stream-manage-chat-btn');
    const stopBtn = document.getElementById('stream-manage-stop-btn');

    if (!isMessengerPage) {
      navBtn?.addEventListener('click', () => {
        if (panel.style.display === 'none' || !panel.style.display) {
          panel.style.display = 'block';
          _writeWindowsOpen({ manage: true });
        } else {
          panel.style.display = 'none';
          _writeWindowsOpen({ manage: false });
        }
      });
      closeBtn?.addEventListener('click', () => {
        panel.style.display = 'none';
        _writeWindowsOpen({ manage: false });
      });

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
        _writeWindowsOpen({ chat: false });
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

      // Upload buttons (images + video)
      const uploadBtn = document.getElementById('nav-stream-chat-upload-btn');
      const videoBtn = document.getElementById('nav-stream-chat-video-btn');
      const uploadInput = document.getElementById('nav-stream-chat-upload-input');
      const videoInput = document.getElementById('nav-stream-chat-video-input');
      if (uploadBtn && uploadInput) {
        uploadBtn.addEventListener('click', () => uploadInput.click());
        uploadInput.addEventListener('change', e => {
          const files = Array.from(e.target.files || []);
          e.target.value = '';
          if (!files.length) return;
          // 10MB per image cap, max 4
          for (const f of files) {
            if (f.size > 10 * 1024 * 1024) { showToast(f.name + ' is larger than 10MB.', 'error'); continue; }
            if (_navStreamFiles.length >= 4) { showToast('Max 4 images per message.', 'info'); break; }
            _navStreamFiles.push(f);
          }
          _renderNavStreamStaging();
        });
      }
      if (videoBtn && videoInput) {
        videoBtn.addEventListener('click', () => videoInput.click());
        videoInput.addEventListener('change', e => {
          const file = e.target.files && e.target.files[0];
          e.target.value = '';
          if (!file) return;
          if (file.size > 50 * 1024 * 1024) { showToast('Video is larger than 50MB.', 'error'); return; }
          _navStreamVideo = file;
          _renderNavStreamStaging();
        });
      }

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

    // ── Restore windows that were open on the previous page ──
    _restoreOpenWindows();
  }

  /* ── Re-open floating windows that were open before navigation. ── */
  function _restoreOpenWindows() {
    let opened;
    try { opened = _readWindowsOpen(); } catch (_) { opened = {}; }
    if (!opened) return;

    // Chat window — only restore if the user is still in a channel.
    const joined = _readJoinedChannel();
    if (opened.chat && joined) {
      try {
        _openNavStreamChat({
          serverId: joined.serverId,
          channelId: joined.channelId,
          channelName: joined.channelName
        });
      } catch (_) {}
    } else if (opened.chat && !joined) {
      // No longer in a channel — clear the stale flag.
      _writeWindowsOpen({ chat: false });
    }

    // Floating stream viewer — requires saved stream info.
    if (opened.viewer && opened.viewerStream &&
        opened.viewerStream.uid && opened.viewerStream.livekitRoom && opened.viewerStream.livekitUrl) {
      try { _openFloatingStreamViewer(opened.viewerStream); } catch (_) {}
    } else if (opened.viewer) {
      _writeWindowsOpen({ viewer: false, viewerStream: null });
    }

    // Stream manage panel (streamer-only, non-messenger pages).
    if (opened.manage) {
      const mp = document.getElementById('stream-manage-panel');
      if (mp) {
        mp.style.display = 'block';
        try { _applyLayout(mp, 'rps_manage_panel_v1', { left: 20, top: 80, width: 280, height: 'auto' }); } catch (_) {}
      }
    }
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
        '<div class="stream-chat-staging" id="nav-stream-chat-staging" style="display:none"></div>' +
        '<div class="stream-chat-input-row">' +
          '<button class="img-upload-btn" id="nav-stream-chat-upload-btn" title="Upload Image / GIF">' +
            '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>' +
          '</button>' +
          '<button class="img-upload-btn" id="nav-stream-chat-video-btn" title="Upload Video">' +
            '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>' +
          '</button>' +
          '<input type="file" id="nav-stream-chat-upload-input" accept="image/*" multiple style="display:none">' +
          '<input type="file" id="nav-stream-chat-video-input" accept="video/*" style="display:none">' +
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

    // ───── Stream Channel button (shows when user has joined a stream channel) ─────
    // Order in nav-right: [stream-manage-nav-btn] [stream-channel-nav-btn] [notif-wrapper] ...
    if (!document.getElementById('stream-channel-nav-btn')) {
      const btn = document.createElement('button');
      btn.id = 'stream-channel-nav-btn';
      btn.className = 'stream-channel-nav-btn';
      btn.style.display = 'none';
      btn.title = 'Stream Channel';
      btn.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M5 3h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-4l-5 4v-4H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/>' +
        '</svg>' +
        '<span class="stream-channel-live-dot"></span>';
      const notifWrap = navRight.querySelector('.notif-wrapper');
      if (notifWrap) navRight.insertBefore(btn, notifWrap);
      else navRight.prepend(btn);
    }

    // Small popup menu shown below the Stream Channel button
    if (!document.getElementById('stream-channel-hub')) {
      const hub = document.createElement('div');
      hub.id = 'stream-channel-hub';
      hub.className = 'stream-channel-hub';
      hub.style.display = 'none';
      hub.innerHTML =
        '<div class="stream-channel-hub-header">' +
          '<span id="stream-channel-hub-title">Stream Channel</span>' +
        '</div>' +
        '<div class="stream-channel-hub-body">' +
          '<button class="btn btn-sm stream-hub-btn" id="stream-hub-chat-btn">' +
            '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
            ' Chat' +
          '</button>' +
          '<button class="btn btn-sm stream-hub-btn" id="stream-hub-watch-btn">' +
            '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>' +
            ' Watch Streams' +
          '</button>' +
          '<button class="btn btn-sm btn-danger stream-hub-btn" id="stream-hub-leave-btn">' +
            '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>' +
            ' Leave Channel' +
          '</button>' +
        '</div>';
      document.body.appendChild(hub);
    }

    // Medium modal showing previews of all streams in the joined channel
    if (!document.getElementById('stream-list-modal')) {
      const modal = document.createElement('div');
      modal.id = 'stream-list-modal';
      modal.className = 'stream-list-modal';
      modal.style.display = 'none';
      modal.innerHTML =
        '<div class="stream-list-overlay" id="stream-list-overlay"></div>' +
        '<div class="stream-list-window">' +
          '<div class="stream-list-header">' +
            '<span id="stream-list-title">Live Streams</span>' +
            '<button class="stream-chat-close" id="stream-list-close" title="Close">' +
              '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
            '</button>' +
          '</div>' +
          '<div class="stream-list-body" id="stream-list-body">' +
            '<div class="chat-empty">Loading streams...</div>' +
          '</div>' +
        '</div>';
      document.body.appendChild(modal);
    }

    // Small resizable floating stream viewer (video)
    if (!document.getElementById('floating-stream-viewer')) {
      const viewer = document.createElement('div');
      viewer.id = 'floating-stream-viewer';
      viewer.className = 'floating-stream-viewer';
      viewer.style.display = 'none';
      viewer.innerHTML =
        '<div class="floating-stream-header">' +
          '<span class="floating-stream-title" id="floating-stream-title">Stream</span>' +
          '<div class="floating-stream-actions">' +
            '<button class="floating-stream-icon" id="floating-stream-popout-btn" title="Pop out (fullscreen)">' +
              '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>' +
            '</button>' +
            '<button class="floating-stream-icon" id="floating-stream-close-btn" title="Close">' +
              '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
            '</button>' +
          '</div>' +
        '</div>' +
        '<div class="floating-stream-video-wrap">' +
          '<video id="floating-stream-video" autoplay playsinline></video>' +
        '</div>' +
        '<div class="floating-stream-footer">' +
          '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>' +
          '<input type="range" id="floating-stream-volume" min="0" max="100" value="100" class="floating-stream-volume-slider">' +
        '</div>' +
        '<div class="floating-stream-popout-overlay" id="floating-stream-popout-overlay" style="display:none">' +
          '<video id="floating-stream-popout-video" autoplay playsinline></video>' +
          '<button class="floating-stream-popout-close" id="floating-stream-popout-close" title="Exit fullscreen">' +
            '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
          '</button>' +
        '</div>';
      document.body.appendChild(viewer);
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
    // Restore persisted position/size before showing.
    _applyLayout(panel, CHAT_WINDOW_LAYOUT_KEY, { left: window.innerWidth - 340, top: 80, width: 320, height: 440 });
    panel.style.display = 'flex';
    _writeWindowsOpen({ chat: true });
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
    if (data.gifUrl) contentHTML += '<div class="msg-gif-wrap"><img class="msg-gif lightbox-trigger" src="' + _esc(data.gifUrl) + '" alt="GIF" loading="lazy" data-src="' + _esc(data.gifUrl) + '"></div>';
    if (data.text) contentHTML += '<div class="msg-text">' + _esc(data.text) + (data.edited ? '<span class="msg-edited-tag">(edited)</span>' : '') + '</div>';
    if (data.images && data.images.length) {
      contentHTML += '<div class="msg-images' + (data.images.length === 1 ? ' single' : '') + '">' +
        data.images.map(url => '<img class="msg-image lightbox-trigger" src="' + _esc(url) + '" alt="" loading="lazy" data-src="' + _esc(url) + '">').join('') +
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

  let _navStreamFiles = [];
  let _navStreamVideo = null;

  function _renderNavStreamStaging() {
    const el = document.getElementById('nav-stream-chat-staging');
    if (!el) return;
    const parts = [];
    if (_navStreamFiles.length) parts.push(_navStreamFiles.length + ' image(s) ready');
    if (_navStreamVideo) parts.push('1 video ready');
    if (!parts.length) { el.style.display = 'none'; el.textContent = ''; return; }
    el.style.display = 'block';
    el.textContent = parts.join(' \u2022 ');
  }

  async function _uploadToCloudinary(file, kind, onProgress) {
    // kind = 'image' | 'video'. Uses XHR for timeout + progress + retries.
    const endpoint = 'https://api.cloudinary.com/v1_1/' + CLOUDINARY_CLOUD + '/' + kind + '/upload';
    const tryOnce = () => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', endpoint);
      xhr.timeout = kind === 'video' ? 120000 : 45000;
      xhr.upload.onprogress = e => { if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        try {
          const d = JSON.parse(xhr.responseText || '{}');
          if (xhr.status >= 200 && xhr.status < 300 && d.secure_url) resolve(d.secure_url);
          else reject(new Error(d.error?.message || ('HTTP ' + xhr.status)));
        } catch (e) { reject(e); }
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.ontimeout = () => reject(new Error('Upload timed out'));
      const fd = new FormData();
      fd.append('file', file);
      fd.append('upload_preset', CLOUDINARY_PRESET);
      xhr.send(fd);
    });
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await tryOnce(); }
      catch (e) {
        lastErr = e;
        if (attempt < 2) await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
      }
    }
    throw lastErr || new Error('Upload failed');
  }

  async function _sendNavStreamMessage() {
    if (!_navStreamChatCurrentUser) return;
    // Prefer joined-channel context (user can chat without streaming).
    // Fall back to stream state for the streamer themselves.
    const joined = _readJoinedChannel();
    const state = _readStreamState();
    const serverId = joined?.serverId || (state && state.live && state.serverId);
    const channelId = joined?.channelId || (state && state.live && state.channelId);
    if (!serverId || !channelId) return;

    const input = document.getElementById('nav-stream-chat-input');
    if (!input) return;
    const text = input.value.trim();
    const hasImages = _navStreamFiles.length > 0;
    const hasVideo = !!_navStreamVideo;
    if (!text && !hasImages && !hasVideo) return;

    // Snapshot the input so we can restore on failure.
    input.value = '';
    const sendBtn = document.getElementById('nav-stream-chat-send');
    if (sendBtn) sendBtn.disabled = true;

    let imageUrls = [];
    let videoUrl = '';
    try {
      if (hasImages) {
        imageUrls = await Promise.all(_navStreamFiles.map(f => _uploadToCloudinary(f, 'image')));
      }
      if (hasVideo) {
        videoUrl = await _uploadToCloudinary(_navStreamVideo, 'video');
      }
    } catch (err) {
      console.error('Upload failed:', err);
      showToast('Upload failed: ' + (err.message || 'unknown error'), 'error');
      input.value = text;
      if (sendBtn) sendBtn.disabled = false;
      return;
    }

    _navStreamFiles = [];
    _navStreamVideo = null;
    _renderNavStreamStaging();

    const msgData = {
      uid: _navStreamChatCurrentUser.uid,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    if (text) msgData.text = text;
    if (imageUrls.length) msgData.images = imageUrls;
    if (videoUrl) msgData.videoUrl = videoUrl;
    if (_navStreamReplyState) {
      msgData.replyTo = _navStreamReplyState;
      _navCancelReply();
    }
    try {
      await db.collection('servers').doc(serverId)
        .collection('channels').doc(channelId)
        .collection('messages')
        .add(msgData);
    } catch (e) {
      console.error('Send failed:', e);
      input.value = text;
      showToast('Failed to send message.', 'error');
    } finally {
      if (sendBtn) sendBtn.disabled = false;
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
      sessionStorage.setItem('_siteNav', '1');
      window.location.href = 'messenger.html?dm=' + encodeURIComponent(uid);
    });
    document.getElementById('nav-popup-view-more').addEventListener('click', () => {
      overlay.classList.remove('open');
      sessionStorage.setItem('_siteNav', '1');
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
      // Don't auto-close nav-stream-chat-panel here — the user may have
      // joined a stream channel without starting a broadcast, and chat
      // should stay available for them. The channel hub's Leave button or
      // the chat window's close button are the only ways to close it.
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
      // If navigating to another page on this site, skip going offline.
      // Also cancel the RTDB onDisconnect so the server doesn't mark us
      // offline for the brief moment the websocket is closed between pages.
      if (sessionStorage.getItem('_siteNav')) {
        sessionStorage.removeItem('_siteNav');
        try { if (presenceRef) presenceRef.onDisconnect().cancel(); } catch (_) {}
        return;
      }
      _pageClosing = true;
      clearTimeout(_awayTimer);
      // Actually going offline — auto-leave any stream channel so we don't
      // appear as a ghost participant after the browser closes.
      try { localStorage.removeItem(JOINED_CHANNEL_KEY); } catch (_) {}
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

    // Flag same-site link clicks so _goOffline knows not to write offline.
    // Also cancel the RTDB onDisconnect right now — this gives it time to
    // flush over the websocket before the navigation actually severs it,
    // preventing a brief "offline" flash for friends/observers.
    document.addEventListener('click', e => {
      const a = e.target.closest('a[href]');
      if (a && a.origin === location.origin) {
        sessionStorage.setItem('_siteNav', '1');
        try { if (presenceRef) presenceRef.onDisconnect().cancel(); } catch (_) {}
      }
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

  /* ═════════════════════════════════════════════════════════════════════
     STREAM CHANNEL HUB — "join a channel like in Discord" system.
     Works on every page that loads nav.js. State is persisted in
     localStorage so the user stays in their channel across navigations.
     ═════════════════════════════════════════════════════════════════════ */

  const JOINED_CHANNEL_KEY = 'rps_joined_channel_v1';
  const CHAT_WINDOW_LAYOUT_KEY = 'rps_chat_window_v1';
  const VIEWER_WINDOW_LAYOUT_KEY = 'rps_stream_viewer_v1';
  const VIEWER_VOLUME_KEY = 'rps_stream_viewer_volume_v1';
  const WINDOWS_OPEN_KEY = 'rps_windows_open_v1';

  /* ── Cross-page window open/close persistence ────────────────────────
     Tracks which floating windows were open so they reappear when the
     user navigates to another page. { chat, viewer, viewerStream, manage } */
  function _readWindowsOpen() {
    try { return JSON.parse(localStorage.getItem(WINDOWS_OPEN_KEY) || '{}') || {}; }
    catch (_) { return {}; }
  }
  function _writeWindowsOpen(patch) {
    const s = _readWindowsOpen();
    Object.assign(s, patch);
    try { localStorage.setItem(WINDOWS_OPEN_KEY, JSON.stringify(s)); } catch (_) {}
  }

  const _channelChangeListeners = new Set();
  let _hubStreamsUnsub = null;          // onSnapshot for the list modal
  let _hubPreviewRooms = new Map();     // uid -> LiveKit room (preview)
  let _viewerRoom = null;               // LiveKit room for the active floating viewer
  let _viewerCurrentStream = null;      // { uid, username, livekitRoom, livekitUrl }

  function _readJoinedChannel() {
    try { return JSON.parse(localStorage.getItem(JOINED_CHANNEL_KEY) || 'null'); }
    catch (_) { return null; }
  }
  function _writeJoinedChannel(ch) {
    try {
      if (ch) localStorage.setItem(JOINED_CHANNEL_KEY, JSON.stringify(ch));
      else localStorage.removeItem(JOINED_CHANNEL_KEY);
    } catch (_) {}
    _channelChangeListeners.forEach(fn => { try { fn(ch); } catch (_) {} });
    _refreshChannelHubUI();
  }

  function _joinChannel(serverId, channelId, channelName) {
    if (!serverId || !channelId) return;
    const prev = _readJoinedChannel();
    const isNew = !prev || prev.serverId !== serverId || prev.channelId !== channelId;
    _writeJoinedChannel({
      serverId,
      channelId,
      channelName: channelName || 'Streaming Channel',
      joinedAt: Date.now()
    });
    if (isNew) _showJoinedChannelToast(channelName || 'Streaming Channel');
  }
  function _leaveChannel() {
    // Close any open floating windows and stop all previews/viewer room.
    _closeFloatingStreamViewer();
    _closeStreamListModal();
    const chatPanel = document.getElementById('nav-stream-chat-panel');
    if (chatPanel) chatPanel.style.display = 'none';
    if (_navStreamChatUnsub) { _navStreamChatUnsub(); _navStreamChatUnsub = null; }
    _writeWindowsOpen({ chat: false });
    _writeJoinedChannel(null);
  }

  function _refreshChannelHubUI() {
    const btn = document.getElementById('stream-channel-nav-btn');
    if (!btn) return;
    const ch = _readJoinedChannel();
    btn.style.display = ch ? 'inline-flex' : 'none';
    btn.title = ch ? ('In channel: ' + (ch.channelName || 'Streaming Channel')) : 'Stream Channel';
    // Hide the hub popup too if we've just left.
    if (!ch) {
      const hub = document.getElementById('stream-channel-hub');
      if (hub) hub.style.display = 'none';
    }
  }

  function _positionHub() {
    const btn = document.getElementById('stream-channel-nav-btn');
    const hub = document.getElementById('stream-channel-hub');
    if (!btn || !hub) return;
    const rect = btn.getBoundingClientRect();
    const hubW = 220;
    let left = rect.right - hubW;
    if (left < 8) left = 8;
    if (left + hubW > window.innerWidth - 8) left = window.innerWidth - hubW - 8;
    hub.style.left = left + 'px';
    hub.style.top = (rect.bottom + 8) + 'px';
  }

  function _wireChannelHub() {
    const btn = document.getElementById('stream-channel-nav-btn');
    const hub = document.getElementById('stream-channel-hub');
    if (!btn || !hub) return;

    btn.addEventListener('click', e => {
      e.stopPropagation();
      const open = hub.style.display === 'block';
      hub.style.display = open ? 'none' : 'block';
      if (!open) {
        _positionHub();
        const ch = _readJoinedChannel();
        const title = document.getElementById('stream-channel-hub-title');
        if (title) title.textContent = ch ? (ch.channelName || 'Stream Channel') : 'Stream Channel';
      }
    });

    document.addEventListener('click', e => {
      if (hub.style.display !== 'block') return;
      if (hub.contains(e.target) || btn.contains(e.target)) return;
      hub.style.display = 'none';
    });
    window.addEventListener('resize', _positionHub);

    const chatBtn = document.getElementById('stream-hub-chat-btn');
    if (chatBtn) chatBtn.addEventListener('click', () => {
      hub.style.display = 'none';
      const ch = _readJoinedChannel();
      if (!ch) { showToast('You are not in a stream channel.', 'info'); return; }
      _openNavStreamChat({ serverId: ch.serverId, channelId: ch.channelId, channelName: ch.channelName });
    });

    const watchBtn = document.getElementById('stream-hub-watch-btn');
    if (watchBtn) watchBtn.addEventListener('click', () => {
      hub.style.display = 'none';
      _openStreamListModal();
    });

    const leaveBtn = document.getElementById('stream-hub-leave-btn');
    if (leaveBtn) leaveBtn.addEventListener('click', () => {
      hub.style.display = 'none';
      _leaveChannel();
      showToast('Left stream channel.', 'info');
    });

    // Cross-tab sync
    window.addEventListener('storage', e => {
      if (e.key === JOINED_CHANNEL_KEY) {
        _refreshChannelHubUI();
        _channelChangeListeners.forEach(fn => {
          try { fn(_readJoinedChannel()); } catch (_) {}
        });
      }
    });

    _refreshChannelHubUI();
  }

  /* ── Stream list modal (previews of all live streams in the joined channel) ── */

  function _openStreamListModal() {
    const modal = document.getElementById('stream-list-modal');
    const body = document.getElementById('stream-list-body');
    if (!modal || !body) return;
    const ch = _readJoinedChannel();
    if (!ch) { showToast('You are not in a stream channel.', 'info'); return; }
    modal.style.display = 'flex';
    const title = document.getElementById('stream-list-title');
    if (title) title.textContent = 'Live Streams — ' + (ch.channelName || 'Streaming Channel');
    body.innerHTML = '<div class="chat-empty">Loading streams...</div>';

    if (_hubStreamsUnsub) { _hubStreamsUnsub(); _hubStreamsUnsub = null; }
    const ref = db.collection('servers').doc(ch.serverId)
      .collection('channels').doc(ch.channelId)
      .collection('streams');

    _hubStreamsUnsub = ref.onSnapshot(snap => {
      if (snap.empty) {
        body.innerHTML = '<div class="chat-empty">No one is streaming in this channel right now.</div>';
        _stopAllPreviewRooms();
        return;
      }
      // Render list
      body.innerHTML = '';
      const seenUids = new Set();
      snap.forEach(doc => {
        const data = doc.data() || {};
        const uid = doc.id;
        seenUids.add(uid);
        const card = document.createElement('div');
        card.className = 'stream-list-card';
        card.setAttribute('data-stream-uid', uid);
        card.innerHTML =
          '<div class="stream-list-card-video-wrap">' +
            '<video autoplay playsinline muted></video>' +
            '<span class="stream-list-live-dot"></span>' +
          '</div>' +
          '<div class="stream-list-card-bar">' +
            '<span class="stream-list-card-name">' + _esc(data.username || 'Someone') + '</span>' +
          '</div>';
        card.addEventListener('click', () => {
          _closeStreamListModal();
          _openFloatingStreamViewer({
            uid,
            username: data.username || 'Someone',
            livekitRoom: data.livekitRoom,
            livekitUrl: data.livekitUrl
          });
        });
        body.appendChild(card);
        // Kick off a muted preview LiveKit connection
        _startPreviewRoom(uid, data);
      });
      // Disconnect any preview rooms that no longer match live streams
      for (const [uid, room] of _hubPreviewRooms) {
        if (!seenUids.has(uid)) {
          try { room.disconnect(); } catch (_) {}
          _hubPreviewRooms.delete(uid);
        }
      }
    });
  }

  function _closeStreamListModal() {
    const modal = document.getElementById('stream-list-modal');
    if (modal) modal.style.display = 'none';
    if (_hubStreamsUnsub) { _hubStreamsUnsub(); _hubStreamsUnsub = null; }
    _stopAllPreviewRooms();
  }

  function _stopAllPreviewRooms() {
    for (const [uid, room] of _hubPreviewRooms) {
      try { room.disconnect(); } catch (_) {}
    }
    _hubPreviewRooms.clear();
  }

  async function _startPreviewRoom(uid, data) {
    if (_hubPreviewRooms.has(uid)) return;
    if (typeof LivekitClient === 'undefined') return;
    if (!data.livekitRoom || !data.livekitUrl) return;
    try {
      const token = await _getNavLiveKitToken(data.livekitRoom, ':p' + uid.slice(0, 4));
      const room = new LivekitClient.Room({ adaptiveStream: true, dynacast: false });
      _hubPreviewRooms.set(uid, room);
      room.on(LivekitClient.RoomEvent.TrackSubscribed, track => {
        if (track.kind !== LivekitClient.Track.Kind.Video) return;
        const card = document.querySelector('.stream-list-card[data-stream-uid="' + uid + '"] video');
        if (card) { track.attach(card); card.play().catch(() => {}); }
      });
      room.on(LivekitClient.RoomEvent.Disconnected, () => { _hubPreviewRooms.delete(uid); });
      await room.connect(data.livekitUrl, token, { rtcConfig: { iceTransportPolicy: 'relay' } });
    } catch (err) {
      console.error('Preview LiveKit error:', err);
      _hubPreviewRooms.delete(uid);
    }
  }

  async function _getNavLiveKitToken(roomName, identitySuffix) {
    const user = auth.currentUser;
    if (!user) throw new Error('Not signed in');
    const idToken = await user.getIdToken(false);
    const params = new URLSearchParams({ roomName, canPublish: '0' });
    if (identitySuffix) params.set('identitySuffix', identitySuffix);
    const res = await fetch('/livekit-token?' + params.toString(), {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + idToken }
    });
    if (!res.ok) throw new Error('Token ' + res.status);
    return (await res.json()).token;
  }

  /* ── Floating stream viewer (small, draggable, resizable) ── */

  async function _openFloatingStreamViewer(stream) {
    const viewer = document.getElementById('floating-stream-viewer');
    const video = document.getElementById('floating-stream-video');
    const title = document.getElementById('floating-stream-title');
    if (!viewer || !video) return;

    // Restore position/size
    _applyLayout(viewer, VIEWER_WINDOW_LAYOUT_KEY, { left: 20, top: 80, width: 360, height: 260 });
    viewer.style.display = 'flex';
    if (title) title.textContent = (stream.username || 'Stream');
    _writeWindowsOpen({ viewer: true, viewerStream: {
      uid: stream.uid, username: stream.username,
      livekitRoom: stream.livekitRoom, livekitUrl: stream.livekitUrl
    } });

    // Disconnect any previous viewer room
    if (_viewerRoom) { try { _viewerRoom.disconnect(); } catch (_) {} _viewerRoom = null; }
    _viewerCurrentStream = stream;

    if (typeof LivekitClient === 'undefined') {
      showToast('Stream SDK not loaded yet.', 'error');
      return;
    }
    if (!stream.livekitRoom || !stream.livekitUrl) {
      showToast('Stream is not ready yet.', 'info');
      return;
    }

    try {
      const token = await _getNavLiveKitToken(stream.livekitRoom, ':f' + stream.uid.slice(0, 4));
      const room = new LivekitClient.Room({ adaptiveStream: true, dynacast: false });
      _viewerRoom = room;
      room.on(LivekitClient.RoomEvent.TrackSubscribed, track => {
        if (track.kind !== LivekitClient.Track.Kind.Video) return;
        track.attach(video);
        const po = document.getElementById('floating-stream-popout-video');
        if (po) track.attach(po);
        video.play().catch(() => {});
      });
      room.on(LivekitClient.RoomEvent.Disconnected, () => { if (_viewerRoom === room) _viewerRoom = null; });
      await room.connect(stream.livekitUrl, token, { rtcConfig: { iceTransportPolicy: 'relay' } });
    } catch (err) {
      console.error('Viewer LiveKit error:', err);
      showToast('Failed to load stream.', 'error');
    }

    // Apply persisted volume
    try {
      const v = parseFloat(localStorage.getItem(VIEWER_VOLUME_KEY));
      if (!isNaN(v)) {
        video.volume = Math.max(0, Math.min(1, v));
        const slider = document.getElementById('floating-stream-volume');
        if (slider) slider.value = String(Math.round(video.volume * 100));
      }
    } catch (_) {}
  }

  function _closeFloatingStreamViewer() {
    const viewer = document.getElementById('floating-stream-viewer');
    const video = document.getElementById('floating-stream-video');
    const overlay = document.getElementById('floating-stream-popout-overlay');
    if (viewer) viewer.style.display = 'none';
    if (overlay) overlay.style.display = 'none';
    if (video) { try { video.pause(); } catch (_) {} video.srcObject = null; }
    const po = document.getElementById('floating-stream-popout-video');
    if (po) { try { po.pause(); } catch (_) {} po.srcObject = null; }
    if (_viewerRoom) { try { _viewerRoom.disconnect(); } catch (_) {} _viewerRoom = null; }
    _viewerCurrentStream = null;
    _writeWindowsOpen({ viewer: false, viewerStream: null });
  }

  function _wireFloatingStreamViewer() {
    const viewer = document.getElementById('floating-stream-viewer');
    if (!viewer) return;
    const header = viewer.querySelector('.floating-stream-header');
    if (header) _makeDraggable(viewer, header);
    _trackLayout(viewer, VIEWER_WINDOW_LAYOUT_KEY);

    const closeBtn = document.getElementById('floating-stream-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', _closeFloatingStreamViewer);

    const popoutBtn = document.getElementById('floating-stream-popout-btn');
    const overlay = document.getElementById('floating-stream-popout-overlay');
    const popoutClose = document.getElementById('floating-stream-popout-close');
    if (popoutBtn && overlay) popoutBtn.addEventListener('click', () => {
      overlay.style.display = 'flex';
    });
    if (popoutClose && overlay) popoutClose.addEventListener('click', () => {
      overlay.style.display = 'none';
    });

    const slider = document.getElementById('floating-stream-volume');
    const video = document.getElementById('floating-stream-video');
    const poVideo = document.getElementById('floating-stream-popout-video');
    if (slider && video) {
      slider.addEventListener('input', () => {
        const v = Math.max(0, Math.min(1, Number(slider.value) / 100));
        video.volume = v;
        if (poVideo) poVideo.volume = v;
        try { localStorage.setItem(VIEWER_VOLUME_KEY, String(v)); } catch (_) {}
      });
    }

    // Escape closes whichever window is on top (popout > viewer > list modal)
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (overlay && overlay.style.display === 'flex') { overlay.style.display = 'none'; return; }
      if (viewer.style.display === 'flex') { _closeFloatingStreamViewer(); return; }
      const list = document.getElementById('stream-list-modal');
      if (list && list.style.display === 'flex') { _closeStreamListModal(); return; }
      const chat = document.getElementById('nav-stream-chat-panel');
      if (chat && chat.style.display === 'flex') {
        chat.style.display = 'none';
        if (_navStreamChatUnsub) { _navStreamChatUnsub(); _navStreamChatUnsub = null; }
        _writeWindowsOpen({ chat: false });
      }
    });
  }

  function _wireStreamListModal() {
    const modal = document.getElementById('stream-list-modal');
    if (!modal) return;
    const closeBtn = document.getElementById('stream-list-close');
    const overlay = document.getElementById('stream-list-overlay');
    if (closeBtn) closeBtn.addEventListener('click', _closeStreamListModal);
    if (overlay) overlay.addEventListener('click', _closeStreamListModal);
  }

  /* ── Layout persistence helpers ── */

  function _applyLayout(el, key, defaults) {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) {}
    const layout = { ...defaults, ...(data || {}) };
    // Clamp to viewport so the window is always visible.
    const maxLeft = Math.max(0, window.innerWidth - 80);
    const maxTop = Math.max(0, window.innerHeight - 80);
    el.style.left = Math.max(0, Math.min(layout.left, maxLeft)) + 'px';
    el.style.top = Math.max(0, Math.min(layout.top, maxTop)) + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    if (layout.width) el.style.width = layout.width + 'px';
    if (layout.height) el.style.height = layout.height + 'px';
  }

  function _trackLayout(el, key) {
    const save = () => {
      try {
        const left = parseInt(el.style.left, 10) || el.offsetLeft || 0;
        const top = parseInt(el.style.top, 10) || el.offsetTop || 0;
        const width = el.offsetWidth;
        const height = el.offsetHeight;
        localStorage.setItem(key, JSON.stringify({ left, top, width, height }));
      } catch (_) {}
    };
    // Size changes → ResizeObserver
    try {
      const ro = new ResizeObserver(save);
      ro.observe(el);
    } catch (_) {}
    // Position changes are saved by _makeDraggable on mouseup — but we also
    // run save() on mouseup/touchend here as a safety net in case the drag
    // handler isn't wired.
    el.addEventListener('mouseup', save);
    el.addEventListener('touchend', save);
  }

  /* ── Public API for messenger.js ── */
  function _onChannelChange(fn) {
    _channelChangeListeners.add(fn);
    // Also immediately fire with current state for easy subscription.
    try { fn(_readJoinedChannel()); } catch (_) {}
    return () => _channelChangeListeners.delete(fn);
  }

  /* ── Joined-channel toast popup ── */
  let _joinToastTimer = null;
  function _showJoinedChannelToast(channelName) {
    let el = document.getElementById('joined-channel-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'joined-channel-toast';
      el.className = 'joined-channel-toast';
      el.innerHTML =
        '<div class="joined-channel-toast-icon">' +
          '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>' +
        '</div>' +
        '<div class="joined-channel-toast-body">' +
          '<div class="joined-channel-toast-title">Joined stream channel</div>' +
          '<div class="joined-channel-toast-name" id="joined-channel-toast-name"></div>' +
        '</div>' +
        '<button class="joined-channel-toast-close" id="joined-channel-toast-close" title="Dismiss">' +
          '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
        '</button>';
      document.body.appendChild(el);
      el.querySelector('#joined-channel-toast-close').addEventListener('click', () => {
        el.classList.remove('visible');
        if (_joinToastTimer) { clearTimeout(_joinToastTimer); _joinToastTimer = null; }
      });
    }
    el.querySelector('#joined-channel-toast-name').textContent = channelName || 'Streaming Channel';
    // Trigger the slide-in; use rAF to ensure transition fires.
    el.classList.remove('visible');
    requestAnimationFrame(() => el.classList.add('visible'));
    if (_joinToastTimer) clearTimeout(_joinToastTimer);
    _joinToastTimer = setTimeout(() => {
      el.classList.remove('visible');
      _joinToastTimer = null;
    }, 2000);
  }

  /* ── Shared lightbox (available on every page) ── */
  function _ensureLightbox() {
    if (document.getElementById('nav-lightbox')) return;
    const overlay = document.createElement('div');
    overlay.id = 'nav-lightbox';
    overlay.className = 'lightbox-overlay';
    overlay.innerHTML =
      '<button class="lightbox-close" id="nav-lightbox-close" title="Close">\u2715</button>' +
      '<div class="lightbox-controls">' +
        '<button class="lightbox-ctrl-btn" id="nav-lightbox-zoom-out" title="Zoom out">\u2212</button>' +
        '<span class="lightbox-zoom-level" id="nav-lightbox-zoom-level">100%</span>' +
        '<button class="lightbox-ctrl-btn" id="nav-lightbox-zoom-in" title="Zoom in">+</button>' +
      '</div>' +
      '<div class="lightbox-img-wrap">' +
        '<img class="lightbox-img" id="nav-lightbox-img" src="" alt="">' +
      '</div>';
    document.body.appendChild(overlay);

    let scale = 1, panX = 0, panY = 0;
    let dragging = false, dragStart = { x: 0, y: 0 }, panStart = { x: 0, y: 0 };
    const img = document.getElementById('nav-lightbox-img');
    const wrap = overlay.querySelector('.lightbox-img-wrap');
    const zoomLevel = document.getElementById('nav-lightbox-zoom-level');

    function applyTransform() {
      img.style.transform = 'translate(' + panX + 'px, ' + panY + 'px) scale(' + scale + ')';
      if (zoomLevel) zoomLevel.textContent = Math.round(scale * 100) + '%';
      img.style.cursor = scale > 1 ? (dragging ? 'grabbing' : 'grab') : 'default';
    }
    function zoom(delta) {
      scale = Math.max(0.25, Math.min(6, scale + delta));
      if (scale <= 1) { panX = 0; panY = 0; }
      applyTransform();
    }
    function close() {
      overlay.classList.remove('open');
      scale = 1; panX = 0; panY = 0;
      applyTransform();
    }
    document.getElementById('nav-lightbox-close').addEventListener('click', close);
    document.getElementById('nav-lightbox-zoom-in').addEventListener('click', () => zoom(0.5));
    document.getElementById('nav-lightbox-zoom-out').addEventListener('click', () => zoom(-0.5));
    overlay.addEventListener('click', e => { if (e.target === overlay || e.target === wrap) close(); });
    overlay.addEventListener('wheel', e => { e.preventDefault(); zoom(e.deltaY < 0 ? 0.25 : -0.25); }, { passive: false });
    img.addEventListener('mousedown', e => {
      if (scale <= 1) return;
      dragging = true;
      dragStart = { x: e.clientX, y: e.clientY };
      panStart = { x: panX, y: panY };
      applyTransform();
      e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      panX = panStart.x + (e.clientX - dragStart.x);
      panY = panStart.y + (e.clientY - dragStart.y);
      applyTransform();
    });
    window.addEventListener('mouseup', () => { if (dragging) { dragging = false; applyTransform(); } });
    document.addEventListener('keydown', e => {
      if (!overlay.classList.contains('open')) return;
      if (e.key === 'Escape') close();
      else if (e.key === '+' || e.key === '=') zoom(0.5);
      else if (e.key === '-') zoom(-0.5);
    });

    overlay._openWith = src => {
      img.src = src;
      scale = 1; panX = 0; panY = 0;
      applyTransform();
      overlay.classList.add('open');
    };
  }
  function _openNavLightbox(src) {
    _ensureLightbox();
    document.getElementById('nav-lightbox')._openWith(src);
  }
  // Delegated click on any chat container for .lightbox-trigger
  function _wireLightboxDelegation() {
    if (document.body.dataset.rpsLightboxWired === '1') return;
    document.body.dataset.rpsLightboxWired = '1';
    document.addEventListener('click', e => {
      const t = e.target.closest && e.target.closest('.lightbox-trigger');
      if (!t) return;
      // Only intercept if the image is inside a stream/chat/nav chat container.
      const host = t.closest('#nav-stream-chat-messages, #stream-chat-messages, #stream-inline-chat-messages, #chat-messages');
      if (!host) return;
      // On messenger page, messenger.js has its own lightbox; use it when present.
      if (host.id === 'chat-messages' && typeof window._rpsOpenLightbox === 'function') {
        return; // messenger's listener handles it
      }
      e.preventDefault();
      _openNavLightbox(t.dataset.src || t.src);
    });
  }

  return {
    init,
    initStreamManager: _initStreamManager,
    joinChannel: _joinChannel,
    leaveChannel: _leaveChannel,
    getJoinedChannel: _readJoinedChannel,
    onChannelChange: _onChannelChange,
    uploadToCloudinary: _uploadToCloudinary,
    openLightbox: _openNavLightbox
  };
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
