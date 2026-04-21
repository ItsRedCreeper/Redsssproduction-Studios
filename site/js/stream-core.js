/* Stream Core host tab: runs streamer capture + WebRTC signaling in a background tab. */

(() => {
  const STREAM_STATE_KEY = 'rps_stream_state_v1';
  const STREAM_CMD_KEY = 'rps_stream_cmd_v1';
  const STREAM_PENDING_START_KEY = 'rps_stream_pending_start_v1';

  let currentUser = null;
  let localStream = null;
  let streamContext = null; // { serverId, channelId, channelName, username, controllerUrl }
  let startedAt = 0;
  let isLive = false;
  let isStarting = false;
  let lastCmdId = null;

  let livekitRoom = null;
  const streamUnsubs = [];
  let streamControlChannel = null;

  let recorder = null;
  let recordChunks = [];

  const LIVEKIT_URL = 'wss://redsssproduction-studios-aiosfout.livekit.cloud';

  async function _getLiveKitToken(roomName, canPublish) {
    if (!roomName) throw new Error('Room name is empty — stream context not ready');
    const idToken = await auth.currentUser.getIdToken(/* forceRefresh= */ true);
    const res = await fetch('/livekit-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
      body: JSON.stringify({ roomName, canPublish })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '(unreadable)');
      throw new Error('Token ' + res.status + ': ' + body.slice(0, 300));
    }
    return (await res.json()).token;
  }

  function _livekitRoomName() {
    if (!streamContext || !currentUser) return '';
    return 'rps_' + streamContext.serverId + '_' + streamContext.channelId + '_' + currentUser.uid;
  }

  let _pendingCmd = null;  // holds the start cmd until the user clicks the button
  let _userReady = false;  // true once the user has clicked Share Screen

  function _setStatus(msg) {
    const el = document.getElementById('status');
    if (el) el.textContent = msg;
  }

  function _hideStartUI() {
    const ui = document.getElementById('start-ui');
    if (ui) ui.style.display = 'none';
  }

  // Wire the start button — must happen before auth resolves so the element exists.
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('start-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      _setStatus('Starting screen share...');
      _userReady = true;
      if (_pendingCmd) {
        await _handleCommand(_pendingCmd);
        _pendingCmd = null;
      } else {
        _setStatus('Waiting for stream command...');
      }
    });
  });

  auth.onAuthStateChanged(async user => {
    if (!user) {
      _clearState();
      return;
    }
    currentUser = user;
    _initBridge();
    // Read the pending start payload but don't call getDisplayMedia yet —
    // wait for the user to click the button (guarantees user gesture in Chrome).
    const raw = localStorage.getItem(STREAM_PENDING_START_KEY);
    if (raw) {
      try {
        const cmd = JSON.parse(raw);
        if (cmd && cmd.hostUid === currentUser.uid && cmd.action === 'start'
            && cmd.ts && Date.now() - cmd.ts <= 60000) {
          localStorage.removeItem(STREAM_PENDING_START_KEY);
          if (_userReady) {
            await _handleCommand(cmd);
          } else {
            _pendingCmd = cmd;
            _setStatus('Auth ready. Click "Share Screen & Go Live" to begin.');
          }
          return;
        }
      } catch (_) {}
      localStorage.removeItem(STREAM_PENDING_START_KEY);
    }
    _setStatus('Waiting for stream command...');
  });

  function _initBridge() {
    window.addEventListener('storage', e => {
      if (e.key !== STREAM_CMD_KEY || !e.newValue) return;
      try {
        const cmd = JSON.parse(e.newValue);
        _handleCommand(cmd);
      } catch (_) {}
    });

    try {
      streamControlChannel = new BroadcastChannel('rps-stream-control');
      streamControlChannel.onmessage = evt => {
        if (!evt || !evt.data) return;
        if (evt.data.type === 'stream-cmd' && evt.data.payload) {
          _handleCommand(evt.data.payload);
        }
      };
    } catch (_) {}
  }

  async function _handleCommand(cmd) {
    if (!cmd || !cmd.id) return;
    if (lastCmdId === cmd.id) return;
    lastCmdId = cmd.id;

    if (!currentUser) return;
    if (cmd.hostUid && cmd.hostUid !== currentUser.uid) return;

    if (cmd.action === 'start') {
      // If the user hasn't clicked the button yet, queue the command.
      if (!_userReady) {
        _pendingCmd = cmd;
        _setStatus('Stream command received. Click "Share Screen & Go Live" to begin.');
        return;
      }
      await _startStream(cmd);
      return;
    }
    if (cmd.action === 'stop') {
      await _stopStream(true);
      return;
    }
    if (cmd.action === 'openChat') {
      // Core tab has no chat UI; no-op.
      return;
    }
    if (cmd.action === 'snapshot') {
      _captureSnapshot();
      return;
    }
    if (cmd.action === 'toggleRecord') {
      _toggleRecord();
      return;
    }
  }

  function _consumePendingStart() { /* replaced by button-gated flow */ }

  async function _startStream(cmd) {
    if (isLive || isStarting) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return;
    isStarting = true;

    streamContext = {
      serverId: cmd.serverId,
      channelId: cmd.channelId,
      channelName: cmd.channelName || 'Streaming Channel',
      username: cmd.username || 'Someone',
      controllerUrl: cmd.controllerUrl || 'messenger.html'
    };

    try {
      _setStatus('Requesting screen share...');
      localStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: 'always',
          frameRate: { ideal: 60, max: 60 },
          width: { ideal: 2560, max: 3840 },
          height: { ideal: 1440, max: 2160 },
          displaySurface: 'monitor',
          resizeMode: 'none'
        },
        audio: false
      });
    } catch (_) {
      streamContext = null;
      isStarting = false;
      _setStatus('Screen share cancelled or denied. Close this tab and try again.');
      const btn = document.getElementById('start-btn');
      if (btn) btn.disabled = false;
      return;
    }

    try {
      const vid = document.getElementById('core-video');
      if (vid) vid.srcObject = localStream;

      localStream.getVideoTracks()[0].addEventListener('ended', () => {
        _stopStream(true);
      });

      // Connect to LiveKit and publish the screen capture track.
      _setStatus('Connecting to stream server...');
      const roomName = _livekitRoomName();
      const token = await _getLiveKitToken(roomName, true);
      livekitRoom = new LivekitClient.Room({ adaptiveStream: false, dynacast: false });
      // Force TURN relay so restrictive networks (Chromebook Wi-Fi, corporate firewalls)
      // that block UDP can still connect via TCP/TLS over port 443.
      await Promise.race([
        livekitRoom.connect(LIVEKIT_URL, token, {
          rtcConfig: { iceTransportPolicy: 'relay' }
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('LiveKit connect timed out after 20s')), 20000))
      ]);

      const videoTrack = localStream.getVideoTracks()[0];
      await livekitRoom.localParticipant.publishTrack(videoTrack, {
        source: LivekitClient.Track.Source.ScreenShare,
        videoEncoding: { maxBitrate: 3_000_000, maxFramerate: 30 }
      });

      // Only mark live AFTER we have published successfully.
      isLive = true;
      startedAt = Date.now();
      _publishState();

      // Write the stream doc so viewers know where to connect.
      const streamRef = _streamRef();
      await streamRef.set({
        username: streamContext.username,
        startedAt: firebase.firestore.FieldValue.serverTimestamp(),
        livekitRoom: roomName,
        livekitUrl: LIVEKIT_URL
      });

      _hideStartUI();
      _setStatus('Live! You can minimise this tab.');
    } catch (err) {
      console.error('Stream start failed:', err);
      _setStatus('Failed to start stream: ' + (err && err.message ? err.message : 'unknown error'));
      // Cleanup partial state so user can retry.
      if (livekitRoom) {
        try { await livekitRoom.disconnect(); } catch (_) {}
        livekitRoom = null;
      }
      if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
      }
      streamContext = null;
      isLive = false;
      _clearState();
      const btn = document.getElementById('start-btn');
      if (btn) btn.disabled = false;
    } finally {
      isStarting = false;
    }
  }

  function _streamRef() {
    return db.collection('servers').doc(streamContext.serverId)
      .collection('channels').doc(streamContext.channelId)
      .collection('streams').doc(currentUser.uid);
  }

  async function _stopStream(shouldCloseWindow) {
    if (!isLive && !streamContext) {
      _clearState();
      if (shouldCloseWindow) _tryClose();
      return;
    }

    isLive = false;

    if (recorder && recorder.state !== 'inactive') recorder.stop();
    recorder = null;
    recordChunks = [];

    if (livekitRoom) {
      try { await livekitRoom.disconnect(); } catch (_) {}
      livekitRoom = null;
    }

    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }

    while (streamUnsubs.length) {
      const fn = streamUnsubs.pop();
      try { fn(); } catch (_) {}
    }

    try {
      if (streamContext) await _streamRef().delete();
    } catch (_) {}

    _clearState();
    if (shouldCloseWindow) _tryClose();
  }

  function _publishState() {
    if (!isLive || !streamContext || !currentUser) return;
    const payload = {
      live: true,
      serverId: streamContext.serverId,
      channelId: streamContext.channelId,
      channelName: streamContext.channelName,
      startedAt,
      hostUrl: window.location.href,
      controllerUrl: streamContext.controllerUrl || 'messenger.html',
      hostUid: currentUser.uid
    };
    localStorage.setItem(STREAM_STATE_KEY, JSON.stringify(payload));
    try {
      if (streamControlChannel) streamControlChannel.postMessage({ type: 'stream-state', payload });
    } catch (_) {}
  }

  function _clearState() {
    streamContext = null;
    startedAt = 0;
    isLive = false;
    localStorage.removeItem(STREAM_STATE_KEY);
    try {
      if (streamControlChannel) streamControlChannel.postMessage({ type: 'stream-state', payload: { live: false } });
    } catch (_) {}
  }

  function _captureSnapshot() {
    if (!localStream) return;
    const vid = document.getElementById('core-video');
    if (!vid || !vid.videoWidth || !vid.videoHeight) return;

    const canvas = document.createElement('canvas');
    canvas.width = vid.videoWidth;
    canvas.height = vid.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);

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
    }, 'image/png');
  }

  function _toggleRecord() {
    if (!localStream) return;
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
      return;
    }
    try {
      recordChunks = [];
      recorder = new MediaRecorder(localStream, { mimeType: 'video/webm;codecs=vp8' });
      recorder.ondataavailable = e => {
        if (e.data && e.data.size > 0) recordChunks.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(recordChunks, { type: 'video/webm' });
        recordChunks = [];
        if (!blob.size) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'stream-recording-' + Date.now() + '.webm';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      };
      recorder.start(1000);
    } catch (_) {}
  }

  function _tryClose() {
    setTimeout(() => {
      try { window.close(); } catch (_) {}
    }, 150);
  }

  window.addEventListener('beforeunload', () => {
    if (isLive) {
      _stopStream(false);
    } else {
      _clearState();
    }
  });
})();
