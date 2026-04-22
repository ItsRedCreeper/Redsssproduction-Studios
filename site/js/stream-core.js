/* Stream Core host tab: runs streamer capture + WebRTC signaling in a background tab. */

(() => {
  const STREAM_STATE_KEY = 'rps_stream_state_v1';
  const STREAM_CMD_KEY = 'rps_stream_cmd_v1';
  const STREAM_PENDING_START_KEY = 'rps_stream_pending_start_v1';
  const MAIN_HEARTBEAT_KEY = 'rps_main_heartbeat_v1';
  const MAIN_HEARTBEAT_STALE_MS = 5000;    // main site considered gone after 5s of silence
  const MAIN_HEARTBEAT_IDLE_CLOSE_MS = 8000; // close idle core tab after 8s without main

  let currentUser = null;
  let localStream = null;
  let streamContext = null; // { serverId, channelId, channelName, username, controllerUrl, quality }
  let startedAt = 0;
  let isLive = false;
  let isStarting = false;
  let lastCmdId = null;

  // Cached ID token — kept fresh so the beforeunload keepalive fetch can
  // delete the firestore stream doc even when async SDK calls won't complete.
  const FIRESTORE_PROJECT = 'redsssproduction-studios-86bec';
  let _cachedIdToken = null;

  let livekitRoom = null;
  const streamUnsubs = [];
  let streamControlChannel = null;

  let recorder = null;
  let recordChunks = [];
  let recordStartedAt = 0;
  let recordPausedAccumulatedMs = 0;
  let recordPausedAt = 0;
  let streamPaused = false;
  // Reference to the publisher's LiveKit track publication — needed so we can
  // swap in a frozen-frame track when pausing the stream.
  let publishedVideoTrack = null;     // LocalVideoTrack currently being published
  let originalScreenTrack = null;     // MediaStreamTrack from getDisplayMedia
  let frozenFrameStream = null;       // MediaStream from canvas.captureStream

  const LIVEKIT_URL = 'wss://redsssproduction-studios-aiosfout.livekit.cloud';

  async function _getLiveKitToken(roomName, canPublish) {
    if (!roomName) throw new Error('Room name is empty — stream context not ready');
    const idToken = await auth.currentUser.getIdToken(/* forceRefresh= */ true);
    const params = new URLSearchParams({ roomName, canPublish: canPublish ? '1' : '0' });
    const res = await fetch('/livekit-token?' + params.toString(), {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + idToken }
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

  // Map a quality preset to getDisplayMedia constraints.
  function _qualityToConstraints(q) {
    const fps = (q && (q.fps === 60 || q.fps === '60')) ? 60 : 30;
    let w = 1920, h = 1080;
    switch (q && q.resolution) {
      case '720p':  w = 1280; h = 720;  break;
      case '1080p': w = 1920; h = 1080; break;
      case '1440p': w = 2560; h = 1440; break;
      case '4k':    w = 3840; h = 2160; break;
      default:      w = 1920; h = 1080;
    }
    return {
      video: {
        cursor: 'always',
        frameRate: { ideal: fps, max: fps },
        width:  { ideal: w, max: w },
        height: { ideal: h, max: h },
        displaySurface: 'monitor',
        resizeMode: 'none'
      },
      audio: false
    };
  }

  // Map quality preset to a LiveKit bitrate budget.
  function _qualityToBitrate(q) {
    const fps = (q && (q.fps === 60 || q.fps === '60')) ? 60 : 30;
    switch (q && q.resolution) {
      case '720p':  return fps === 60 ? 3_000_000 : 2_000_000;
      case '1080p': return fps === 60 ? 5_000_000 : 3_500_000;
      case '1440p': return fps === 60 ? 8_000_000 : 5_500_000;
      case '4k':    return fps === 60 ? 14_000_000 : 9_000_000;
      default:      return 3_500_000;
    }
  }

  function _setStatus(msg) {
    const el = document.getElementById('status');
    if (el) el.textContent = msg;
  }

  function _showFallbackButton(msg) {
    const startUi = document.getElementById('start-ui');
    const idleUi = document.getElementById('idle-ui');
    if (idleUi) idleUi.style.display = 'none';
    if (startUi) startUi.style.display = 'flex';
    if (msg) _setStatus(msg);
    const btn = document.getElementById('start-btn');
    if (btn) btn.disabled = false;
  }

  function _hideStartUI() {
    const startUi = document.getElementById('start-ui');
    const idleUi = document.getElementById('idle-ui');
    if (startUi) startUi.style.display = 'none';
    if (idleUi) idleUi.style.display = 'none';
  }

  // Wire the fallback button for browsers that reject programmatic getDisplayMedia.
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('start-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      _setStatus('Starting screen share...');
      if (_pendingCmd) {
        const cmd = _pendingCmd;
        _pendingCmd = null;
        await _startStream(cmd);
      }
    });
  });

  let _pendingCmd = null;  // the most recent start cmd, ready to run

  auth.onAuthStateChanged(async user => {
    if (!user) {
      _clearState();
      return;
    }
    currentUser = user;
    _initBridge();
    _startHeartbeatWatch();

    // Keep an in-memory copy of the ID token so the beforeunload handler can
    // synchronously fire a keepalive DELETE to the Firestore REST API if the
    // async SDK calls don't get a chance to finish.
    async function _refreshToken() {
      try { _cachedIdToken = await currentUser.getIdToken(false); } catch (_) {}
    }
    _refreshToken();
    setInterval(_refreshToken, 30 * 60 * 1000); // refresh every 30 min

    // Check for a pending start payload written by messenger.js
    const raw = localStorage.getItem(STREAM_PENDING_START_KEY);
    if (raw) {
      try {
        const cmd = JSON.parse(raw);
        if (cmd && cmd.hostUid === currentUser.uid && cmd.action === 'start'
            && cmd.ts && Date.now() - cmd.ts <= 60000) {
          localStorage.removeItem(STREAM_PENDING_START_KEY);
          await _startStream(cmd);
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

  // Watch the main site's heartbeat — if it stops, tear down the stream and close.
  let _heartbeatWatchTimer = null;
  let _noHeartbeatSince = 0;
  function _startHeartbeatWatch() {
    if (_heartbeatWatchTimer) clearInterval(_heartbeatWatchTimer);
    _heartbeatWatchTimer = setInterval(() => {
      // Fast-path: if the main site set an explicit force-stop flag, honour it.
      try {
        if (localStorage.getItem('rps_force_stop_v1') === '1') {
          localStorage.removeItem('rps_force_stop_v1');
          if (isLive) _stopStream(true);
          else _tryClose();
          return;
        }
      } catch (_) {}

      const raw = localStorage.getItem(MAIN_HEARTBEAT_KEY);
      const ts = raw ? parseInt(raw, 10) : 0;
      const now = Date.now();
      const alive = ts && (now - ts) < MAIN_HEARTBEAT_STALE_MS;
      if (alive) {
        _noHeartbeatSince = 0;
        return;
      }
      // Don't accumulate the stale timer while we're starting up (screen
      // picker is open, LiveKit is connecting, etc.).  If we did, a fast
      // user who picks a screen in <5 s would see the tab close immediately
      // after going live because goneFor was already >= STALE_MS.
      if (!_noHeartbeatSince && !isStarting) _noHeartbeatSince = now;
      // Also reset the counter the instant we go live so the main site gets
      // a fresh window to prove it's still open.
      if (isLive && _noHeartbeatSince && _noHeartbeatSince < startedAt) _noHeartbeatSince = startedAt;
      const goneFor = _noHeartbeatSince ? now - _noHeartbeatSince : 0;
      if (isLive && goneFor > MAIN_HEARTBEAT_STALE_MS) {
        _setStatus('Main site closed — stopping stream.');
        _stopStream(true);
      } else if (!isLive && !isStarting && goneFor > MAIN_HEARTBEAT_IDLE_CLOSE_MS) {
        _tryClose();
      }
    }, 1000);
  }

  async function _handleCommand(cmd) {
    if (!cmd || !cmd.id) return;
    if (lastCmdId === cmd.id) return;
    lastCmdId = cmd.id;

    if (!currentUser) return;
    if (cmd.hostUid && cmd.hostUid !== currentUser.uid) return;

    if (cmd.action === 'start') {
      await _startStream(cmd);
      return;
    }
    if (cmd.action === 'stop') {
      await _stopStream(true);
      return;
    }
    if (cmd.action === 'openChat') {
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
    if (cmd.action === 'pauseRecord') {
      _pauseRecord();
      return;
    }
    if (cmd.action === 'resumeRecord') {
      _resumeRecord();
      return;
    }
    if (cmd.action === 'pauseStream') {
      await _pauseStream();
      return;
    }
    if (cmd.action === 'resumeStream') {
      await _resumeStream();
      return;
    }
  }

  async function _startStream(cmd) {
    if (isLive || isStarting) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      _setStatus('This browser does not support screen sharing.');
      return;
    }
    isStarting = true;

    streamContext = {
      serverId: cmd.serverId,
      channelId: cmd.channelId,
      channelName: cmd.channelName || 'Streaming Channel',
      username: cmd.username || 'Someone',
      controllerUrl: cmd.controllerUrl || 'messenger.html',
      quality: cmd.quality || { resolution: '1080p', fps: 30 }
    };

    try {
      _setStatus('Requesting screen share...');
      const constraints = _qualityToConstraints(streamContext.quality);
      try {
        localStream = await navigator.mediaDevices.getDisplayMedia(constraints);
      } catch (gdmErr) {
        // Browser rejected — most likely missing user gesture. Show the fallback button.
        streamContext = null;
        isStarting = false;
        _pendingCmd = cmd;
        const name = gdmErr && gdmErr.name ? gdmErr.name : '';
        if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'InvalidStateError') {
          _showFallbackButton('Your browser needs a click to allow screen share.');
        } else {
          _showFallbackButton('Screen share cancelled. Click below to try again.');
        }
        return;
      }

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
      await Promise.race([
        livekitRoom.connect(LIVEKIT_URL, token, {
          rtcConfig: { iceTransportPolicy: 'relay' }
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('LiveKit connect timed out after 20s')), 20000))
      ]);

      const videoTrack = localStream.getVideoTracks()[0];
      originalScreenTrack = videoTrack;
      const bitrate = _qualityToBitrate(streamContext.quality);
      const fps = (streamContext.quality && (streamContext.quality.fps === 60 || streamContext.quality.fps === '60')) ? 60 : 30;
      const publication = await livekitRoom.localParticipant.publishTrack(videoTrack, {
        source: LivekitClient.Track.Source.ScreenShare,
        videoEncoding: { maxBitrate: bitrate, maxFramerate: fps }
      });
      publishedVideoTrack = publication && publication.track ? publication.track : null;

      isLive = true;
      startedAt = Date.now();
      _publishState();

      const streamRef = _streamRef();
      await streamRef.set({
        username: streamContext.username,
        startedAt: firebase.firestore.FieldValue.serverTimestamp(),
        lastHeartbeat: firebase.firestore.FieldValue.serverTimestamp(),
        livekitRoom: roomName,
        livekitUrl: LIVEKIT_URL
      });

      // Watch our own user doc so we can push username renames onto the stream
      // card in real time. Clean up on stop.
      const userUnsub = db.collection('users').doc(currentUser.uid)
        .onSnapshot(doc => {
          if (!isLive || !streamContext) return;
          const data = doc.data() || {};
          const newName = data.username || streamContext.username;
          if (newName && newName !== streamContext.username) {
            streamContext.username = newName;
            streamRef.update({ username: newName }).catch(() => {});
          }
        });
      streamUnsubs.push(userUnsub);

      // Refresh the lastHeartbeat field every 5s so that if this tab dies
      // without a clean shutdown, the main site can detect stale docs and
      // clean them up.
      const hbTimer = setInterval(() => {
        if (!isLive || !streamContext) return;
        streamRef.update({ lastHeartbeat: firebase.firestore.FieldValue.serverTimestamp() }).catch(() => {});
        // Also refresh the shared localStorage state so site tabs can detect
        // that the core tab is still alive via the state.ts field.
        _publishState();
      }, 3000);
      streamUnsubs.push(() => clearInterval(hbTimer));

      _hideStartUI();
      _setStatus('Live! You can minimise this tab.');
    } catch (err) {
      console.error('Stream start failed:', err);
      _setStatus('Failed to start stream: ' + (err && err.message ? err.message : 'unknown error'));
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
      _showFallbackButton();
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
    recordStartedAt = 0;
    recordPausedAccumulatedMs = 0;
    recordPausedAt = 0;
    streamPaused = false;
    if (frozenFrameStream) {
      frozenFrameStream.getTracks().forEach(t => {
        if (t._freezeTicker) { clearInterval(t._freezeTicker); t._freezeTicker = null; }
        t.stop();
      });
      frozenFrameStream = null;
    }
    originalScreenTrack = null;
    publishedVideoTrack = null;

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
    let recordStatus = 'idle';
    if (recorder) {
      if (recorder.state === 'recording') recordStatus = 'recording';
      else if (recorder.state === 'paused') recordStatus = 'paused';
    }
    const payload = {
      live: true,
      ts: Date.now(),
      serverId: streamContext.serverId,
      channelId: streamContext.channelId,
      channelName: streamContext.channelName,
      startedAt,
      hostUrl: window.location.href,
      controllerUrl: streamContext.controllerUrl || 'messenger.html',
      hostUid: currentUser.uid,
      streamPaused: !!streamPaused,
      recordStatus,
      recordStartedAt,
      recordPausedAccumulatedMs,
      recordPausedAt
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
    if (recorder && recorder.state !== 'inactive') {
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
        recordStartedAt = 0;
        recordPausedAccumulatedMs = 0;
        recordPausedAt = 0;
        recorder = null;
        _publishState();
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
      recordStartedAt = Date.now();
      recordPausedAccumulatedMs = 0;
      recordPausedAt = 0;
      _publishState();
    } catch (_) {}
  }

  function _pauseRecord() {
    if (!recorder || recorder.state !== 'recording') return;
    try {
      recorder.pause();
      recordPausedAt = Date.now();
      _publishState();
    } catch (_) {}
  }

  function _resumeRecord() {
    if (!recorder || recorder.state !== 'paused') return;
    try {
      if (recordPausedAt) {
        recordPausedAccumulatedMs += (Date.now() - recordPausedAt);
        recordPausedAt = 0;
      }
      recorder.resume();
      _publishState();
    } catch (_) {}
  }

  async function _pauseStream() {
    if (!isLive || streamPaused || !livekitRoom || !originalScreenTrack) return;
    try {
      // Capture the current frame onto a canvas and publish that canvas's
      // captureStream(0) track in place of the live screen track. captureStream(0)
      // means "emit a new frame only when requestFrame() is called", which gives
      // us a static image — i.e. a freeze-frame.
      const vid = document.getElementById('core-video');
      if (!vid || !vid.videoWidth || !vid.videoHeight) return;
      const canvas = document.createElement('canvas');
      canvas.width = vid.videoWidth;
      canvas.height = vid.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);

      frozenFrameStream = canvas.captureStream(0);
      const frozenTrack = frozenFrameStream.getVideoTracks()[0];
      // Keep sending the same frame regularly so viewers don't see a stall.
      frozenTrack._freezeTicker = setInterval(() => {
        try { if (frozenTrack.requestFrame) frozenTrack.requestFrame(); } catch (_) {}
      }, 500);

      if (publishedVideoTrack && publishedVideoTrack.replaceTrack) {
        await publishedVideoTrack.replaceTrack(frozenTrack);
      } else if (publishedVideoTrack && publishedVideoTrack.mediaStreamTrack) {
        // Fallback — unpublish and republish (slower).
        await livekitRoom.localParticipant.unpublishTrack(publishedVideoTrack);
        const pub = await livekitRoom.localParticipant.publishTrack(frozenTrack, {
          source: LivekitClient.Track.Source.ScreenShare
        });
        publishedVideoTrack = pub && pub.track ? pub.track : publishedVideoTrack;
      }
      streamPaused = true;
      _setStatus('Stream paused (frozen frame).');
      _publishState();
    } catch (err) {
      console.error('Pause stream failed:', err);
    }
  }

  async function _resumeStream() {
    if (!isLive || !streamPaused || !livekitRoom || !originalScreenTrack) return;
    try {
      if (publishedVideoTrack && publishedVideoTrack.replaceTrack) {
        await publishedVideoTrack.replaceTrack(originalScreenTrack);
      } else if (publishedVideoTrack) {
        await livekitRoom.localParticipant.unpublishTrack(publishedVideoTrack);
        const pub = await livekitRoom.localParticipant.publishTrack(originalScreenTrack, {
          source: LivekitClient.Track.Source.ScreenShare
        });
        publishedVideoTrack = pub && pub.track ? pub.track : publishedVideoTrack;
      }
      if (frozenFrameStream) {
        frozenFrameStream.getTracks().forEach(t => {
          if (t._freezeTicker) { clearInterval(t._freezeTicker); t._freezeTicker = null; }
          t.stop();
        });
        frozenFrameStream = null;
      }
      streamPaused = false;
      _setStatus('Live!');
      _publishState();
    } catch (err) {
      console.error('Resume stream failed:', err);
    }
  }

  function _tryClose() {
    setTimeout(() => {
      try { window.close(); } catch (_) {}
    }, 150);
  }

  window.addEventListener('beforeunload', () => {
    // Best-effort synchronous keepalive DELETE to the Firestore REST API so
    // the stream card disappears for viewers even when async SDK calls can't
    // complete in time (which is always the case in beforeunload).
    if (isLive && streamContext && currentUser && _cachedIdToken) {
      try {
        const { serverId, channelId } = streamContext;
        const docPath = `servers/${serverId}/channels/${channelId}/streams/${currentUser.uid}`;
        const url = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}/databases/(default)/documents/${docPath}`;
        fetch(url, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${_cachedIdToken}` },
          keepalive: true
        });
      } catch (_) {}
    }
    if (isLive) {
      _stopStream(false);
    } else {
      _clearState();
    }
  });
})();
