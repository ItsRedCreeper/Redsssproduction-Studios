/* ───────────────────────────────────────────────
   RedsssMessenger — Main JS
   Initialized after auth resolves via Nav.init().
   DMs, servers, channels, real-time chat.
   Profile cache: messages store uid only, display
   resolved from cache for always-fresh names/avatars.
   ─────────────────────────────────────────────── */

const Messenger = (() => {
  let currentUser = null;
  let userProfile = null;
  let chatUnsub = null;
  let currentChat = null;   // { type: 'dm', friendUid } | { type: 'channel', serverId, channelId }
  let currentServerId = null;
  let currentServerOwner = null;

  // Profile cache — uid → { username, avatar, effectiveStatus }
  const profileCache = new Map();
  let _serverImageBlob = null;
  let _replyState = null; // { uid, username, text, docId } | null
  let _stagedFiles = [];         // File objects awaiting send
  let _stagedObjectUrls = [];    // Blob URLs for staging previews
  let _lightboxScale = 1;        // Current lightbox zoom
  let _lightboxPanX = 0, _lightboxPanY = 0;
  let _lightboxDrag = false, _lightboxDragStart = { x: 0, y: 0 }, _lightboxPanStart = { x: 0, y: 0 };

  // Server GIF library — per-server gif lists
  const _serverGifUnsubs = new Map(); // serverId → unsub fn
  const _serverGifs     = new Map(); // serverId → [{url, uploadedBy, createdAt}]
  let _myServerIds = new Set();
  // Server Image library
  const _serverImageUnsubs = new Map();
  const _serverImages      = new Map();
  // Server Video library
  const _serverVideoUnsubs = new Map();
  // DM media libraries — all friend convos
  const _dmMediaImages = new Map(); // convoId → [{id, url, ...}]
  const _dmMediaVideos = new Map();
  const _dmMediaGifs   = new Map();
  const _dmMediaUnsubs = new Map(); // convoId → combined unsub fn
  const _serverVideos      = new Map();
  // Staged video
  let _stagedVideo    = null;
  let _stagedVideoUrl = null;

  // Picker state
  let _pickerOpen = false;
  let _pickerTab  = 'emoji';

  /* ── Init — called after login ── */
  function init(user, profile) {
    currentUser = user;
    userProfile = profile;

    // Cache self
    profileCache.set(user.uid, {
      username: profile.username,
      avatar: profile.avatar || '',
      effectiveStatus: profile.effectiveStatus || 'online'
    });

    // DM button
    document.getElementById('dm-btn').addEventListener('click', showDMView);

    // Send message
    document.getElementById('chat-send').addEventListener('click', sendMessage);
    document.getElementById('chat-input').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    document.getElementById('reply-cancel').addEventListener('click', _cancelReply);

    // Emoji/GIF picker
    document.getElementById('picker-toggle-btn').addEventListener('click', e => { e.stopPropagation(); _togglePicker(); });
    document.getElementById('img-upload-btn').addEventListener('click', e => { e.stopPropagation(); document.getElementById('gif-upload-input').click(); });
    document.querySelectorAll('.picker-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => _switchPickerTab(btn.dataset.tab));
    });
    document.getElementById('gif-upload-input').addEventListener('change', e => {
      if (e.target.files.length) _addStagedFiles(e.target.files);
      e.target.value = '';
    });
    document.getElementById('video-upload-btn').addEventListener('click', e => { e.stopPropagation(); document.getElementById('video-upload-input').click(); });
    document.getElementById('video-upload-input').addEventListener('change', e => {
      if (e.target.files.length) _addStagedVideo(e.target.files[0]);
      e.target.value = '';
    });
    // Close picker on outside click
    document.addEventListener('click', e => {
      if (_pickerOpen && !document.getElementById('picker-panel').contains(e.target) &&
          e.target.id !== 'picker-toggle-btn' &&
          !e.target.closest('#img-upload-btn') &&
          !e.target.closest('#video-upload-btn')) {
        _closePicker();
      }
    });

    // Lightbox wiring (pan + zoom)
    const lbOverlay = document.getElementById('lightbox');
    const lbImg = document.getElementById('lightbox-img');
    const lbWrap = lbOverlay.querySelector('.lightbox-img-wrap');
    document.getElementById('lightbox-close').addEventListener('click', _closeLightbox);
    document.getElementById('lightbox-zoom-in').addEventListener('click', () => _lightboxZoom(0.5));
    document.getElementById('lightbox-zoom-out').addEventListener('click', () => _lightboxZoom(-0.5));
    lbOverlay.addEventListener('click', e => {
      if (e.target === lbOverlay || e.target === lbWrap) _closeLightbox();
    });
    lbOverlay.addEventListener('wheel', e => {
      e.preventDefault();
      _lightboxZoom(e.deltaY < 0 ? 0.25 : -0.25);
    }, { passive: false });
    // Drag-to-pan
    lbImg.addEventListener('mousedown', e => {
      if (_lightboxScale <= 1) return;
      e.preventDefault();
      _lightboxDrag = true;
      _lightboxDragStart = { x: e.clientX, y: e.clientY };
      _lightboxPanStart = { x: _lightboxPanX, y: _lightboxPanY };
      lbImg.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', e => {
      if (!_lightboxDrag) return;
      _lightboxPanX = _lightboxPanStart.x + (e.clientX - _lightboxDragStart.x);
      _lightboxPanY = _lightboxPanStart.y + (e.clientY - _lightboxDragStart.y);
      _applyLightboxTransform();
    });
    window.addEventListener('mouseup', () => {
      if (_lightboxDrag) { _lightboxDrag = false; lbImg.style.cursor = ''; }
    });
    // Touch-to-pan
    lbImg.addEventListener('touchstart', e => {
      if (_lightboxScale <= 1 || e.touches.length !== 1) return;
      _lightboxDrag = true;
      _lightboxDragStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      _lightboxPanStart = { x: _lightboxPanX, y: _lightboxPanY };
    }, { passive: true });
    lbImg.addEventListener('touchmove', e => {
      if (!_lightboxDrag || e.touches.length !== 1) return;
      _lightboxPanX = _lightboxPanStart.x + (e.touches[0].clientX - _lightboxDragStart.x);
      _lightboxPanY = _lightboxPanStart.y + (e.touches[0].clientY - _lightboxDragStart.y);
      _applyLightboxTransform();
    }, { passive: true });
    lbImg.addEventListener('touchend', () => { _lightboxDrag = false; });

    // Delegated lightbox trigger for images in messages
    document.getElementById('chat-messages').addEventListener('click', e => {
      const t = e.target.closest('.lightbox-trigger');
      if (t) _openLightbox(t.dataset.src || t.src);
    });

    // Create server
    document.getElementById('create-server-btn').addEventListener('click', () => {
      document.getElementById('create-server-modal').classList.add('open');
    });
    document.getElementById('cancel-server-btn').addEventListener('click', () => {
      document.getElementById('create-server-modal').classList.remove('open');
      _resetServerModal();
    });
    document.getElementById('confirm-server-btn').addEventListener('click', createServer);

    // Server image upload
    document.getElementById('server-img-preview').addEventListener('click', () => {
      document.getElementById('server-img-input').click();
    });
    document.getElementById('server-img-input').addEventListener('change', _previewServerImage);

    // Visibility toggle
    document.querySelectorAll('.visibility-opt').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.visibility-opt').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

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

    // Discover button
    const discoverBtn = document.getElementById('discover-btn');
    if (discoverBtn) discoverBtn.addEventListener('click', showDiscover);

    // Stream manager + stream chat window
    document.getElementById('stream-manage-nav-btn').addEventListener('click', _toggleStreamManagePanel);
    document.getElementById('stream-manage-close').addEventListener('click', () => _setStreamManagePanelOpen(false));
    document.getElementById('stream-manage-chat-btn').addEventListener('click', _openStreamChatWindow);
    document.getElementById('stream-manage-snap-btn').addEventListener('click', _captureStreamSnapshot);
    document.getElementById('stream-manage-record-btn').addEventListener('click', _toggleStreamRecording);
    document.getElementById('stream-manage-stop-btn').addEventListener('click', () => {
      if (_streamContext && _streamContext.serverId && _streamContext.channelId) {
        _stopStreaming(_streamContext.serverId, _streamContext.channelId);
      }
    });
    document.getElementById('stream-chat-close').addEventListener('click', () => {
      document.getElementById('stream-chat-window').style.display = 'none';
    });
    document.getElementById('stream-chat-picker-btn').addEventListener('click', () => {
      const picker = document.getElementById('stream-chat-picker');
      picker.style.display = picker.style.display === 'none' ? 'flex' : 'none';
    });
    document.querySelectorAll('.stream-chat-emoji').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = document.getElementById('stream-chat-input');
        input.value += btn.dataset.emoji || '';
        input.focus();
      });
    });
    document.getElementById('stream-chat-upload-btn').addEventListener('click', () => {
      document.getElementById('stream-chat-upload-input').click();
    });
    document.getElementById('stream-chat-video-btn').addEventListener('click', () => {
      document.getElementById('stream-chat-video-input').click();
    });
    document.getElementById('stream-chat-upload-input').addEventListener('change', e => {
      if (e.target.files.length) _addStreamChatFiles(e.target.files);
      e.target.value = '';
    });
    document.getElementById('stream-chat-video-input').addEventListener('change', e => {
      if (e.target.files.length) _addStreamChatVideo(e.target.files[0]);
      e.target.value = '';
    });
    document.getElementById('stream-chat-send').addEventListener('click', _sendStreamChatMessage);
    document.getElementById('stream-chat-input').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _sendStreamChatMessage(); }
    });

    // Initialize
    loadFriends();
    _listenNonFriendDMs();
    loadServers();
    showDMView();

    // Auto-open DM if ?dm=UID is in the URL
    const _dmParam = new URLSearchParams(window.location.search).get('dm');
    if (_dmParam) {
      // Wait for the friend's profile to arrive then open their DM
      let _dmResolved = false;
      const _waitForDM = setInterval(() => {
        const prof = _dmProfiles.get(_dmParam);
        if (prof) {
          _dmResolved = true;
          clearInterval(_waitForDM);
          showDMView();
          openDM(_dmParam, prof);
        }
      }, 100);
      // After 3 seconds, if not found in friends, fetch from Firestore (non-friend DM)
      setTimeout(async () => {
        clearInterval(_waitForDM);
        if (_dmResolved) return;
        try {
          const doc = await db.collection('users').doc(_dmParam).get();
          if (doc.exists) {
            const u = doc.data();
            const prof = { uid: _dmParam, username: u.username || 'User', avatar: u.avatar || '', effectiveStatus: u.effectiveStatus || 'offline' };
            profileCache.set(_dmParam, { username: prof.username, avatar: prof.avatar, effectiveStatus: prof.effectiveStatus });
            showDMView();
            openDM(_dmParam, prof);
          }
        } catch { /* ignore */ }
      }, 3000);
    }
  }

  /* ── DM View ── */
  function showDMView() {
    currentServerId = null;
    _hidePreviewBanner();
    document.querySelectorAll('.server-icon').forEach(s => s.classList.remove('active'));
    document.getElementById('dm-btn').classList.add('active');

    document.getElementById('sidebar-header').textContent = 'Direct Messages';
    document.getElementById('dm-section').style.display = 'flex';
    document.getElementById('channel-section').style.display = 'none';
    document.getElementById('members-sidebar').style.display = 'none';
    document.getElementById('stream-view').style.display = 'none';
    document.getElementById('chat-messages').style.display = '';

    _cleanupStreaming();

    // Track activity
    db.collection('users').doc(currentUser.uid).update({
      'activity.server': null,
      'activity.dm': null
    }).catch(() => {});
  }

  /* ── Friends (for DM list) — per-friend live listeners ── */
  const _dmFriendListeners = new Map();     // uid → Firestore unsubscribe fn
  const _rtdbDMListeners = new Map();        // uid → RTDB off fn
  const _dmProfiles = new Map();             // uid → profile data
  const _rtdbOfflineSet = new Set();         // uids RTDB confirmed offline (takes priority over Firestore)
  const _currentFriendUids = new Set();      // current user's friend uids

  // Periodically re-render so lastSeen staleness is re-evaluated even when Firestore doesn't push
  setInterval(() => {
    if (_dmProfiles.size) _renderDMFriendsList();
  }, 10 * 1000);

  function loadFriends() {
    db.collection('users').doc(currentUser.uid).onSnapshot(doc => {
      if (!doc.exists) return;
      const friendUids = doc.data().friends || [];
      _currentFriendUids.clear();
      friendUids.forEach(uid => _currentFriendUids.add(uid));

      if (!friendUids.length) {
        // Remove friend-related entries, keep non-friend DMs
        const friendKeys = Array.from(_dmFriendListeners.keys());
        _dmFriendListeners.forEach(unsub => unsub());
        _dmFriendListeners.clear();
        _rtdbDMListeners.forEach(off => off());
        _rtdbDMListeners.clear();
        friendKeys.forEach(uid => _dmProfiles.delete(uid));
        _syncDMMediaListeners(new Set());
        _renderDMFriendsList();
        return;
      }

      // Sync DM media listeners for all friend convos
      const _dmConvoIds = new Set(friendUids.map(uid => [currentUser.uid, uid].sort().join('_')));
      _syncDMMediaListeners(_dmConvoIds);

      // Remove stale listeners
      _dmFriendListeners.forEach((unsub, uid) => {
        if (!friendUids.includes(uid)) {
          unsub();
          _dmFriendListeners.delete(uid);
          _dmProfiles.delete(uid);
          const rtdbOff = _rtdbDMListeners.get(uid);
          if (rtdbOff) { rtdbOff(); _rtdbDMListeners.delete(uid); }
        }
      });

      // Add per-friend listeners for new UIDs
      friendUids.forEach(uid => {
        if (_dmFriendListeners.has(uid)) return;
        const unsub = db.collection('users').doc(uid).onSnapshot(d => {
          if (!d.exists) return;
          const data = d.data();
          const effectiveStatus = _rtdbOfflineSet.has(uid) ? 'offline' : (data.effectiveStatus || 'offline');
          _dmProfiles.set(uid, { uid, ...data, effectiveStatus });
          // Update profile cache
          profileCache.set(uid, {
            username: data.username,
            avatar: data.avatar || '',
            effectiveStatus
          });
          _patchRenderedMessages(uid);
          _renderDMFriendsList();
        });
        _dmFriendListeners.set(uid, unsub);
        // RTDB presence listener — detects hard browser close / shutdown
        if (!_rtdbDMListeners.has(uid)) {
          try {
            const presRef = firebase.database().ref('presence/' + uid);
            const rtdbHandler = snap => {
              const val = snap.val();
              if (val && val.online === false) {
                const current = _dmProfiles.get(uid);
                const friendIsAuto = !current || !current.status || current.status === 'auto';
                // Only sync effective offline to Firestore for auto-status users;
                // manual-status users keep their chosen status even when browser is closed.
                if (friendIsAuto) {
                  _rtdbOfflineSet.add(uid);
                  db.collection('users').doc(uid).update({ effectiveStatus: 'offline', online: false }).catch(() => {});
                  if (current) {
                    _dmProfiles.set(uid, { ...current, effectiveStatus: 'offline' });
                    const cached = profileCache.get(uid);
                    if (cached) profileCache.set(uid, { ...cached, effectiveStatus: 'offline' });
                    _patchRenderedMessages(uid);
                    _renderDMFriendsList();
                  }
                }
              } else if (val && val.online === true) {
                _rtdbOfflineSet.delete(uid);
                // Re-read the stored profile with the override removed and re-render
                const cur = _dmProfiles.get(uid);
                if (cur && cur.effectiveStatus === 'offline') {
                  // The Firestore doc likely already has the real status; re-apply it
                  db.collection('users').doc(uid).get().then(docSnap => {
                    if (!docSnap.exists) return;
                    const d = docSnap.data();
                    const realStatus = d.effectiveStatus || 'offline';
                    _dmProfiles.set(uid, { ...cur, effectiveStatus: realStatus });
                    profileCache.set(uid, { username: d.username, avatar: d.avatar || '', effectiveStatus: realStatus });
                    _patchRenderedMessages(uid);
                    _renderDMFriendsList();
                  }).catch(() => {});
                }
              }
            };
            presRef.on('value', rtdbHandler);
            _rtdbDMListeners.set(uid, () => presRef.off('value', rtdbHandler));
          } catch (e) { /* RTDB unavailable */ }
        }
      });
    });
  }

  /* ── Discover non-friend DM conversations ── */
  let _nonFriendDMUnsub = null;
  function _listenNonFriendDMs() {
    if (_nonFriendDMUnsub) { _nonFriendDMUnsub(); _nonFriendDMUnsub = null; }
    _nonFriendDMUnsub = db.collection('dms')
      .where('participants', 'array-contains', currentUser.uid)
      .onSnapshot(snap => {
        snap.docChanges().forEach(change => {
          const data = change.doc.data();
          const otherUid = (data.participants || []).find(p => p !== currentUser.uid);
          if (!otherUid) return;

          if (change.type === 'removed') {
            // Other user left the chat — clean up our side
            if (!_currentFriendUids.has(otherUid)) {
              _dmProfiles.delete(otherUid);
            }
            // If we're currently viewing this DM, close it
            if (currentChat && currentChat.type === 'dm' && currentChat.friendUid === otherUid) {
              if (chatUnsub) { chatUnsub(); chatUnsub = null; }
              currentChat = null;
              document.getElementById('chat-messages').innerHTML = '<div class="chat-empty">This conversation has been deleted.</div>';
              document.getElementById('chat-title').textContent = 'Select a conversation';
              document.getElementById('chat-input-bar').style.display = 'none';
              document.getElementById('leave-chat-btn').style.display = 'none';
              showToast('The other user left the chat.', 'info');
            }
            _renderDMFriendsList();
            return;
          }

          // added or modified — discover new non-friend DMs
          if (_dmProfiles.has(otherUid)) return;
          db.collection('users').doc(otherUid).get().then(uDoc => {
            if (!uDoc.exists) return;
            if (_dmProfiles.has(otherUid)) return;
            const u = uDoc.data();
            _dmProfiles.set(otherUid, { uid: otherUid, ...u, effectiveStatus: u.effectiveStatus || 'offline' });
            profileCache.set(otherUid, { username: u.username, avatar: u.avatar || '', effectiveStatus: u.effectiveStatus || 'offline' });
            _renderDMFriendsList();
          }).catch(() => {});
        });
      });
  }

  function _resolveStatus(profile) {
    const eStatus = profile.effectiveStatus || 'offline';
    if (eStatus === 'offline') return 'offline';
    // Manual status (not auto) — trust effectiveStatus directly; the RTDB offline
    // signal and _goOffline will write 'offline' when they truly disconnect.
    if (profile.status && profile.status !== 'auto') return eStatus;
    // Auto status — fall back to offline if the heartbeat has gone stale
    // (browser throttles background intervals heavily, so use 5-minute threshold)
    if (profile.lastSeen) {
      let ms = null;
      if (profile.lastSeen.toDate) ms = profile.lastSeen.toDate().getTime();
      else if (profile.lastSeen.seconds) ms = profile.lastSeen.seconds * 1000;
      if (ms !== null && Date.now() - ms > 5 * 60 * 1000) return 'offline';
    }
    return eStatus;
  }

  function _renderDMFriendsList() {
    const list = document.getElementById('friends-list');
    const profiles = Array.from(_dmProfiles.values());

    if (!profiles.length) {
      list.innerHTML = '<div class="sidebar-empty">No friends yet</div>';
      return;
    }

    const friends = profiles.filter(f => _currentFriendUids.has(f.uid));
    const nonFriends = profiles.filter(f => !_currentFriendUids.has(f.uid));

    function renderItem(f) {
      const initial = (f.username || 'U').charAt(0).toUpperCase();
      const avatarHtml = f.avatar
        ? '<img src="' + esc(f.avatar) + '" alt="">'
        : initial;
      const eStatus = _resolveStatus(f);

      return '<div class="friend-item" data-uid="' + f.uid + '">' +
        '<div class="friend-avatar">' + avatarHtml +
          '<span class="status-dot ' + eStatus + '"></span>' +
        '</div>' +
        '<div>' +
          '<div class="friend-name">' + esc(f.username) + '</div>' +
          '<div class="friend-status">' + _resolveActivity(f, eStatus) + '</div>' +
        '</div></div>';
    }

    let html = '';
    if (friends.length) {
      html += friends.map(renderItem).join('');
    }
    if (nonFriends.length) {
      html += '<div class="dm-category-label">Direct Messages</div>';
      html += nonFriends.map(renderItem).join('');
    }
    list.innerHTML = html;

    list.querySelectorAll('.friend-item').forEach(el => {
      el.addEventListener('click', () => openDM(el.dataset.uid, _dmProfiles.get(el.dataset.uid)));
    });
  }

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

  function _statusLabel(status) {
    const labels = { online: 'Online', away: 'Away', dnd: 'Do Not Disturb', offline: 'Offline' };
    return labels[status] || 'Offline';
  }

  function filterFriends() {
    const q = document.getElementById('friend-search').value.toLowerCase();
    document.querySelectorAll('#friends-list .friend-item').forEach(el => {
      const name = el.querySelector('.friend-name').textContent.toLowerCase();
      el.style.display = name.includes(q) ? '' : 'none';
    });
  }

  /* ── DM Chat ── */
  function openDM(friendUid, profile) {
    if (chatUnsub) { chatUnsub(); chatUnsub = null; }
    _cleanupStreaming();

    currentChat = { type: 'dm', friendUid };

    document.querySelectorAll('.friend-item').forEach(f => f.classList.remove('active'));
    const el = document.querySelector('.friend-item[data-uid="' + friendUid + '"]');
    if (el) el.classList.add('active');

    document.getElementById('chat-title').textContent = profile ? profile.username : 'Chat';
    document.getElementById('chat-input-bar').style.display = 'flex';
    document.getElementById('stream-view').style.display = 'none';
    document.getElementById('chat-messages').style.display = '';
    document.getElementById('members-sidebar').style.display = 'none';

    // Show leave chat button only for non-friends
    const leaveBtn = document.getElementById('leave-chat-btn');
    if (leaveBtn) {
      if (!_currentFriendUids.has(friendUid)) {
        leaveBtn.style.display = '';
        leaveBtn.onclick = () => _confirmLeaveChat(friendUid, profile ? profile.username : 'this user');
      } else {
        leaveBtn.style.display = 'none';
        leaveBtn.onclick = null;
      }
    }

    // Track activity
    const dmName = profile ? (profile.username || '') : '';
    db.collection('users').doc(currentUser.uid).update({
      'activity.dm': dmName,
      'activity.server': null
    }).catch(() => {});

    // DM conversation ID (sorted UIDs)
    const convoId = [currentUser.uid, friendUid].sort().join('_');

    const messagesEl = document.getElementById('chat-messages');
    messagesEl.innerHTML = '<div class="chat-empty">Loading...</div>';

    let _isChatNew = true;
    chatUnsub = db.collection('dms').doc(convoId).collection('messages')
      .orderBy('createdAt', 'asc')
      .limitToLast(100)
      .onSnapshot(snap => {
        if (_isChatNew) { _isChatNew = false; messagesEl.innerHTML = ''; }
        if (snap.empty) { messagesEl.innerHTML = '<div class="chat-empty">No messages yet. Say hi!</div>'; return; }
        const emptyEl = messagesEl.querySelector('.chat-empty');
        if (emptyEl) emptyEl.remove();
        const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 100;
        let hasAdded = false;
        snap.docChanges().forEach(change => {
          const { doc, type } = change;
          if (type === 'added') {
            const el = renderMessage(doc.data(), doc.id, doc.ref);
            el.dataset.msgId = doc.id;
            messagesEl.appendChild(el);
            hasAdded = true;
          } else if (type === 'modified') {
            const el = renderMessage(doc.data(), doc.id, doc.ref);
            el.dataset.msgId = doc.id;
            messagesEl.querySelector('[data-msg-id="' + doc.id + '"]')?.replaceWith(el);
          } else if (type === 'removed') {
            messagesEl.querySelector('[data-msg-id="' + doc.id + '"]')?.remove();
          }
        });
        if (hasAdded && nearBottom) requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });
      });
  }

  /* ── Servers ── */
  function loadServers() {
    db.collection('servers')
      .where('members', 'array-contains', currentUser.uid)
      .onSnapshot(snap => {
        const list = document.getElementById('server-list');
        list.innerHTML = '';

        const publicServers  = [];
        const privateServers = [];
        const newServerIds   = new Set();

        snap.forEach(doc => {
          const s = doc.data();
          const entry = { id: doc.id, ...s };
          newServerIds.add(doc.id);
          if (s.visibility === 'private') {
            privateServers.push(entry);
          } else {
            publicServers.push(entry);
          }
        });

        _myServerIds = newServerIds;
        _syncServerGifListeners(newServerIds);
        _syncServerImageListeners(newServerIds);
        _syncServerVideoListeners(newServerIds);
        if (publicServers.length) {
          const label = document.createElement('div');
          label.className = 'server-label';
          label.textContent = 'Public';
          list.appendChild(label);
          publicServers.forEach(s => list.appendChild(_createServerIcon(s)));
        }

        // Private servers
        if (privateServers.length) {
          if (publicServers.length) {
            const div = document.createElement('div');
            div.className = 'server-divider';
            list.appendChild(div);
          }
          const label = document.createElement('div');
          label.className = 'server-label';
          label.textContent = 'Private';
          list.appendChild(label);
          privateServers.forEach(s => list.appendChild(_createServerIcon(s)));
        }
      });
  }

  function _createServerIcon(s) {
    const icon = document.createElement('div');
    icon.className = 'server-icon';
    icon.title = s.name;
    if (s.image) {
      icon.innerHTML = '<img src="' + esc(s.image) + '" alt="">';
    } else {
      icon.textContent = (s.name || 'S').charAt(0).toUpperCase();
    }
    icon.dataset.id = s.id;
    icon.addEventListener('click', () => openServer(s.id, s));
    return icon;
  }

  async function _previewServerImage(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { showToast('Image must be under 5 MB.', 'error'); return; }
    try {
      _serverImageBlob = await CropperUtil.open(file, { aspectRatio: 1, width: 256, height: 256 });
      const url = URL.createObjectURL(_serverImageBlob);
      document.getElementById('server-img-preview').innerHTML = '<img src="' + url + '" alt="">';
    } catch { _serverImageBlob = null; }
    e.target.value = '';
  }

  function _resetServerModal() {
    document.getElementById('server-name-input').value = '';
    document.getElementById('server-desc-input').value = '';
    document.getElementById('server-img-input').value = '';
    _serverImageBlob = null;
    document.getElementById('server-img-preview').innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
    document.querySelectorAll('.visibility-opt').forEach(b => b.classList.remove('active'));
    document.getElementById('vis-public').classList.add('active');
  }

  async function createServer() {
    const name = document.getElementById('server-name-input').value.trim();
    if (!name || name.length < 3 || name.length > 50) {
      showToast('Server name must be 3–50 characters.', 'error');
      return;
    }

    const description = document.getElementById('server-desc-input').value.trim();
    if (description.length > 200) {
      showToast('Description must be under 200 characters.', 'error');
      return;
    }

    // Check 2-server limit
    try {
      const myServers = await db.collection('servers')
        .where('owner', '==', currentUser.uid)
        .get();
      if (myServers.size >= 2) {
        showToast('You can only own up to 2 servers.', 'error');
        return;
      }
    } catch { /* proceed */ }

    const visibility = document.querySelector('.visibility-opt.active')?.dataset.value || 'public';

    // Upload image if provided
    let imageUrl = '';
    if (_serverImageBlob) {
      showToast('Uploading server image...', 'info');
      try {
        const fd = new FormData();
        fd.append('file', _serverImageBlob);
        fd.append('upload_preset', CLOUDINARY_PRESET);
        const res = await fetch(
          'https://api.cloudinary.com/v1_1/' + CLOUDINARY_CLOUD + '/image/upload',
          { method: 'POST', body: fd }
        );
        const data = await res.json();
        imageUrl = data.secure_url || '';
      } catch {
        showToast('Image upload failed.', 'error');
        return;
      }
    }

    try {
      const ref = await db.collection('servers').add({
        name,
        description,
        image: imageUrl,
        visibility,
        owner: currentUser.uid,
        members: [currentUser.uid],
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      // Create default #general channel
      await db.collection('servers').doc(ref.id).collection('channels').add({
        name: 'general',
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      document.getElementById('create-server-modal').classList.remove('open');
      _resetServerModal();
      showToast('Server created!', 'success');
    } catch {
      showToast('Failed to create server.', 'error');
    }
  }

  /* ── Discover View (live + searchable) ── */
  let _discoverUnsub = null;
  let _discoverDocs = [];

  function showDiscover() {
    currentServerId = null;
    currentChat = null;
    if (chatUnsub) { chatUnsub(); chatUnsub = null; }
    if (_serverDocUnsub) { _serverDocUnsub(); _serverDocUnsub = null; }
    _hidePreviewBanner();

    document.querySelectorAll('.server-icon').forEach(s => s.classList.remove('active'));
    document.getElementById('discover-btn').classList.add('active');

    document.getElementById('sidebar-header').textContent = 'Discover Servers';
    document.getElementById('dm-section').style.display = 'none';
    document.getElementById('channel-section').style.display = 'none';
    document.getElementById('members-sidebar').style.display = 'none';
    document.getElementById('chat-input-bar').style.display = 'none';
    document.getElementById('chat-title').textContent = 'Discover Public Servers';

    const messagesEl = document.getElementById('chat-messages');
    messagesEl.innerHTML =
      '<div class="discover-search-wrap"><input class="discover-search-input" id="discover-search" placeholder="Search servers..." autocomplete="off"></div>' +
      '<div class="discover-grid" id="discover-grid"></div>';

    document.getElementById('discover-search').addEventListener('input', () => {
      _renderDiscoverGrid(document.getElementById('discover-search').value.trim().toLowerCase());
    });

    if (_discoverUnsub) { _discoverUnsub(); _discoverUnsub = null; }
    _discoverDocs = [];

    _discoverUnsub = db.collection('servers')
      .where('visibility', '==', 'public')
      .onSnapshot(snap => {
        _discoverDocs = [];
        snap.forEach(doc => _discoverDocs.push({ id: doc.id, ...doc.data() }));
        _discoverDocs.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
        const q = document.getElementById('discover-search')?.value.trim().toLowerCase() || '';
        _renderDiscoverGrid(q);
      });
  }

  function _renderDiscoverGrid(q) {
    const grid = document.getElementById('discover-grid');
    if (!grid) return;

    const filtered = q
      ? _discoverDocs.filter(s => (s.name || '').toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q))
      : _discoverDocs;

    if (!filtered.length) {
      grid.innerHTML = '<div class="chat-empty" style="margin:40px auto">' + (q ? 'No servers match your search.' : 'No public servers yet. Create one!') + '</div>';
      return;
    }

    grid.innerHTML = '';
    filtered.forEach(s => {
      const membersAlready = (s.members || []).includes(currentUser.uid);
      const initial = (s.name || 'S').charAt(0).toUpperCase();
      const imgHtml = s.image
        ? '<img src="' + esc(s.image) + '" alt="">'
        : '<span>' + initial + '</span>';

      const card = document.createElement('div');
      card.className = 'discover-card';
      card.dataset.id = s.id;
      card.innerHTML =
        '<div class="discover-card-img">' + imgHtml + '</div>' +
        '<div class="discover-card-body">' +
          '<h4>' + esc(s.name) + '</h4>' +
          '<p>' + esc(s.description || 'No description') + '</p>' +
          '<div class="discover-card-meta">' + (s.members || []).length + ' members</div>' +
          (membersAlready
            ? '<button class="btn btn-sm discover-open" data-id="' + s.id + '" style="margin-top:8px;border:1px solid var(--border);color:var(--text-muted)">Open Server</button>'
            : '<button class="btn btn-primary btn-sm discover-join" data-id="' + s.id + '" style="margin-top:8px">Join Server</button>') +
        '</div>';

      // Click the card body → open or preview
      card.addEventListener('click', e => {
        if (e.target.closest('button')) return; // let button handle it
        if (membersAlready) {
          openServer(s.id, s);
        } else {
          openServerPreview(s.id, s);
        }
      });

      // Open Server button (already joined)
      const openBtn = card.querySelector('.discover-open');
      if (openBtn) {
        openBtn.addEventListener('click', e => { e.stopPropagation(); openServer(s.id, s); });
      }

      // Join Server button
      const joinBtn = card.querySelector('.discover-join');
      if (joinBtn) {
        joinBtn.addEventListener('click', async e => {
          e.stopPropagation();
          try {
            await db.collection('servers').doc(s.id).update({
              members: firebase.firestore.FieldValue.arrayUnion(currentUser.uid)
            });
            joinBtn.textContent = 'Joined';
            joinBtn.disabled = true;
            joinBtn.classList.remove('btn-primary');
            joinBtn.style.color = 'var(--text-muted)';
            joinBtn.style.border = '1px solid var(--border)';
            showToast('Joined server!', 'success');
          } catch { showToast('Failed to join.', 'error'); }
        });
      }

      grid.appendChild(card);
    });
  }

  /* ── Preview Mode ── */
  let _previewServerId = null;

  function openServerPreview(serverId, serverData) {
    _previewServerId = serverId;
    if (chatUnsub) { chatUnsub(); chatUnsub = null; }

    document.querySelectorAll('.server-icon').forEach(s => s.classList.remove('active'));

    document.getElementById('sidebar-header').textContent = serverData.name;
    document.getElementById('dm-section').style.display = 'none';
    document.getElementById('channel-section').style.display = 'flex';
    document.getElementById('members-sidebar').style.display = 'none';
    document.getElementById('chat-input-bar').style.display = 'none'; // read-only
    document.getElementById('create-channel-btn').style.display = 'none'; // preview: no creation
    document.getElementById('chat-title').textContent = serverData.name;

    // Show preview banner
    const banner = document.getElementById('preview-banner');
    banner.style.display = 'flex';
    document.getElementById('preview-join-btn').onclick = async () => {
      try {
        await db.collection('servers').doc(serverId).update({
          members: firebase.firestore.FieldValue.arrayUnion(currentUser.uid)
        });
        _hidePreviewBanner();
        showToast('Joined server!', 'success');
        openServer(serverId, { ...serverData, members: [...(serverData.members || []), currentUser.uid] });
      } catch { showToast('Failed to join.', 'error'); }
    };

    // Load channels read-only — clicking opens channel in preview
    _loadPreviewChannels(serverId);
    loadMembers(serverId, serverData.members || []);

    if (_serverDocUnsub) { _serverDocUnsub(); _serverDocUnsub = null; }
    _serverDocUnsub = db.collection('servers').doc(serverId).onSnapshot(snap => {
      if (!snap.exists) return;
      loadMembers(serverId, snap.data().members || []);
    });
  }

  function _loadPreviewChannels(serverId) {
    db.collection('servers').doc(serverId).collection('channels')
      .orderBy('name')
      .onSnapshot(snap => {
        let docs = [];
        snap.forEach(d => docs.push(d));
        const allHaveOrder = docs.length > 0 && docs.every(d => d.data().order !== undefined);
        if (allHaveOrder) docs.sort((a, b) => a.data().order - b.data().order);

        const list = document.getElementById('channel-list');
        list.innerHTML = '';
        docs.forEach(doc => {
          const ch = doc.data();
          const el = document.createElement('div');
          el.className = 'channel-item';
          el.dataset.id = doc.id;
          if (ch.type === 'streaming') {
            el.innerHTML = '<span class="channel-icon-stream"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg></span> ' + esc(ch.name);
          } else {
            el.innerHTML = '<span class="channel-hash">#</span> ' + esc(ch.name);
          }
          el.addEventListener('click', () => _openPreviewChannel(serverId, doc.id, ch.name));
          list.appendChild(el);
        });
        if (docs.length > 0) _openPreviewChannel(serverId, docs[0].id, docs[0].data().name);
      });
  }

  function _openPreviewChannel(serverId, channelId, channelName) {
    if (chatUnsub) { chatUnsub(); chatUnsub = null; }
    currentChat = null; // no sending

    document.querySelectorAll('.channel-item').forEach(c => c.classList.remove('active'));
    document.querySelector('.channel-item[data-id="' + channelId + '"]')?.classList.add('active');
    document.getElementById('chat-title').textContent = '# ' + channelName + ' (Preview)';

    const messagesEl = document.getElementById('chat-messages');
    messagesEl.innerHTML = '<div class="chat-empty">Loading...</div>';

    let _isNew = true;
    chatUnsub = db.collection('servers').doc(serverId)
      .collection('channels').doc(channelId)
      .collection('messages')
      .orderBy('createdAt', 'asc')
      .limitToLast(100)
      .onSnapshot(snap => {
        if (_isNew) { _isNew = false; messagesEl.innerHTML = ''; }
        if (snap.empty) { messagesEl.innerHTML = '<div class="chat-empty">No messages yet.</div>'; return; }
        const emptyEl = messagesEl.querySelector('.chat-empty');
        if (emptyEl) emptyEl.remove();
        const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 100;
        let hasAdded = false;
        snap.docChanges().forEach(change => {
          const { doc, type } = change;
          if (type === 'added') {
            const el = renderMessage(doc.data(), doc.id, null); // null docRef = no edit/delete
            el.dataset.msgId = doc.id;
            messagesEl.appendChild(el);
            hasAdded = true;
          } else if (type === 'modified') {
            const el = renderMessage(doc.data(), doc.id, null);
            el.dataset.msgId = doc.id;
            messagesEl.querySelector('[data-msg-id="' + doc.id + '"]')?.replaceWith(el);
          } else if (type === 'removed') {
            messagesEl.querySelector('[data-msg-id="' + doc.id + '"]')?.remove();
          }
        });
        if (hasAdded && nearBottom) requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });
      });
  }

  function _hidePreviewBanner() {
    const banner = document.getElementById('preview-banner');
    if (banner) banner.style.display = 'none';
    _previewServerId = null;
  }

  let _serverDocUnsub = null;

  function openServer(serverId, serverData) {
    currentServerId = serverId;
    currentServerOwner = serverData.owner || null;
    _hidePreviewBanner();

    document.querySelectorAll('.server-icon').forEach(s => s.classList.remove('active'));
    const icon = document.querySelector('.server-icon[data-id="' + serverId + '"]');
    if (icon) icon.classList.add('active');

    document.getElementById('sidebar-header').textContent = serverData.name;
    document.getElementById('dm-section').style.display = 'none';
    document.getElementById('channel-section').style.display = 'flex';
    document.getElementById('members-sidebar').style.display = '';
    document.getElementById('create-channel-btn').style.display =
      (currentUser && currentUser.uid === serverData.owner) ? '' : 'none';

    // Track activity
    db.collection('users').doc(currentUser.uid).update({
      'activity.server': serverData.name,
      'activity.dm': null
    }).catch(() => {});

    loadChannels(serverId, true);

    // Live listener on server doc → updates members list when someone joins/leaves
    if (_serverDocUnsub) { _serverDocUnsub(); _serverDocUnsub = null; }
    _serverDocUnsub = db.collection('servers').doc(serverId).onSnapshot(snap => {
      if (!snap.exists) return;
      loadMembers(serverId, snap.data().members || []);
    });
    loadMembers(serverId, serverData.members || []);
  }

  function loadChannels(serverId, autoOpen) {
    const isOwner = !!(currentUser && currentUser.uid === currentServerOwner);
    db.collection('servers').doc(serverId).collection('channels')
      .orderBy('name')
      .onSnapshot(snap => {
        // Sort by 'order' if set, else keep name order
        let docs = [];
        snap.forEach(d => docs.push(d));
        const allHaveOrder = docs.length > 0 && docs.every(d => d.data().order !== undefined);
        if (allHaveOrder) docs.sort((a, b) => a.data().order - b.data().order);

        const list = document.getElementById('channel-list');
        list.innerHTML = '';
        docs.forEach((doc, idx) => {
          const ch = doc.data();
          const el = document.createElement('div');
          el.className = 'channel-item';
          el.dataset.id = doc.id;
          el.dataset.type = ch.type || 'text';

          let orderBtns = '';
          if (isOwner) {
            const upBtn = idx > 0 ? '<button class="ch-order-btn ch-up" data-idx="' + idx + '" title="Move up">↑</button>' : '';
            const dnBtn = idx < docs.length - 1 ? '<button class="ch-order-btn ch-dn" data-idx="' + idx + '" title="Move down">↓</button>' : '';
            orderBtns = '<span class="ch-order-btns">' + upBtn + dnBtn + '</span>';
          }
          if (ch.type === 'streaming') {
            el.innerHTML = '<span class="channel-icon-stream"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg></span> ' + esc(ch.name) + orderBtns;
          } else {
            el.innerHTML = '<span class="channel-hash">#</span> ' + esc(ch.name) + orderBtns;
          }
          el.addEventListener('click', e => {
            if (e.target.classList.contains('ch-order-btn')) return;
            if (ch.type === 'streaming') {
              openStreamingChannel(serverId, doc.id, ch.name);
            } else {
              openChannel(serverId, doc.id, ch.name);
            }
          });
          list.appendChild(el);
        });

        if (isOwner) {
          list.querySelectorAll('.ch-order-btn').forEach(btn => {
            btn.addEventListener('click', async e => {
              e.stopPropagation();
              const idx = parseInt(btn.dataset.idx);
              const swapIdx = btn.classList.contains('ch-up') ? idx - 1 : idx + 1;
              // Assign base order from current positions, then swap
              const ordered = docs.map((d, i) => ({ id: d.id, order: d.data().order !== undefined ? d.data().order : i }));
              [ordered[idx], ordered[swapIdx]] = [ordered[swapIdx], ordered[idx]];
              const batch = db.batch();
              ordered.forEach((item, i) => {
                batch.update(db.collection('servers').doc(serverId).collection('channels').doc(item.id), { order: i });
              });
              await batch.commit().catch(() => showToast('Failed to reorder.', 'error'));
            });
          });
        }

        // Auto-open first channel (or one named 'general')
        if (!snap.empty && (autoOpen || !currentChat)) {
          const generalDoc = docs.find(d => d.data().name.toLowerCase() === 'general');
          const first = generalDoc || docs[0];
          const firstData = first.data();
          if (firstData.type === 'streaming') {
            openStreamingChannel(serverId, first.id, firstData.name);
          } else {
            openChannel(serverId, first.id, firstData.name);
          }
        }
      });
  }

  let _selectedChannelType = 'text';
  (function _wireChannelTypePicker() {
    document.querySelectorAll('.channel-type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.channel-type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _selectedChannelType = btn.dataset.type;
      });
    });
  })();

  async function createChannel() {
    if (!currentServerId) return;
    const name = document.getElementById('channel-name-input').value.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (!name || name.length > 30) {
      showToast('Channel name must be 1–30 characters.', 'error');
      return;
    }

    try {
      const existingSnap = await db.collection('servers').doc(currentServerId).collection('channels').get();
      const channelData = {
        name,
        order: existingSnap.size,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      if (_selectedChannelType === 'streaming') {
        channelData.type = 'streaming';
      }
      await db.collection('servers').doc(currentServerId).collection('channels').add(channelData);
      document.getElementById('channel-name-input').value = '';
      _selectedChannelType = 'text';
      document.querySelectorAll('.channel-type-btn').forEach(b => b.classList.remove('active'));
      document.querySelector('.channel-type-btn[data-type="text"]').classList.add('active');
      document.getElementById('create-channel-modal').classList.remove('open');
      showToast('Channel created!', 'success');
    } catch {
      showToast('Failed to create channel.', 'error');
    }
  }

  // Per-server member listeners: serverId → Map(uid → unsubscribe)
  const _memberListeners = new Map();
  const _memberProfiles  = new Map(); // uid → profile (for current server)
  let   _currentMemberServerId = null;

  const _rtdbMemberListeners = new Map();   // uid → RTDB off fn
  const _rtdbMemberOffline = new Set();      // uids RTDB confirmed offline

  // Periodically re-render member list for staleness checks
  setInterval(() => {
    if (_memberProfiles.size) _renderMembersList();
  }, 10 * 1000);

  function loadMembers(serverId, memberUids) {
    // Tear down listeners from a previous server
    if (_currentMemberServerId !== serverId) {
      if (_memberListeners.has(_currentMemberServerId)) {
        _memberListeners.get(_currentMemberServerId).forEach(unsub => unsub());
        _memberListeners.delete(_currentMemberServerId);
      }
      _rtdbMemberListeners.forEach(off => off());
      _rtdbMemberListeners.clear();
      _rtdbMemberOffline.clear();
      _memberProfiles.clear();
      _currentMemberServerId = serverId;
    }

    const serverListeners = _memberListeners.get(serverId) || new Map();
    _memberListeners.set(serverId, serverListeners);

    // Remove listeners for UIDs no longer in the list
    serverListeners.forEach((unsub, uid) => {
      if (!memberUids.includes(uid)) {
        unsub();
        serverListeners.delete(uid);
        _memberProfiles.delete(uid);
        const rtdbOff = _rtdbMemberListeners.get(uid);
        if (rtdbOff) { rtdbOff(); _rtdbMemberListeners.delete(uid); }
      }
    });

    // Add per-member listeners for new UIDs
    memberUids.forEach(uid => {
      if (serverListeners.has(uid)) return;
      const unsub = db.collection('users').doc(uid).onSnapshot(d => {
        if (!d.exists) return;
        const data = d.data();
        const effectiveStatus = _rtdbMemberOffline.has(uid) ? 'offline' : (data.effectiveStatus || 'offline');
        _memberProfiles.set(uid, { uid, ...data, effectiveStatus });
        profileCache.set(uid, {
          username: data.username,
          avatar: data.avatar || '',
          effectiveStatus
        });
        _patchRenderedMessages(uid);
        _renderMembersList();
      });
      serverListeners.set(uid, unsub);

      // RTDB presence listener for member
      if (!_rtdbMemberListeners.has(uid)) {
        try {
          const presRef = firebase.database().ref('presence/' + uid);
          const rtdbHandler = snap => {
            const val = snap.val();
            if (val && val.online === false) {
              _rtdbMemberOffline.add(uid);
              db.collection('users').doc(uid).update({ effectiveStatus: 'offline', online: false }).catch(() => {});
              const cur = _memberProfiles.get(uid);
              if (cur) {
                _memberProfiles.set(uid, { ...cur, effectiveStatus: 'offline' });
                const cached = profileCache.get(uid);
                if (cached) profileCache.set(uid, { ...cached, effectiveStatus: 'offline' });
                _patchRenderedMessages(uid);
                _renderMembersList();
              }
            } else if (val && val.online === true) {
              _rtdbMemberOffline.delete(uid);
              const cur = _memberProfiles.get(uid);
              if (cur && cur.effectiveStatus === 'offline') {
                db.collection('users').doc(uid).get().then(docSnap => {
                  if (!docSnap.exists) return;
                  const d = docSnap.data();
                  const realStatus = d.effectiveStatus || 'offline';
                  _memberProfiles.set(uid, { ...cur, effectiveStatus: realStatus });
                  profileCache.set(uid, { username: d.username, avatar: d.avatar || '', effectiveStatus: realStatus });
                  _patchRenderedMessages(uid);
                  _renderMembersList();
                }).catch(() => {});
              }
            }
          };
          presRef.on('value', rtdbHandler);
          _rtdbMemberListeners.set(uid, () => presRef.off('value', rtdbHandler));
        } catch (e) { /* RTDB unavailable */ }
      }
    });
  }

  function _renderMembersList() {
    if (_currentMemberServerId !== currentServerId) return; // stale
    const list = document.getElementById('members-list');
    if (!list) return;
    const profiles = Array.from(_memberProfiles.values());
    const order = { online: 0, away: 1, dnd: 2, offline: 3 };
    profiles.sort((a, b) => (order[_resolveStatus(a)] || 3) - (order[_resolveStatus(b)] || 3));
    list.innerHTML = profiles.map(m => {
      const initial = (m.username || 'U').charAt(0).toUpperCase();
      const avatarHtml = m.avatar ? '<img src="' + esc(m.avatar) + '" alt="">' : initial;
      const eStatus = _resolveStatus(m);
      const activity = _resolveActivity(m, eStatus);
      return '<div class="member-item" data-uid="' + m.uid + '" style="cursor:pointer">' +
        '<div class="member-avatar">' + avatarHtml +
          '<span class="status-dot ' + eStatus + '"></span>' +
        '</div>' +
        '<div class="member-info">' +
          '<span class="member-name">' + esc(m.username) + '</span>' +
          '<span class="member-activity">' + esc(activity) + '</span>' +
        '</div></div>';
    }).join('');

    // Wire click → user popup (skip self)
    list.querySelectorAll('.member-item').forEach(el => {
      el.addEventListener('click', () => {
        const uid = el.dataset.uid;
        if (uid && uid !== currentUser.uid) _showUserPopup(uid, el);
      });
    });
  }

  /* ── Channel Chat ── */
  function openChannel(serverId, channelId, channelName) {
    if (chatUnsub) { chatUnsub(); chatUnsub = null; }
    _cleanupStreaming();

    currentChat = { type: 'channel', serverId, channelId };

    document.querySelectorAll('.channel-item').forEach(c => c.classList.remove('active'));
    const el = document.querySelector('.channel-item[data-id="' + channelId + '"]');
    if (el) el.classList.add('active');

    document.getElementById('chat-title').textContent = '# ' + channelName;
    document.getElementById('chat-input-bar').style.display = 'flex';
    document.getElementById('stream-view').style.display = 'none';
    document.getElementById('chat-messages').style.display = '';
    const lBtn = document.getElementById('leave-chat-btn');
    if (lBtn) lBtn.style.display = 'none';

    const messagesEl = document.getElementById('chat-messages');
    messagesEl.innerHTML = '<div class="chat-empty">Loading...</div>';

    let _isChatNew = true;
    chatUnsub = db.collection('servers').doc(serverId)
      .collection('channels').doc(channelId)
      .collection('messages')
      .orderBy('createdAt', 'asc')
      .limitToLast(100)
      .onSnapshot(snap => {
        if (_isChatNew) { _isChatNew = false; messagesEl.innerHTML = ''; }
        if (snap.empty) { messagesEl.innerHTML = '<div class="chat-empty">No messages yet. Start the conversation!</div>'; return; }
        const emptyEl = messagesEl.querySelector('.chat-empty');
        if (emptyEl) emptyEl.remove();
        const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 100;
        let hasAdded = false;
        snap.docChanges().forEach(change => {
          const { doc, type } = change;
          if (type === 'added') {
            const el = renderMessage(doc.data(), doc.id, doc.ref);
            el.dataset.msgId = doc.id;
            messagesEl.appendChild(el);
            hasAdded = true;
          } else if (type === 'modified') {
            const el = renderMessage(doc.data(), doc.id, doc.ref);
            el.dataset.msgId = doc.id;
            messagesEl.querySelector('[data-msg-id="' + doc.id + '"]')?.replaceWith(el);
          } else if (type === 'removed') {
            messagesEl.querySelector('[data-msg-id="' + doc.id + '"]')?.remove();
          }
        });
        if (hasAdded && nearBottom) requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });
      });
  }

  /* ── Send Message (uid-only storage) ── */
  async function sendMessage() {
    if (!currentChat) return;
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    const hasImages = _stagedFiles.length > 0;
    const hasVideo  = _stagedVideo !== null;
    if (!text && !hasImages && !hasVideo) return;
    if (text.length > 2000) return;

    input.value = '';

    // Upload staged images first
    let imageUrls = [];
    if (hasImages) {
      showToast('Uploading...', 'info');
      try {
        imageUrls = await Promise.all(_stagedFiles.map(async f => {
          const fd = new FormData();
          fd.append('file', f);
          fd.append('upload_preset', CLOUDINARY_PRESET);
          const res = await fetch('https://api.cloudinary.com/v1_1/' + CLOUDINARY_CLOUD + '/image/upload', { method: 'POST', body: fd });
          const d = await res.json();
          if (!d.secure_url) throw new Error('Upload failed');
          return d.secure_url;
        }));
      } catch {
        showToast('Upload failed.', 'error');
        return;
      }
      // Clear staging
      _stagedObjectUrls.forEach(u => URL.revokeObjectURL(u));
      _stagedFiles = [];
      _stagedObjectUrls = [];
      _renderStagedPreviews();
    }

    // Upload staged video
    let videoUrl = '';
    if (hasVideo) {
      showToast('Uploading video...', 'info');
      try {
        const fd = new FormData();
        fd.append('file', _stagedVideo);
        fd.append('upload_preset', CLOUDINARY_PRESET);
        const res = await fetch('https://api.cloudinary.com/v1_1/' + CLOUDINARY_CLOUD + '/video/upload', { method: 'POST', body: fd });
        const d = await res.json();
        if (!d.secure_url) throw new Error('Upload failed');
        videoUrl = d.secure_url;
      } catch {
        showToast('Video upload failed.', 'error');
        return;
      }
      URL.revokeObjectURL(_stagedVideoUrl);
      _stagedVideo = null;
      _stagedVideoUrl = null;
      _renderStagedPreviews();
    }

    const msgData = {
      uid: currentUser.uid,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    if (text) msgData.text = text;
    if (imageUrls.length) msgData.images = imageUrls;
    if (videoUrl) msgData.videoUrl = videoUrl;

    if (_replyState) {
      msgData.replyTo = {
        docId: _replyState.docId,
        uid: _replyState.uid,
        username: _replyState.username,
        text: _replyState.text,
        images: _replyState.images || [],
        gifUrl: _replyState.gifUrl || ''
      };
      _cancelReply();
    }

    try {
      if (currentChat.type === 'dm') {
        const convoId = [currentUser.uid, currentChat.friendUid].sort().join('_');
        // Ensure the parent DM doc exists (for Firestore rules and cross-user discovery)
        await db.collection('dms').doc(convoId).set({
          participants: [currentUser.uid, currentChat.friendUid],
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        await db.collection('dms').doc(convoId).collection('messages').add(msgData);
        // Save images + videos to DM library so both participants can reuse them in the picker
        if (imageUrls.length) {
          const imgCol = db.collection('dms').doc(convoId).collection('images');
          const gifCol = db.collection('dms').doc(convoId).collection('gifs');
          imageUrls.forEach(url => {
            const isGif = /\.gif(\?|$)/i.test(url);
            (isGif ? gifCol : imgCol).add({ url, uploadedBy: currentUser.uid, createdAt: firebase.firestore.FieldValue.serverTimestamp() }).catch(() => {});
          });
        }
        if (videoUrl) {
          db.collection('dms').doc(convoId).collection('videos')
            .add({ url: videoUrl, uploadedBy: currentUser.uid, createdAt: firebase.firestore.FieldValue.serverTimestamp() }).catch(() => {});
        }

        // Notify friend (skip if they are in DND mode)
        const recipientProfile = _dmProfiles.get(currentChat.friendUid) || profileCache.get(currentChat.friendUid);
        const recipientStatus = recipientProfile ? (recipientProfile.effectiveStatus || 'offline') : 'offline';
        if (recipientStatus !== 'dnd') {
          const notifText = videoUrl
            ? userProfile.username + ' sent a video'
            : imageUrls.length
            ? userProfile.username + ' sent ' + (imageUrls.length === 1 ? 'an image' : imageUrls.length + ' images')
            : userProfile.username + ': ' + (text.length > 60 ? text.slice(0, 60) + '...' : text);
          await db.collection('users').doc(currentChat.friendUid).collection('notifications').add({
            message: notifText,
            type: 'dm',
            fromUid: currentUser.uid,
            read: false,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
          });
        }
      } else if (currentChat.type === 'channel') {
        await db.collection('servers').doc(currentChat.serverId)
          .collection('channels').doc(currentChat.channelId)
          .collection('messages').add(msgData);
        // Add images (and gifs) to server library
        if (imageUrls.length) {
          const imgCol = db.collection('servers').doc(currentChat.serverId).collection('images');
          const gifCol = db.collection('servers').doc(currentChat.serverId).collection('gifs');
          imageUrls.forEach(url => {
            const isGif = /\.gif(\?|$)/i.test(url);
            (isGif ? gifCol : imgCol).add({ url, uploadedBy: currentUser.uid, createdAt: firebase.firestore.FieldValue.serverTimestamp() }).catch(() => {});
          });
        }
        // Add video to server library
        if (videoUrl) {
          db.collection('servers').doc(currentChat.serverId).collection('videos')
            .add({ url: videoUrl, uploadedBy: currentUser.uid, createdAt: firebase.firestore.FieldValue.serverTimestamp() }).catch(() => {});
        }
      }
    } catch (err) {
      console.error('Send failed:', err);
      showToast('Failed to send message.', 'error');
    }
  }

  /* ── Render a single message (resolves from profileCache) ── */
  function renderMessage(data, docId, docRef) {
    const div = document.createElement('div');
    div.className = 'msg';
    div.dataset.uid = data.uid || '';

    // Resolve from cache, fall back to denormalized data for old messages
    const cached = profileCache.get(data.uid);
    const username = cached ? cached.username : (data.username || 'Unknown');
    const avatar = cached ? cached.avatar : (data.avatar || '');
    const eStatus = cached ? cached.effectiveStatus : 'offline';

    const initial = (username || 'U').charAt(0).toUpperCase();
    const avatarContent = avatar
      ? '<img src="' + esc(avatar) + '" alt="">'
      : initial;

    const time = data.createdAt
      ? new Date(data.createdAt.toDate()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';

    const isOwn = currentUser && data.uid === currentUser.uid;

    // Reply quote block (show [image] / [GIF] when no text)
    let replyQuoteHTML = '';
    if (data.replyTo) {
      const rAuthor = esc(data.replyTo.username || 'Unknown');
      let rText = (data.replyTo.text || '').slice(0, 100);
      if (!rText) {
        if (data.replyTo.gifUrl) rText = '[GIF]';
        else if (data.replyTo.videoUrl) rText = '[video]';
        else if (data.replyTo.images && data.replyTo.images.length)
          rText = data.replyTo.images.length === 1 ? '[image]' : '[' + data.replyTo.images.length + ' images]';
        else rText = '[message]';
      } else if (data.replyTo.images && data.replyTo.images.length) {
        rText += ' [+' + (data.replyTo.images.length === 1 ? 'image' : data.replyTo.images.length + ' images') + ']';
      } else if (data.replyTo.gifUrl) {
        rText += ' [GIF]';
      } else if (data.replyTo.videoUrl) {
        rText += ' [video]';
      }
      replyQuoteHTML = (function() {
        const replyCached = profileCache.get(data.replyTo.uid);
        const replyAvatar = (replyCached && replyCached.avatar)
          ? '<img src="' + esc(replyCached.avatar) + '" alt="">'
          : esc((data.replyTo.username || 'U').charAt(0).toUpperCase());
        return '<div class="msg-reply-quote" data-reply-id="' + esc(data.replyTo.docId) + '">' +
          '<span class="reply-curve-line"></span>' +
          '<span class="reply-avatar-mini">' + replyAvatar + '</span>' +
          '<span class="reply-name">' + rAuthor + '</span>' +
          '<span class="reply-text">' + esc(rText) + '</span>' +
          '</div>';
      })();
    }

    // Action buttons — disable edit if images-only message
    const canDelete = isOwn && docRef;
    const canEdit   = isOwn && docRef && !data.gifUrl && !(data.images && data.images.length && !data.text);
    const replyBtn   = '<button class="msg-action-btn reply" title="Reply"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg></button>';
    const editBtn    = canEdit ? '<button class="msg-action-btn edit" title="Edit"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>' : '';
    const deleteBtn  = canDelete ? '<button class="msg-action-btn delete" title="Delete"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg></button>' : '';
    const actionsHTML = '<div class="msg-actions">' + replyBtn + editBtn + deleteBtn + '</div>';

    const editedTag = data.edited ? '<span class="msg-edited-tag">(edited)</span>' : '';

    // Content: build each part (text, GIF, images) independently
    let contentHTML = '';
    if (data.gifUrl) {
      contentHTML += '<div class="msg-gif-wrap"><img class="msg-gif lightbox-trigger" src="' + esc(data.gifUrl) + '" alt="GIF" loading="lazy" data-src="' + esc(data.gifUrl) + '"></div>';
    }
    if (data.text) {
      const textHTML = _renderMessageText(data.text);
      const ytId = _extractYouTubeId(data.text);
      const ytHTML = ytId
        ? '<div class="msg-yt-embed"><iframe class="msg-yt-iframe" src="https://www.youtube.com/embed/' + esc(ytId) + '?rel=0" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen loading="lazy"></iframe></div>'
        : '';
      contentHTML += '<div class="msg-text">' + textHTML + editedTag + '</div>' + ytHTML;
    }
    if (data.images && data.images.length) {
      contentHTML += '<div class="msg-images' + (data.images.length === 1 ? ' single' : '') + '">' +
        data.images.map(url =>
          '<img class="msg-image lightbox-trigger" src="' + esc(url) + '" alt="" loading="lazy" data-src="' + esc(url) + '">'
        ).join('') +
        '</div>';
    }
    if (data.videoUrl) {
      contentHTML += '<div class="msg-video-wrap"><video class="msg-video" src="' + esc(data.videoUrl) + '" controls preload="metadata"></video></div>';
    }

    div.innerHTML =
      '<div class="msg-avatar">' + avatarContent +
        '<span class="status-dot ' + eStatus + '"></span>' +
      '</div>' +
      '<div class="msg-body">' +
        replyQuoteHTML +
        '<div class="msg-header">' +
          '<span class="msg-author">' + esc(username) + '</span>' +
          '<span class="msg-time">' + time + '</span>' +
        '</div>' +
        contentHTML +
      '</div>' +
      actionsHTML;

    // Wire action buttons
    div.querySelector('.msg-action-btn.reply').addEventListener('click', () => {
      _setReply(data, docId);
    });
    if (canEdit) {
      div.querySelector('.msg-action-btn.edit').addEventListener('click', () => {
        _editMessage(docRef, data.text || '', div);
      });
    }
    if (canDelete) {
      div.querySelector('.msg-action-btn.delete').addEventListener('click', () => {
        _deleteMessage(docRef, data);
      });
    }

    // Reply quote click → jump to original message
    const quoteEl = div.querySelector('.msg-reply-quote[data-reply-id]');
    if (quoteEl) {
      quoteEl.addEventListener('click', () => _jumpToMessage(quoteEl.dataset.replyId));
    }

    // Avatar / username click → user mini-profile popup
    if (data.uid && data.uid !== currentUser.uid) {
      const avatarEl = div.querySelector('.msg-avatar');
      const authorEl = div.querySelector('.msg-author');
      if (avatarEl) avatarEl.addEventListener('click', (e) => { e.stopPropagation(); _showUserPopup(data.uid, avatarEl); });
      if (authorEl) authorEl.addEventListener('click', (e) => { e.stopPropagation(); _showUserPopup(data.uid, authorEl); });
    }

    return div;
  }

  /* ── User Mini-Profile Popup ── */
  async function _showUserPopup(uid, anchorEl) {
    const overlay = document.getElementById('user-popup-overlay');
    const popup = document.getElementById('user-popup');

    // Fetch user data — prefer cache, fall back to Firestore
    let u = profileCache.get(uid);
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
    } catch { /* use cache */ }
    if (!u) return;

    const initial = (u.username || 'U').charAt(0).toUpperCase();
    const avatarHtml = u.avatar
      ? '<img src="' + esc(u.avatar) + '" alt="">'
      : '<span class="user-popup-initial">' + initial + '</span>';
    const eStatus = u.effectiveStatus || 'offline';
    const statusText = _resolveActivity(fullData || u, eStatus);

    // Description
    const desc = fullData && fullData.description ? fullData.description : '';

    // Check friendship
    let isFriend = false;
    try {
      const myDoc = await db.collection('users').doc(currentUser.uid).get();
      const myFriends = (myDoc.data() || {}).friends || [];
      isFriend = myFriends.includes(uid);
    } catch { /* ignore */ }

    popup.innerHTML =
      '<div class="user-popup-banner"></div>' +
      '<div class="user-popup-body">' +
        '<div class="user-popup-avatar-wrap">' +
          '<div class="user-popup-avatar">' + avatarHtml +
            '<span class="status-dot ' + eStatus + '"></span>' +
          '</div>' +
        '</div>' +
        '<h3 class="user-popup-name">' + esc(u.username) + '</h3>' +
        '<span class="user-popup-status ' + eStatus + '">' + esc(statusText) + '</span>' +
        (desc ? '<div class="user-popup-desc">' + esc(desc) + '</div>' : '') +
        '<hr class="user-popup-divider">' +
        '<div class="user-popup-actions">' +
          (isFriend
            ? '<button class="btn btn-sm" disabled style="opacity:.5;cursor:default;flex:1">Already Friends</button>'
            : '<button class="btn btn-primary btn-sm" id="popup-add-friend">Add Friend</button>') +
          '<button class="btn btn-sm" id="popup-dm-btn">Message</button>' +
        '</div>' +
        '<button class="user-popup-view-more" id="popup-view-more">View Full Profile</button>' +
      '</div>';

    // Position popup near the anchor element
    const rect = anchorEl.getBoundingClientRect();
    let top = rect.top;
    let left = rect.right + 10;
    // Make sure it fits on screen
    const popupW = 300;
    const popupH = 340;
    if (left + popupW > window.innerWidth) left = rect.left - popupW - 10;
    if (left < 0) left = 10;
    if (top + popupH > window.innerHeight) top = window.innerHeight - popupH - 10;
    if (top < 10) top = 10;
    popup.style.top = top + 'px';
    popup.style.left = left + 'px';

    overlay.classList.add('open');

    // Close on click outside
    overlay.addEventListener('click', function _close(e) {
      if (e.target === overlay) {
        overlay.classList.remove('open');
        overlay.removeEventListener('click', _close);
      }
    });

    // Wire Add Friend
    const addBtn = document.getElementById('popup-add-friend');
    if (addBtn) {
      addBtn.addEventListener('click', async () => {
        addBtn.disabled = true;
        addBtn.textContent = 'Sending...';
        try {
          // Check if they already sent us a pending request — auto-accept
          const reverseReqs = await db.collection('friend_requests')
            .where('from', '==', uid)
            .where('to', '==', currentUser.uid)
            .get();
          let reverseDoc = null;
          reverseReqs.forEach(d => { if (d.data().status === 'pending') reverseDoc = d; });
          if (reverseDoc) {
            const batch = db.batch();
            batch.update(db.collection('users').doc(currentUser.uid), { friends: firebase.firestore.FieldValue.arrayUnion(uid) });
            batch.update(db.collection('users').doc(uid), { friends: firebase.firestore.FieldValue.arrayUnion(currentUser.uid) });
            batch.update(db.collection('friend_requests').doc(reverseDoc.id), { status: 'accepted' });
            await batch.commit();
            addBtn.textContent = 'Friends!';
            showToast('Friend added!', 'success');
            return;
          }
          // Check for existing pending request from us
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
            toUsername: u.username,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            status: 'pending'
          });
          addBtn.textContent = 'Sent!';
          showToast('Friend request sent!', 'success');
        } catch (err) {
          console.error(err);
          addBtn.textContent = 'Failed';
          showToast('Failed to send request.', 'error');
        }
      });
    }

    // Wire DM button
    document.getElementById('popup-dm-btn').addEventListener('click', () => {
      overlay.classList.remove('open');
      // If already in DM list, open it; otherwise navigate
      const prof = _dmProfiles.get(uid);
      if (prof) {
        showDMView();
        openDM(uid, prof);
      } else {
        // Open the chat UI but don't add to sidebar yet — _listenNonFriendDMs
        // will add them automatically once the first message is sent.
        const newProf = { uid: uid, username: u.username, avatar: u.avatar, effectiveStatus: eStatus };
        profileCache.set(uid, { username: u.username, avatar: u.avatar, effectiveStatus: eStatus });
        showDMView();
        openDM(uid, newProf);
      }
    });

    // Wire View More
    document.getElementById('popup-view-more').addEventListener('click', () => {
      overlay.classList.remove('open');
      window.location.href = 'friends.html?view=' + uid;
    });
  }

  /* ── Reply helpers ── */
  function _setReply(data, docId) {
    const cached = profileCache.get(data.uid);
    const username = cached ? cached.username : (data.username || 'Unknown');

    // Build display text for reply bar
    let displayText = data.text || '';
    if (!displayText) {
      if (data.gifUrl) displayText = '[GIF]';
      else if (data.videoUrl) displayText = '[video]';
      else if (data.images && data.images.length)
        displayText = data.images.length === 1 ? '[image]' : '[' + data.images.length + ' images]';
      else displayText = '[message]';
    } else if (data.images && data.images.length) {
      displayText += ' [+' + (data.images.length === 1 ? 'image' : data.images.length + ' images') + ']';
    } else if (data.gifUrl) {
      displayText += ' [GIF]';
    } else if (data.videoUrl) {
      displayText += ' [video]';
    }

    const preview = displayText.slice(0, 80) + (displayText.length > 80 ? '\u2026' : '');
    _replyState = {
      uid: data.uid,
      username,
      text: data.text || '',
      docId,
      images: data.images || [],
      gifUrl: data.gifUrl || '',
      videoUrl: data.videoUrl || ''
    };
    document.getElementById('reply-to-name').textContent = username;
    document.getElementById('reply-to-preview').textContent = preview;
    document.getElementById('reply-bar').style.display = 'flex';
    document.getElementById('chat-input').focus();
  }

  function _cancelReply() {
    _replyState = null;
    document.getElementById('reply-bar').style.display = 'none';
    document.getElementById('reply-to-name').textContent = '';
    document.getElementById('reply-to-preview').textContent = '';
  }

  function _jumpToMessage(docId) {
    const target = document.querySelector('[data-msg-id="' + docId + '"]');
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('msg-highlight');
    setTimeout(() => target.classList.remove('msg-highlight'), 2000);
  }

  /* ── Edit / Delete ── */
  function _editMessage(docRef, currentText, msgEl) {
    const msgTextEl = msgEl.querySelector('.msg-text');
    if (!msgTextEl || msgEl.querySelector('.msg-edit-wrapper')) return; // already editing

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
    function autoGrow() {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
    }
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
      if (!newText) { cancel(); return; }
      if (newText === currentText) { cancel(); return; }
      try {
        await docRef.update({ text: newText, edited: true });
      } catch {
        showToast('Failed to edit message.', 'error');
        cancel();
      }
    }

    function cancel() {
      msgTextEl.innerHTML = original;
    }

    saveBtn.addEventListener('click', save);
    cancelBtn.addEventListener('click', cancel);
    textarea.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
      if (e.key === 'Escape') { cancel(); }
    });
  }

  /* ── Custom confirm dialog ── */
  function _showConfirm({ title, avatar, username, preview, onConfirm }) {
    const overlay = document.getElementById('confirm-modal');
    overlay.querySelector('.confirm-modal-title').textContent = title;
    const initial = (username || 'U').charAt(0).toUpperCase();
    overlay.querySelector('.confirm-msg-avatar').innerHTML = avatar
      ? '<img src="' + esc(avatar) + '" alt="">'
      : initial;
    overlay.querySelector('.confirm-msg-author').textContent = username || 'Unknown';
    overlay.querySelector('.confirm-msg-text').textContent = preview || '';
    overlay.classList.add('open');

    // Clone buttons to remove old listeners
    const ok = overlay.querySelector('#confirm-modal-ok');
    const cancel = overlay.querySelector('#confirm-modal-cancel');
    const okNew = ok.cloneNode(true);
    const cancelNew = cancel.cloneNode(true);
    ok.replaceWith(okNew);
    cancel.replaceWith(cancelNew);

    const close = () => overlay.classList.remove('open');
    okNew.addEventListener('click', () => { close(); onConfirm(); });
    cancelNew.addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); }, { once: true });
  }

  /* ══════════════════════════════════════════════
     Streaming Channel — WebRTC multi-streamer
     ══════════════════════════════════════════════ */

  let _localStream = null;
  const _streamerPCs = new Map();            // viewerUid → RTCPeerConnection (when WE are streaming)
  const _viewerPCs = new Map();              // streamerUid → RTCPeerConnection (when we view others)
  let _streamUnsubs = [];
  let _streamChatUnsub = null;
  let _isStreaming = false;
  let _streamManagePanelOpen = false;
  let _streamContext = null;                  // { serverId, channelId, channelName }
  let _streamStartedAtMs = null;
  let _streamUptimeTimer = null;
  let _streamRecorder = null;
  let _streamRecordChunks = [];
  let _streamChatFiles = [];
  let _streamChatVideo = null;
  let _streamChatVideoUrl = null;
  const _rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  function _cleanupStreaming() {
    if (_streamUptimeTimer) {
      clearInterval(_streamUptimeTimer);
      _streamUptimeTimer = null;
    }
    if (_streamRecorder && _streamRecorder.state !== 'inactive') {
      _streamRecorder.stop();
    }
    _streamRecorder = null;
    _streamRecordChunks = [];
    if (_localStream) {
      _localStream.getTracks().forEach(t => t.stop());
      _localStream = null;
    }
    _streamerPCs.forEach(pc => pc.close());
    _streamerPCs.clear();
    _viewerPCs.forEach(pc => pc.close());
    _viewerPCs.clear();
    _streamUnsubs.forEach(fn => fn());
    _streamUnsubs = [];
    if (_streamChatUnsub) {
      _streamChatUnsub();
      _streamChatUnsub = null;
    }
    _streamContext = null;
    _streamStartedAtMs = null;
    _isStreaming = false;
    _setStreamManagerLive(false);
    _setStreamManagePanelOpen(false);
    document.getElementById('stream-chat-window').style.display = 'none';
  }

  function _setStreamManagerLive(isLive) {
    const btn = document.getElementById('stream-manage-nav-btn');
    if (!btn) return;
    btn.style.display = isLive ? 'inline-flex' : 'none';
    btn.classList.toggle('live', !!isLive);
  }

  function _setStreamManagePanelOpen(open) {
    _streamManagePanelOpen = !!open;
    document.getElementById('stream-manage-panel').style.display = open ? 'block' : 'none';
  }

  function _toggleStreamManagePanel() {
    if (!_isStreaming) return;
    _setStreamManagePanelOpen(!_streamManagePanelOpen);
  }

  function _updateStreamManagePanel() {
    const statusEl = document.getElementById('stream-manage-status');
    const channelEl = document.getElementById('stream-manage-channel');
    const uptimeEl = document.getElementById('stream-manage-uptime');
    const recordBtn = document.getElementById('stream-manage-record-btn');
    statusEl.textContent = _isStreaming ? 'Live' : 'Offline';
    channelEl.textContent = _streamContext ? _streamContext.channelName : 'None';
    uptimeEl.textContent = _streamStartedAtMs ? _formatDuration(Date.now() - _streamStartedAtMs) : '00:00:00';
    if (recordBtn) {
      const recording = _streamRecorder && _streamRecorder.state === 'recording';
      recordBtn.textContent = recording ? 'Stop Recording' : 'Start Recording';
    }
  }

  function _startUptimeTimer() {
    if (_streamUptimeTimer) clearInterval(_streamUptimeTimer);
    _updateStreamManagePanel();
    _streamUptimeTimer = setInterval(_updateStreamManagePanel, 1000);
  }

  function _formatDuration(ms) {
    const total = Math.floor(ms / 1000);
    const hh = String(Math.floor(total / 3600)).padStart(2, '0');
    const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    return hh + ':' + mm + ':' + ss;
  }

  function openStreamingChannel(serverId, channelId, channelName) {
    if (chatUnsub) { chatUnsub(); chatUnsub = null; }
    _cleanupStreaming();

    _streamContext = { serverId, channelId, channelName };
    _updateStreamManagePanel();

    currentChat = { type: 'streaming', serverId, channelId };

    document.querySelectorAll('.channel-item').forEach(c => c.classList.remove('active'));
    const el = document.querySelector('.channel-item[data-id="' + channelId + '"]');
    if (el) el.classList.add('active');

    document.getElementById('chat-title').textContent = channelName;
    document.getElementById('chat-messages').style.display = 'none';
    document.getElementById('chat-input-bar').style.display = 'none';
    const lBtn = document.getElementById('leave-chat-btn');
    if (lBtn) lBtn.style.display = 'none';

    const streamView = document.getElementById('stream-view');
    streamView.style.display = 'flex';

    const grid = document.getElementById('stream-grid');
    grid.innerHTML = '';

    // Wire Go Live button
    const goLiveBtn = document.getElementById('stream-go-live-btn');
    const goLiveNew = goLiveBtn.cloneNode(true);
    goLiveBtn.replaceWith(goLiveNew);
    goLiveNew.addEventListener('click', () => _startStreaming(serverId, channelId));

    // Wire Stop button
    const stopBtn = document.getElementById('stream-stop-btn');
    const stopNew = stopBtn.cloneNode(true);
    stopBtn.replaceWith(stopNew);
    stopNew.style.display = 'none';
    stopNew.addEventListener('click', () => _stopStreaming(serverId, channelId));

    // Listen for stream docs (each streamer has one)
    const streamsRef = db.collection('servers').doc(serverId)
      .collection('channels').doc(channelId)
      .collection('streams');

    const streamsUnsub = streamsRef.onSnapshot(snap => {
      if (!currentChat || currentChat.type !== 'streaming' || currentChat.channelId !== channelId) return;

      snap.docChanges().forEach(change => {
        const streamerUid = change.doc.id;
        const data = change.doc.data();

        if (change.type === 'added') {
          _addStreamCard(streamerUid, data.username || 'Someone');
          if (streamerUid === currentUser.uid && _localStream) {
            // Attach our own local stream to our card
            const myCard = document.querySelector('[data-stream-uid="' + streamerUid + '"]');
            if (myCard) {
              const vid = myCard.querySelector('video');
              if (vid) { vid.srcObject = _localStream; vid.play().catch(() => {}); }
            }
          } else if (streamerUid !== currentUser.uid) {
            _joinStream(serverId, channelId, streamerUid);
          }
        } else if (change.type === 'removed') {
          _removeStreamCard(streamerUid);
          // Close viewer PC for this streamer
          const vpc = _viewerPCs.get(streamerUid);
          if (vpc) { vpc.close(); _viewerPCs.delete(streamerUid); }
        }
      });

      // Show empty state or grid
      const empty = document.getElementById('stream-empty');
      if (snap.empty) {
        if (empty) empty.style.display = 'flex';
      } else {
        if (empty) empty.style.display = 'none';
      }
    });
    _streamUnsubs.push(streamsUnsub);
  }

  function _addStreamCard(streamerUid, username) {
    const grid = document.getElementById('stream-grid');
    if (grid.querySelector('[data-stream-uid="' + streamerUid + '"]')) return;

    const card = document.createElement('div');
    card.className = 'stream-card';
    card.dataset.streamUid = streamerUid;
    card.innerHTML =
      '<div class="stream-video-wrap">' +
        '<video autoplay playsinline muted></video>' +
        '<div class="stream-overlay">' +
          '<span class="stream-live-badge">LIVE</span>' +
        '</div>' +
        '<div class="stream-card-bar">' +
          '<span class="stream-card-name" title="' + esc(username) + '">' + esc(username) + '</span>' +
        '</div>' +
      '</div>' +
      '';
    grid.appendChild(card);
  }

  function _removeStreamCard(streamerUid) {
    const card = document.querySelector('[data-stream-uid="' + streamerUid + '"]');
    if (card) {
      const vid = card.querySelector('video');
      if (vid) vid.srcObject = null;
      card.remove();
    }
  }

  async function _startStreaming(serverId, channelId) {
    if (_isStreaming) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      showToast('Screen sharing is not supported on this device.', 'error');
      return;
    }
    try {
      _localStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: 'always',
          frameRate: { ideal: 60, max: 60 },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false
      });
    } catch (err) {
      if (err.name !== 'NotAllowedError') {
        showToast('Could not start screen share.', 'error');
      }
      return;
    }
    _isStreaming = true;
    _streamStartedAtMs = Date.now();
    _setStreamManagerLive(true);
    _setStreamManagePanelOpen(true);
    _startUptimeTimer();
    _updateStreamManagePanel();

    // Show stop button, hide go live
    document.getElementById('stream-stop-btn').style.display = '';
    document.getElementById('stream-go-live-btn').style.display = 'none';

    // If the user stops sharing via browser's native button
    _localStream.getVideoTracks()[0].addEventListener('ended', () => {
      _stopStreaming(serverId, channelId);
    });

    // Create our stream doc
    const streamRef = db.collection('servers').doc(serverId)
      .collection('channels').doc(channelId)
      .collection('streams').doc(currentUser.uid);
    await streamRef.set({
      username: userProfile.username || 'Someone',
      startedAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    // Listen for viewers joining our stream
    const viewersRef = streamRef.collection('viewers');
    const viewerUnsub = viewersRef.onSnapshot(snap => {
      snap.docChanges().forEach(change => {
        const viewerUid = change.doc.id;
        if (viewerUid === currentUser.uid) return;
        if (change.type === 'added') {
          _createStreamerPC(serverId, channelId, viewerUid);
        } else if (change.type === 'removed') {
          const pc = _streamerPCs.get(viewerUid);
          if (pc) { pc.close(); _streamerPCs.delete(viewerUid); }
        }
      });
    });
    _streamUnsubs.push(viewerUnsub);
  }

  async function _createStreamerPC(serverId, channelId, viewerUid) {
    const pc = new RTCPeerConnection(_rtcConfig);
    _streamerPCs.set(viewerUid, pc);
    _localStream.getTracks().forEach(track => {
      const sender = pc.addTrack(track, _localStream);
      if (track.kind === 'video' && sender && sender.getParameters) {
        const p = sender.getParameters() || {};
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = 3500000;
        p.encodings[0].maxFramerate = 60;
        sender.setParameters(p).catch(() => {});
      }
      if (track.kind === 'video') {
        try { track.contentHint = 'motion'; } catch (_) {}
      }
    });

    const viewerDocRef = db.collection('servers').doc(serverId)
      .collection('channels').doc(channelId)
      .collection('streams').doc(currentUser.uid)
      .collection('viewers').doc(viewerUid);

    pc.onicecandidate = e => {
      if (e.candidate) {
        viewerDocRef.collection('streamerCandidates').add(e.candidate.toJSON()).catch(() => {});
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await viewerDocRef.update({ offer: { type: offer.type, sdp: offer.sdp } }).catch(() => {});

    const answerUnsub = viewerDocRef.onSnapshot(snap => {
      const data = snap.data();
      if (data && data.answer && !pc.currentRemoteDescription) {
        pc.setRemoteDescription(new RTCSessionDescription(data.answer)).catch(() => {});
      }
    });
    _streamUnsubs.push(answerUnsub);

    const candidateUnsub = viewerDocRef.collection('viewerCandidates').onSnapshot(snap => {
      snap.docChanges().forEach(change => {
        if (change.type === 'added') {
          pc.addIceCandidate(new RTCIceCandidate(change.doc.data())).catch(() => {});
        }
      });
    });
    _streamUnsubs.push(candidateUnsub);
  }

  async function _stopStreaming(serverId, channelId) {
    if (!_isStreaming) return;
    _isStreaming = false;

    // Stop local tracks immediately
    if (_localStream) {
      _localStream.getTracks().forEach(t => t.stop());
      _localStream = null;
    }

    // Close all streamer PCs
    _streamerPCs.forEach(pc => pc.close());
    _streamerPCs.clear();

    // Show go live, hide stop
    const goLive = document.getElementById('stream-go-live-btn');
    const stop = document.getElementById('stream-stop-btn');
    if (goLive) goLive.style.display = '';
    if (stop) stop.style.display = 'none';
    _setStreamManagerLive(false);
    _setStreamManagePanelOpen(false);
    document.getElementById('stream-chat-window').style.display = 'none';
    if (_streamUptimeTimer) {
      clearInterval(_streamUptimeTimer);
      _streamUptimeTimer = null;
    }
    _streamStartedAtMs = null;
    _updateStreamManagePanel();

    // Delete our stream doc and subcollections
    const streamRef = db.collection('servers').doc(serverId)
      .collection('channels').doc(channelId)
      .collection('streams').doc(currentUser.uid);
    try {
      const viewers = await streamRef.collection('viewers').get();
      const batch = db.batch();
      for (const vDoc of viewers.docs) {
        const sCands = await vDoc.ref.collection('streamerCandidates').get();
        sCands.forEach(c => batch.delete(c.ref));
        const vCands = await vDoc.ref.collection('viewerCandidates').get();
        vCands.forEach(c => batch.delete(c.ref));
        batch.delete(vDoc.ref);
      }
      batch.delete(streamRef);
      await batch.commit();
    } catch (err) { console.error('Stop stream cleanup error:', err); }
  }

  function _captureStreamSnapshot() {
    if (!_localStream) {
      showToast('Start streaming first.', 'error');
      return;
    }
    const track = _localStream.getVideoTracks()[0];
    if (!track) return;
    const settings = track.getSettings ? track.getSettings() : {};
    const width = settings.width || 1280;
    const height = settings.height || 720;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const card = document.querySelector('[data-stream-uid="' + currentUser.uid + '"] video');
    if (!card) {
      showToast('Unable to capture frame.', 'error');
      return;
    }
    ctx.drawImage(card, 0, 0, width, height);
    canvas.toBlob(blob => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'stream-snapshot-' + Date.now() + '.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast('Snapshot saved.', 'success');
    }, 'image/png');
  }

  function _toggleStreamRecording() {
    if (!_localStream) {
      showToast('Start streaming first.', 'error');
      return;
    }
    if (_streamRecorder && _streamRecorder.state === 'recording') {
      _streamRecorder.stop();
      return;
    }
    try {
      _streamRecordChunks = [];
      _streamRecorder = new MediaRecorder(_localStream, { mimeType: 'video/webm;codecs=vp8' });
      _streamRecorder.ondataavailable = e => {
        if (e.data && e.data.size > 0) _streamRecordChunks.push(e.data);
      };
      _streamRecorder.onstop = () => {
        const blob = new Blob(_streamRecordChunks, { type: 'video/webm' });
        if (blob.size > 0) {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'stream-recording-' + Date.now() + '.webm';
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
          showToast('Recording downloaded.', 'success');
        }
        _streamRecordChunks = [];
        _updateStreamManagePanel();
      };
      _streamRecorder.start(1000);
      _updateStreamManagePanel();
      showToast('Recording started.', 'info');
    } catch (err) {
      console.error(err);
      showToast('Recording is not supported on this browser.', 'error');
    }
  }

  function _openStreamChatWindow() {
    if (!_streamContext || !_streamContext.serverId || !_streamContext.channelId) {
      showToast('Open a streaming channel first.', 'error');
      return;
    }
    document.getElementById('stream-chat-window').style.display = 'flex';
    document.getElementById('stream-chat-title').textContent = 'Stream Chat - ' + _streamContext.channelName;
    _listenStreamChat();
  }

  function _listenStreamChat() {
    if (!_streamContext) return;
    if (_streamChatUnsub) { _streamChatUnsub(); _streamChatUnsub = null; }
    const wrap = document.getElementById('stream-chat-messages');
    wrap.innerHTML = '<div class="chat-empty">Loading...</div>';
    _streamChatUnsub = db.collection('servers').doc(_streamContext.serverId)
      .collection('channels').doc(_streamContext.channelId)
      .collection('messages')
      .orderBy('createdAt', 'asc')
      .limitToLast(100)
      .onSnapshot(snap => {
        wrap.innerHTML = '';
        if (snap.empty) {
          wrap.innerHTML = '<div class="chat-empty">No messages yet. Start the conversation!</div>';
          return;
        }
        snap.forEach(doc => {
          wrap.appendChild(_renderStreamChatMessage(doc.data()));
        });
        wrap.scrollTop = wrap.scrollHeight;
      });
  }

  function _renderStreamChatMessage(data) {
    const row = document.createElement('div');
    row.className = 'stream-chat-msg';
    const prof = profileCache.get(data.uid) || {};
    const name = prof.username || data.username || 'User';
    let t = '';
    if (data.createdAt && data.createdAt.toDate) t = data.createdAt.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const parts = [];
    if (data.text) parts.push('<div class="stream-chat-msg-text">' + esc(data.text) + '</div>');
    if (data.images && data.images.length) {
      data.images.forEach(url => parts.push('<div class="stream-chat-msg-text"><a href="' + esc(url) + '" target="_blank" rel="noopener">Image</a></div>'));
    }
    if (data.videoUrl) parts.push('<div class="stream-chat-msg-text"><a href="' + esc(data.videoUrl) + '" target="_blank" rel="noopener">Video</a></div>');
    row.innerHTML =
      '<div class="stream-chat-msg-head"><strong>' + esc(name) + '</strong><span>' + esc(t) + '</span></div>' +
      parts.join('');
    return row;
  }

  function _addStreamChatFiles(fileList) {
    _streamChatFiles = _streamChatFiles.concat(Array.from(fileList));
    _renderStreamChatStaging();
  }

  function _addStreamChatVideo(file) {
    _streamChatVideo = file;
    if (_streamChatVideoUrl) URL.revokeObjectURL(_streamChatVideoUrl);
    _streamChatVideoUrl = URL.createObjectURL(file);
    _renderStreamChatStaging();
  }

  function _renderStreamChatStaging() {
    const el = document.getElementById('stream-chat-staging');
    const parts = [];
    if (_streamChatFiles.length) parts.push(_streamChatFiles.length + ' image(s) ready');
    if (_streamChatVideo) parts.push('1 video ready');
    if (!parts.length) {
      el.style.display = 'none';
      el.textContent = '';
      return;
    }
    el.style.display = 'block';
    el.textContent = parts.join(' • ');
  }

  async function _sendStreamChatMessage() {
    if (!_streamContext) return;
    const input = document.getElementById('stream-chat-input');
    const text = input.value.trim();
    const hasImages = _streamChatFiles.length > 0;
    const hasVideo = !!_streamChatVideo;
    if (!text && !hasImages && !hasVideo) return;
    input.value = '';

    let imageUrls = [];
    if (hasImages) {
      try {
        imageUrls = await Promise.all(_streamChatFiles.map(async f => {
          const fd = new FormData();
          fd.append('file', f);
          fd.append('upload_preset', CLOUDINARY_PRESET);
          const res = await fetch('https://api.cloudinary.com/v1_1/' + CLOUDINARY_CLOUD + '/image/upload', { method: 'POST', body: fd });
          const d = await res.json();
          if (!d.secure_url) throw new Error('Upload failed');
          return d.secure_url;
        }));
      } catch {
        showToast('Image upload failed.', 'error');
        return;
      }
      _streamChatFiles = [];
    }

    let videoUrl = '';
    if (hasVideo) {
      try {
        const fd = new FormData();
        fd.append('file', _streamChatVideo);
        fd.append('upload_preset', CLOUDINARY_PRESET);
        const res = await fetch('https://api.cloudinary.com/v1_1/' + CLOUDINARY_CLOUD + '/video/upload', { method: 'POST', body: fd });
        const d = await res.json();
        if (!d.secure_url) throw new Error('Upload failed');
        videoUrl = d.secure_url;
      } catch {
        showToast('Video upload failed.', 'error');
        return;
      }
      if (_streamChatVideoUrl) URL.revokeObjectURL(_streamChatVideoUrl);
      _streamChatVideoUrl = null;
      _streamChatVideo = null;
    }

    _renderStreamChatStaging();

    const msgData = {
      uid: currentUser.uid,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    if (text) msgData.text = text;
    if (imageUrls.length) msgData.images = imageUrls;
    if (videoUrl) msgData.videoUrl = videoUrl;

    try {
      await db.collection('servers').doc(_streamContext.serverId)
        .collection('channels').doc(_streamContext.channelId)
        .collection('messages').add(msgData);
    } catch {
      showToast('Failed to send stream chat message.', 'error');
    }
  }

  async function _joinStream(serverId, channelId, streamerUid) {
    if (_viewerPCs.has(streamerUid)) return;

    const streamRef = db.collection('servers').doc(serverId)
      .collection('channels').doc(channelId)
      .collection('streams').doc(streamerUid);
    const viewerDocRef = streamRef.collection('viewers').doc(currentUser.uid);

    await viewerDocRef.set({ joined: true });

    const pc = new RTCPeerConnection(_rtcConfig);
    _viewerPCs.set(streamerUid, pc);

    pc.ontrack = e => {
      const card = document.querySelector('[data-stream-uid="' + streamerUid + '"]');
      if (card && e.streams[0]) {
        const vid = card.querySelector('video');
        if (vid) { vid.srcObject = e.streams[0]; vid.play().catch(() => {}); }
      }
    };

    pc.onicecandidate = e => {
      if (e.candidate) {
        viewerDocRef.collection('viewerCandidates').add(e.candidate.toJSON()).catch(() => {});
      }
    };

    const offerUnsub = viewerDocRef.onSnapshot(async snap => {
      const data = snap.data();
      if (!data || !data.offer) return;
      if (pc.currentRemoteDescription) return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await viewerDocRef.update({ answer: { type: answer.type, sdp: answer.sdp } });
      } catch (err) { console.error('Viewer offer handling error:', err); }
    });
    _streamUnsubs.push(offerUnsub);

    const candidateUnsub = viewerDocRef.collection('streamerCandidates').onSnapshot(snap => {
      snap.docChanges().forEach(change => {
        if (change.type === 'added') {
          pc.addIceCandidate(new RTCIceCandidate(change.doc.data())).catch(() => {});
        }
      });
    });
    _streamUnsubs.push(candidateUnsub);
  }

  // Cleanup on page unload
  window.addEventListener('beforeunload', () => {
    if (_isStreaming && currentChat && currentChat.type === 'streaming') {
      const streamRef = db.collection('servers').doc(currentChat.serverId)
        .collection('channels').doc(currentChat.channelId)
        .collection('streams').doc(currentUser.uid);
      streamRef.delete().catch(() => {});
    }
    _cleanupStreaming();
  });

  async function _deleteMessage(docRef, data) {
    const cached = data && profileCache.get(data.uid);
    const username = (cached && cached.username) || (data && data.username) || 'Unknown';
    const avatar   = (cached && cached.avatar)   || (data && data.avatar)   || '';
    let preview = (data && data.text) || '';
    if (!preview && data && data.images && data.images.length) preview = '[image]';
    if (!preview && data && data.gifUrl) preview = '[GIF]';
    if (!preview && data && data.videoUrl) preview = '[video]';

    _showConfirm({
      title: 'Delete Message',
      avatar,
      username,
      preview,
      onConfirm: async () => {
        try { await docRef.delete(); }
        catch { showToast('Failed to delete message.', 'error'); }
      }
    });
  }

  /* ── Leave Chat (non-friend DMs) ── */
  function _confirmLeaveChat(otherUid, otherName) {
    const overlay = document.getElementById('leave-chat-modal');
    if (!overlay) return;
    overlay.querySelector('.leave-modal-name').textContent = otherName;
    overlay.classList.add('open');

    const confirmBtn = overlay.querySelector('#leave-modal-ok');
    const cancelBtn = overlay.querySelector('#leave-modal-cancel');
    const confirmNew = confirmBtn.cloneNode(true);
    const cancelNew = cancelBtn.cloneNode(true);
    confirmBtn.replaceWith(confirmNew);
    cancelBtn.replaceWith(cancelNew);

    const close = () => overlay.classList.remove('open');
    cancelNew.addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); }, { once: true });
    confirmNew.addEventListener('click', async () => {
      close();
      try {
        const convoId = [currentUser.uid, otherUid].sort().join('_');
        const msgs = await db.collection('dms').doc(convoId).collection('messages').get();
        const batch = db.batch();
        msgs.forEach(d => batch.delete(d.ref));
        batch.delete(db.collection('dms').doc(convoId));
        await batch.commit();
        if (chatUnsub) { chatUnsub(); chatUnsub = null; }
        _dmProfiles.delete(otherUid);
        currentChat = null;
        document.getElementById('chat-messages').innerHTML = '<div class="chat-empty">Select a friend or channel to start chatting</div>';
        document.getElementById('chat-title').textContent = 'Select a conversation';
        document.getElementById('chat-input-bar').style.display = 'none';
        document.getElementById('leave-chat-btn').style.display = 'none';
        _renderDMFriendsList();
        showToast('Chat deleted.', 'success');
      } catch (err) {
        console.error(err);
        showToast('Failed to delete chat.', 'error');
      }
    });
  }

  /* ── Utility ── */
  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  /* ── Render text with clickable links ── */
  function _renderMessageText(text) {
    if (!text) return '';
    const urlRegex = /(https?:\/\/[^\s<>"{}|\\^[\]`]+)/g;
    return text.split(urlRegex).map((part, i) => {
      const d = document.createElement('div');
      d.textContent = part;
      if (i % 2 === 1) {
        return '<a class="msg-link" href="' + d.innerHTML + '" target="_blank" rel="noopener noreferrer">' + d.innerHTML + '</a>';
      }
      return d.innerHTML;
    }).join('');
  }

  /* ── Extract YouTube video ID from a URL ── */
  function _extractYouTubeId(text) {
    if (!text) return null;
    const m = text.match(/(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_\-]{11})/);
    return m ? m[1] : null;
  }

  /* ── Patch already-rendered messages when profileCache updates ── */
  function _patchRenderedMessages(uid) {
    const cached = profileCache.get(uid);
    if (!cached) return;
    const initial = (cached.username || 'U').charAt(0).toUpperCase();
    const avatarHTML = cached.avatar
      ? '<img src="' + esc(cached.avatar) + '" alt="">'
      : initial;
    document.querySelectorAll('.msg[data-uid="' + uid + '"]').forEach(div => {
      const av = div.querySelector('.msg-avatar');
      if (av) {
        av.innerHTML = avatarHTML + '<span class="status-dot ' + (cached.effectiveStatus || 'offline') + '"></span>';
      }
      const author = div.querySelector('.msg-author');
      if (author) author.textContent = cached.username || 'Unknown';
    });
  }

  /* ── Server GIF library sync ── */
  function _syncServerGifListeners(serverIds) {
    // Remove listeners for servers we've left
    _serverGifUnsubs.forEach((unsub, sid) => {
      if (!serverIds.has(sid)) {
        unsub();
        _serverGifUnsubs.delete(sid);
        _serverGifs.delete(sid);
      }
    });
    // Add listeners for newly joined servers
    serverIds.forEach(sid => {
      if (_serverGifUnsubs.has(sid)) return;
      const unsub = db.collection('servers').doc(sid).collection('gifs')
        .orderBy('createdAt', 'desc').limit(100)
        .onSnapshot(snap => {
          const gifs = [];
          snap.forEach(d => gifs.push({ id: d.id, ...d.data() }));
          _serverGifs.set(sid, gifs);
          // Refresh GIF tab if currently visible
          if (_pickerOpen && _pickerTab === 'gif') _renderGifTab();
        });
      _serverGifUnsubs.set(sid, unsub);
    });
  }

  function _allGifs() {
    const seen = new Set();
    const result = [];
    _serverGifs.forEach(gifs => gifs.forEach(g => { if (!seen.has(g.url)) { seen.add(g.url); result.push(g); } }));
    _dmMediaGifs.forEach(gifs => gifs.forEach(g => { if (!seen.has(g.url)) { seen.add(g.url); result.push(g); } }));
    return result;
  }

  /* ── Send a GIF message ── */
  async function _sendGif(gifUrl) {
    if (!currentChat) { showToast('Open a chat first.', 'error'); return; }
    _closePicker();
    const msgData = {
      text: '',
      gifUrl,
      uid: currentUser.uid,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    try {
      if (currentChat.type === 'dm') {
        const convoId = [currentUser.uid, currentChat.friendUid].sort().join('_');
        await db.collection('dms').doc(convoId).collection('messages').add(msgData);
      } else if (currentChat.type === 'channel') {
        await db.collection('servers').doc(currentChat.serverId)
          .collection('channels').doc(currentChat.channelId)
          .collection('messages').add(msgData);
        // Add to server GIF library if not already there
        const gifCol = db.collection('servers').doc(currentChat.serverId).collection('gifs');
        const existing = await gifCol.where('url', '==', gifUrl).limit(1).get();
        if (existing.empty) {
          await gifCol.add({ url: gifUrl, uploadedBy: currentUser.uid, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
        }
      }
    } catch (err) {
      console.error('Send GIF failed:', err);
      showToast('Failed to send GIF.', 'error');
    }
  }

  /* ── Upload a new GIF and send it ── */
  async function _uploadAndSendGif(file) {
    if (!file || !file.type.startsWith('image/')) return;
    if (file.size > 10 * 1024 * 1024) { showToast('Image must be under 10 MB', 'error'); return; }
    showToast('Uploading...', 'info');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('upload_preset', CLOUDINARY_PRESET);
      const res = await fetch('https://api.cloudinary.com/v1_1/' + CLOUDINARY_CLOUD + '/image/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (data.secure_url) {
        await _sendGif(data.secure_url);
      } else {
        showToast('Upload failed.', 'error');
      }
    } catch {
      showToast('Upload failed.', 'error');
    }
    document.getElementById('gif-upload-input').value = '';
  }

  /* ── Emoji/GIF Picker ── */
  const _EMOJI_CATS = [
    { label: 'Smileys & Emotion', icon: '😀', emojis: [
      '😀','😃','😄','😁','😆','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😙','😚',
      '😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒',
      '🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵','🥶','🥴',
      '😵','🤯','🤠','🥳','🥸','😎','🤓','🧐','😕','😟','🙁','☹️','😮','😯','😲','😳','🥺',
      '😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡',
      '😠','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖',
      '😺','😸','😹','😻','😼','😽','🙀','😿','😾'
    ]},
    { label: 'People & Body', icon: '👋', emojis: [
      '👋','🤚','🖐️','✋','🖖','🫱','🫲','🫳','🫴','🤙','👌','🤌','🤏','✌️','🤞','🤟','🤘',
      '👈','👉','👆','🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','🤝','👏','🙌','🫶','👐',
      '🤲','🙏','✍️','💅','🤳','💪','🦾','🦿','🦵','🦶','👂','🦻','👃','👁️','👀','👄','🦷',
      '🫦','🦴','💋','👤','👥','🫂',
      '👶','🧒','👦','👧','🧑','👱','👨','🧔','👩','👴','👵','🧓',
      '👮','🕵️','💂','🥷','👷','🤴','👸','🧙','🧚','🧛','🧜','🧝','🧞','🧟','🧌',
      '💃','🕺','👼','🤰','🤱','🎅','🤶','🦸','🦹','🧑‍⚕️','🧑‍🎓','🧑‍🏫','🧑‍🍳','🧑‍🌾'
    ]},
    { label: 'Animals & Nature', icon: '🐶', emojis: [
      '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🙈','🙉','🙊',
      '🐔','🐧','🐦','🐤','🦆','🦅','🦉','🦇','🐺','🐴','🦄','🐝','🪱','🐛','🦋','🐌','🐞','🐜',
      '🦟','🦗','🦂','🐢','🦎','🐍','🦕','🦖','🦈','🐬','🐳','🐋','🦭','🐟','🐠','🐡','🐙','🦑',
      '🦐','🦞','🦀','🐊','🐅','🐆','🦓','🦍','🦣','🐘','🦛','🦏','🐪','🐫','🦒','🦬','🐃','🐂',
      '🐄','🐎','🐖','🐏','🐑','🦙','🐐','🦌','🐕','🐩','🦮','🐈','🐇','🦝','🦨','🦡','🦫','🦦',
      '🐿️','🦔','🐾',
      '🌸','🌺','🌻','🌹','🌷','🌼','🍀','🌿','🍃','🍂','🍁','🌲','🌳','🌴','🌵','🎋','🎍','🍄',
      '🌾','💐','🪸','🌱','☘️','🪨','🪵',
      '🌈','⛅','🌤️','⛈️','🌩️','🌨️','❄️','⛄','🌊','🌬️','🌀','🌪️','🌫️','🌡️','☀️','🌙','⭐','🌟',
      '🌠','🌌','🌍','🌎','🌏','🌑','🌒','🌓','🌔','🌕','🌖','🌗','🌘'
    ]},
    { label: 'Food & Drink', icon: '🍕', emojis: [
      '🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍑','🍒','🥭','🍍','🥥','🥝',
      '🍅','🍆','🥑','🥦','🥬','🥒','🌶️','🫑','🧄','🧅','🥕','🌽','🍠','🥜','🫒','🧅',
      '🥐','🥯','🍞','🥖','🥨','🧀','🥚','🍳','🥞','🧇','🥓','🥩','🍗','🍖','🌭','🍔','🍟',
      '🍕','🫓','🥪','🥙','🧆','🌮','🌯','🫔','🥗','🥘','🫕','🍝','🍜','🍲','🍛','🍣','🍱',
      '🥟','🦪','🍤','🍙','🍚','🍘','🍥','🥮','🍢','🧁','🍰','🎂','🍮','🍭','🍬','🍫','🍿',
      '🍩','🍪','🌰','🍯','🧃','🥤','🧋','🍵','☕','🫖','🍶','🍺','🍻','🥂','🍷','🥃','🍸',
      '🍹','🍾','🧉','🧊','🥛','🍼','🫗','🍴','🍽️','🥢','🧂'
    ]},
    { label: 'Activities', icon: '⚽', emojis: [
      '⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🏓','🏸','🥊','🥋','🥅','⛳','🎣',
      '🤿','🎿','🛷','⛷️','🏂','🪂','🏋️','🤼','🤸','🏄','🧗','🏊','🚴','🧘','🛹','🛼','🛺',
      '🏆','🥇','🥈','🥉','🎖️','🏅','🎗️','🎟️',
      '🎮','🕹️','🎲','♟️','🎯','🎳','🎰','🎨','🖼️','🎬','🎤','🎧','🎼','🎵','🎶','🎷','🎸',
      '🎹','🎺','🎻','🪕','🥁','🪘','🎙️','📻',
      '🎪','🎭','🎡','🎢','🎠','🎁','🎀','🎈','🎉','🎊','🎋','🎍','🎑','🎃','🎄','🧨','✨','🎆','🎇'
    ]},
    { label: 'Travel & Places', icon: '✈️', emojis: [
      '🚗','🚕','🚙','🚌','🚎','🚐','🚑','🚒','🚓','🚔','🚘','🚖','🚚','🚛','🚜','🏎️','🛻',
      '🚲','🛵','🏍️','🛺','🚡','🚠','🚟','🚃','🚋','🚞','🚝','🚄','🚅','🚈','🚂','🚆','🚇',
      '✈️','🛩️','🛫','🛬','💺','🚁','🛸','🚀','🛶','⛵','🚤','🛥️','🛳️','⛴️','🚢',
      '⛽','🛑','🚦','🚥','🗺️','🧭',
      '🗿','🗼','🗽','⛪','🕌','🛕','⛩️','🕍','🏛️','🏟️','🏠','🏡','🏢','🏣','🏤','🏥',
      '🏦','🏨','🏩','🏪','🏫','🏬','🏭','🏗️','🏰','🏯','⛰️','🌋','🗻','🏕️','🏖️','🏜️',
      '🏝️','🏞️','🌆','🌇','🌉','🌃','🌌','🌁','🗾','🌐','🌍','🌎','🌏'
    ]},
    { label: 'Objects', icon: '💡', emojis: [
      '📱','💻','🖥️','🖨️','⌨️','🖱️','🖲️','💾','💿','📀','📷','📸','📹','🎥','📽️','🎞️',
      '📺','📻','🧭','⏱️','⏲️','⏰','🕰️','⌛','⏳','📡','🔋','🪫','🔌','💡','🔦','🕯️','🪔',
      '💸','💵','💴','💶','💷','💰','💳','🪙','💎','⚖️','🪜','🧲','🔧','🔨','⚒️','🛠️',
      '⛏️','🪚','🔩','🪛','🔑','🗝️','🔐','🔒','🔓',
      '🎁','📦','📫','📪','📬','📭','📮','🗳️','✏️','✒️','🖋️','🖊️','📝',
      '📓','📔','📒','📕','📗','📘','📙','📚','📖','🔖','🏷️',
      '🔍','🔎','🗑️','🩺','🩻','🩹','💊','💉','🩸','🧿','🪬','🧸','🪆','🎭','🎩',
      '🧵','🧶','🪡','🧷','🪢','🪑','🛋️','🚪','🪞','🪟','🛏️','🛁','🚿','🪥','🧴','🧹','🧺','🧻'
    ]},
    { label: 'Symbols', icon: '❤️', emojis: [
      '❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟',
      '☮️','✝️','☪️','🕉️','✡️','🔯','🕎','☯️','☦️','🛐','♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓',
      '🔀','🔁','🔂','▶️','⏩','⏭️','⏯️','◀️','⏪','⏮️','🔼','⏫','🔽','⏬','⏸️','⏹️','⏺️','⏏️',
      '🔔','🔕','📣','📢','💬','💭','🗯️','💯','✅','❎','❌','⭕','🛑','⛔','📛','🚳','🚭','🚯',
      '🚱','🚷','📵','🔞','☢️','☣️',
      '⬆️','↗️','➡️','↘️','⬇️','↙️','⬅️','↖️','↕️','↔️','↩️','↪️','⤴️','⤵️','🔄','🔃','♻️','🚫',
      '🆗','🆕','🆙','🆓','🆒','🆖','🅰️','🅱️','🆎','🆑','🅾️','🆘',
      '1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','0️⃣','#️⃣','*️⃣','🔟',
      '🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','🟤','🔺','🔻','🔷','🔶','🔹','🔸','🔲','🔳','▪️','▫️'
    ]},
    { label: 'Flags', icon: '🏳️', emojis: [
      '🏳️','🏴','🏁','🚩','🏳️‍🌈','🏳️‍⚧️','🏴‍☠️',
      '🇺🇸','🇬🇧','🇨🇦','🇦🇺','🇩🇪','🇫🇷','🇯🇵','🇰🇷','🇨🇳','🇮🇳','🇧🇷','🇲🇽',
      '🇷🇺','🇮🇹','🇪🇸','🇵🇹','🇳🇱','🇧🇪','🇸🇪','🇳🇴','🇩🇰','🇫🇮','🇵🇱','🇨🇭',
      '🇦🇹','🇬🇷','🇹🇷','🇸🇦','🇦🇪','🇮🇱','🇿🇦','🇳🇿','🇦🇷','🇨🇴','🇨🇱','🇵🇪',
      '🇪🇬','🇳🇬','🇰🇪','🇬🇭','🇪🇹','🇨🇩','🇹🇿','🇺🇦','🇸🇬','🇲🇾','🇮🇩','🇹🇭','🇻🇳','🇵🇭'
    ]}
  ];

  function _togglePicker() {
    _pickerOpen ? _closePicker() : _openPicker();
  }

  function _openPicker() {
    _pickerOpen = true;
    const panel = document.getElementById('picker-panel');
    panel.style.display = 'flex';
    _renderPickerTabContent(_pickerTab);
  }

  function _closePicker() {
    _pickerOpen = false;
    document.getElementById('picker-panel').style.display = 'none';
  }

  function _switchPickerTab(tab) {
    _pickerTab = tab;
    document.querySelectorAll('.picker-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.getElementById('picker-emoji-tab').style.display   = tab === 'emoji'  ? '' : 'none';
    document.getElementById('picker-gif-tab').style.display     = tab === 'gif'    ? '' : 'none';
    document.getElementById('picker-images-tab').style.display  = tab === 'images' ? '' : 'none';
    document.getElementById('picker-videos-tab').style.display  = tab === 'videos' ? '' : 'none';
    _renderPickerTabContent(tab);
  }

  function _renderPickerTabContent(tab) {
    if (tab === 'emoji')       _renderEmojiTab();
    else if (tab === 'gif')    _renderGifTab();
    else if (tab === 'images') _renderImagesTab();
    else if (tab === 'videos') _renderVideosTab();
  }

  function _renderEmojiTab() {
    const tab = document.getElementById('picker-emoji-tab');
    if (tab.hasChildNodes()) return; // already built

    // Category nav (sticky)
    const nav = document.createElement('div');
    nav.className = 'emoji-cat-nav';
    _EMOJI_CATS.forEach((cat, i) => {
      const btn = document.createElement('button');
      btn.className = 'emoji-cat-btn' + (i === 0 ? ' active' : '');
      btn.title = cat.label;
      btn.textContent = cat.icon;
      btn.dataset.cat = String(i);
      nav.appendChild(btn);
    });
    tab.appendChild(nav);

    // Scrollable emoji area
    const scroll = document.createElement('div');
    scroll.className = 'emoji-scroll-area';

    _EMOJI_CATS.forEach((cat, i) => {
      const section = document.createElement('div');
      section.className = 'emoji-cat-section';
      section.id = 'emoji-cat-' + i;

      const label = document.createElement('div');
      label.className = 'emoji-cat-label';
      label.textContent = cat.label;
      section.appendChild(label);

      const grid = document.createElement('div');
      grid.className = 'emoji-grid';
      cat.emojis.forEach(em => {
        const btn = document.createElement('button');
        btn.className = 'emoji-btn';
        btn.textContent = em;
        btn.addEventListener('click', () => {
          const input = document.getElementById('chat-input');
          const pos = input.selectionStart || input.value.length;
          const val = input.value;
          input.value = val.slice(0, pos) + em + val.slice(pos);
          input.focus();
          const np = pos + em.length;
          input.setSelectionRange(np, np);
        });
        grid.appendChild(btn);
      });
      section.appendChild(grid);
      scroll.appendChild(section);
    });

    tab.appendChild(scroll);

    // Scroll to category on nav click
    nav.querySelectorAll('.emoji-cat-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        nav.querySelectorAll('.emoji-cat-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const section = document.getElementById('emoji-cat-' + btn.dataset.cat);
        if (section) scroll.scrollTop = section.offsetTop;
      });
    });

    // Update active category while scrolling
    scroll.addEventListener('scroll', () => {
      let current = 0;
      _EMOJI_CATS.forEach((_, i) => {
        const s = document.getElementById('emoji-cat-' + i);
        if (s && scroll.scrollTop >= s.offsetTop - 4) current = i;
      });
      nav.querySelectorAll('.emoji-cat-btn').forEach((b, i) => b.classList.toggle('active', i === current));
    }, { passive: true });
  }

  function _renderGifTab() {
    const tab = document.getElementById('picker-gif-tab');
    const gifs = _allGifs();
    tab.innerHTML = gifs.length
      ? '<div class="gif-grid">' +
        gifs.map(g => '<img class="gif-item" src="' + esc(g.url) + '" alt="GIF" data-url="' + esc(g.url) + '" loading="lazy">').join('') +
        '</div>'
      : '<div class="gif-empty">No GIFs yet — use the image button in the chat bar to upload one!</div>';
    tab.querySelectorAll('.gif-item').forEach(img => {
      img.addEventListener('click', () => _sendGif(img.dataset.url));
    });
  }


  function _renderImagesTab() {
    const tab = document.getElementById('picker-images-tab');
    const images = _allImages();
    tab.innerHTML = images.length
      ? '<div class="gif-grid">' +
        images.map(i => '<img class="gif-item" src="' + esc(i.url) + '" alt="Image" data-url="' + esc(i.url) + '" loading="lazy">').join('') +
        '</div>'
      : '<div class="gif-empty">No images yet \u2014 send one in a channel to populate this library!</div>';
    tab.querySelectorAll('.gif-item').forEach(img => {
      img.addEventListener('click', () => _sendImageFromPicker(img.dataset.url));
    });
  }

  function _renderVideosTab() {
    const tab = document.getElementById('picker-videos-tab');
    const videos = _allVideos();
    tab.innerHTML = videos.length
      ? '<div class="gif-grid">' +
        videos.map(v =>
          '<div class="video-picker-item" data-url="' + esc(v.url) + '">' +
          '<video class="video-picker-thumb" src="' + esc(v.url) + '" preload="metadata" muted></video>' +
          '<div class="video-picker-play">\u25b6</div>' +
          '</div>'
        ).join('') +
        '</div>'
      : '<div class="gif-empty">No videos yet — use the video button in the chat bar to upload one!</div>';
    tab.querySelectorAll('.video-picker-item').forEach(el => {
      el.addEventListener('click', () => _sendVideoFromPicker(el.dataset.url));
    });
  }

  async function _sendImageFromPicker(imageUrl) {
    if (!currentChat) { showToast('Open a chat first.', 'error'); return; }
    _closePicker();
    const msgData = {
      text: '',
      images: [imageUrl],
      uid: currentUser.uid,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    try {
      if (currentChat.type === 'dm') {
        const convoId = [currentUser.uid, currentChat.friendUid].sort().join('_');
        await db.collection('dms').doc(convoId).collection('messages').add(msgData);
      } else if (currentChat.type === 'channel') {
        await db.collection('servers').doc(currentChat.serverId)
          .collection('channels').doc(currentChat.channelId)
          .collection('messages').add(msgData);
      }
    } catch (err) {
      console.error('Send image failed:', err);
      showToast('Failed to send image.', 'error');
    }
  }

  async function _sendVideoFromPicker(videoUrl) {
    if (!currentChat) { showToast('Open a chat first.', 'error'); return; }
    _closePicker();
    const msgData = {
      text: '',
      videoUrl,
      uid: currentUser.uid,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    try {
      if (currentChat.type === 'dm') {
        const convoId = [currentUser.uid, currentChat.friendUid].sort().join('_');
        await db.collection('dms').doc(convoId).collection('messages').add(msgData);
      } else if (currentChat.type === 'channel') {
        await db.collection('servers').doc(currentChat.serverId)
          .collection('channels').doc(currentChat.channelId)
          .collection('messages').add(msgData);
      }
    } catch (err) {
      console.error('Send video failed:', err);
      showToast('Failed to send video.', 'error');
    }
  }

  function _syncServerImageListeners(serverIds) {
    _serverImageUnsubs.forEach((unsub, sid) => {
      if (!serverIds.has(sid)) {
        unsub();
        _serverImageUnsubs.delete(sid);
        _serverImages.delete(sid);
      }
    });
    serverIds.forEach(sid => {
      if (_serverImageUnsubs.has(sid)) return;
      const unsub = db.collection('servers').doc(sid).collection('images')
        .orderBy('createdAt', 'desc').limit(100)
        .onSnapshot(snap => {
          const imgs = [];
          snap.forEach(d => imgs.push({ id: d.id, ...d.data() }));
          _serverImages.set(sid, imgs);
          if (_pickerOpen && _pickerTab === 'images') _renderImagesTab();
        });
      _serverImageUnsubs.set(sid, unsub);
    });
  }

  function _syncServerVideoListeners(serverIds) {
    _serverVideoUnsubs.forEach((unsub, sid) => {
      if (!serverIds.has(sid)) {
        unsub();
        _serverVideoUnsubs.delete(sid);
        _serverVideos.delete(sid);
      }
    });
    serverIds.forEach(sid => {
      if (_serverVideoUnsubs.has(sid)) return;
      const unsub = db.collection('servers').doc(sid).collection('videos')
        .orderBy('createdAt', 'desc').limit(50)
        .onSnapshot(snap => {
          const vids = [];
          snap.forEach(d => vids.push({ id: d.id, ...d.data() }));
          _serverVideos.set(sid, vids);
          if (_pickerOpen && _pickerTab === 'videos') _renderVideosTab();
        });
      _serverVideoUnsubs.set(sid, unsub);
    });
  }

  function _syncDMMediaListeners(convoIds) {
    _dmMediaUnsubs.forEach((unsub, cid) => {
      if (!convoIds.has(cid)) {
        unsub();
        _dmMediaUnsubs.delete(cid);
        _dmMediaImages.delete(cid);
        _dmMediaVideos.delete(cid);
        _dmMediaGifs.delete(cid);
      }
    });
    convoIds.forEach(cid => {
      if (_dmMediaUnsubs.has(cid)) return;
      const unsubImgs = db.collection('dms').doc(cid).collection('images')
        .orderBy('createdAt', 'desc').limit(100)
        .onSnapshot(snap => {
          _dmMediaImages.set(cid, snap.docs.map(d => ({ id: d.id, ...d.data() })));
          if (_pickerOpen && _pickerTab === 'images') _renderImagesTab();
        });
      const unsubVids = db.collection('dms').doc(cid).collection('videos')
        .orderBy('createdAt', 'desc').limit(50)
        .onSnapshot(snap => {
          _dmMediaVideos.set(cid, snap.docs.map(d => ({ id: d.id, ...d.data() })));
          if (_pickerOpen && _pickerTab === 'videos') _renderVideosTab();
        });
      const unsubGifs = db.collection('dms').doc(cid).collection('gifs')
        .orderBy('createdAt', 'desc').limit(100)
        .onSnapshot(snap => {
          _dmMediaGifs.set(cid, snap.docs.map(d => ({ id: d.id, ...d.data() })));
          if (_pickerOpen && _pickerTab === 'gif') _renderGifTab();
        });
      _dmMediaUnsubs.set(cid, () => { unsubImgs(); unsubVids(); unsubGifs(); });
    });
  }

  function _allImages() {
    const seen = new Set();
    const result = [];
    _serverImages.forEach(imgs => imgs.forEach(i => { if (!seen.has(i.url)) { seen.add(i.url); result.push(i); } }));
    _dmMediaImages.forEach(imgs => imgs.forEach(i => { if (!seen.has(i.url)) { seen.add(i.url); result.push(i); } }));
    return result;
  }

  function _allVideos() {
    const seen = new Set();
    const result = [];
    _serverVideos.forEach(vids => vids.forEach(v => { if (!seen.has(v.url)) { seen.add(v.url); result.push(v); } }));
    _dmMediaVideos.forEach(vids => vids.forEach(v => { if (!seen.has(v.url)) { seen.add(v.url); result.push(v); } }));
    return result;
  }

  /* ── Image Attachment Staging ── */
  function _addStagedFiles(fileList) {
    const arr = Array.from(fileList);
    for (const f of arr) {
      if (_stagedFiles.length >= 4) { showToast('Max 4 images per message', 'warn'); break; }
      if (!f.type.startsWith('image/')) continue;
      if (f.size > 10 * 1024 * 1024) { showToast('Image too large (max 10 MB)', 'error'); continue; }
      _stagedFiles.push(f);
      _stagedObjectUrls.push(URL.createObjectURL(f));
    }
    _renderStagedPreviews();
  }

  function _renderStagedPreviews() {
    const bar = document.getElementById('attachment-staging');
    const hasContent = _stagedFiles.length > 0 || _stagedVideo !== null;
    if (!hasContent) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
    bar.style.display = 'flex';
    let html = _stagedObjectUrls.map((url, i) =>
      '<div class="attachment-thumb-wrap">' +
        '<img class="attachment-thumb" src="' + url + '" alt="">' +
        '<button class="attachment-remove" data-idx="' + i + '" title="Remove">\u00d7</button>' +
      '</div>'
    ).join('');
    if (_stagedVideo) {
      html += '<div class="attachment-thumb-wrap attachment-video-wrap">' +
        '<video class="attachment-thumb" src="' + _stagedVideoUrl + '" muted preload="metadata"></video>' +
        '<button class="attachment-remove attachment-remove-video" title="Remove">\u00d7</button>' +
        '<span class="attachment-video-label">Video</span>' +
      '</div>';
    }
    if (_stagedFiles.length) {
      html += '<span class="attachment-count">' + _stagedFiles.length + '/4</span>';
    }
    bar.innerHTML = html;
    bar.querySelectorAll('.attachment-remove:not(.attachment-remove-video)').forEach(btn => {
      btn.addEventListener('click', () => _removeStagedFile(parseInt(btn.dataset.idx)));
    });
    const videoRemoveBtn = bar.querySelector('.attachment-remove-video');
    if (videoRemoveBtn) {
      videoRemoveBtn.addEventListener('click', () => {
        URL.revokeObjectURL(_stagedVideoUrl);
        _stagedVideo = null;
        _stagedVideoUrl = null;
        _renderStagedPreviews();
      });
    }
  }

  function _removeStagedFile(idx) {
    URL.revokeObjectURL(_stagedObjectUrls[idx]);
    _stagedFiles.splice(idx, 1);
    _stagedObjectUrls.splice(idx, 1);
    _renderStagedPreviews();
  }

  function _addStagedVideo(file) {
    if (!file.type.startsWith('video/')) { showToast('Please select a video file.', 'error'); return; }
    if (file.size > 50 * 1024 * 1024) { showToast('Video must be under 50 MB.', 'error'); return; }
    if (_stagedVideo) URL.revokeObjectURL(_stagedVideoUrl);
    _stagedVideo = file;
    _stagedVideoUrl = URL.createObjectURL(file);
    _renderStagedPreviews();
  }

  /* ── Lightbox ── */
  function _openLightbox(src) {
    _lightboxScale = 1;
    _lightboxPanX = 0;
    _lightboxPanY = 0;
    const overlay = document.getElementById('lightbox');
    const img = document.getElementById('lightbox-img');
    img.src = src;
    _applyLightboxTransform();
    document.getElementById('lightbox-zoom-level').textContent = '100%';
    overlay.classList.add('open');
  }

  function _closeLightbox() {
    document.getElementById('lightbox').classList.remove('open');
    _lightboxScale = 1;
    _lightboxPanX = 0;
    _lightboxPanY = 0;
  }

  function _lightboxZoom(delta) {
    _lightboxScale = Math.min(5, Math.max(0.25, _lightboxScale + delta));
    if (_lightboxScale <= 1) { _lightboxPanX = 0; _lightboxPanY = 0; }
    _applyLightboxTransform();
    document.getElementById('lightbox-zoom-level').textContent = Math.round(_lightboxScale * 100) + '%';
    document.getElementById('lightbox-img').style.cursor = _lightboxScale > 1 ? 'grab' : '';
  }

  function _applyLightboxTransform() {
    document.getElementById('lightbox-img').style.transform =
      'translate(' + _lightboxPanX + 'px, ' + _lightboxPanY + 'px) scale(' + _lightboxScale + ')';
  }

  return { init };
})();
