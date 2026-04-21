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

  const streamerPCs = new Map(); // viewerUid -> RTCPeerConnection
  const _viewerSessions = new Map(); // viewerUid -> sessionId (tracks reconnects)
  const streamUnsubs = [];
  let streamControlChannel = null;

  let recorder = null;
  let recordChunks = [];

  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      // UDP relay (works on most home networks)
      { urls: 'turn:openrelay.metered.ca:80',  username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      // TCP relay (bypasses firewalls that block UDP)
      { urls: 'turn:openrelay.metered.ca:80?transport=tcp',  username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turns:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }
    ],
    iceCandidatePoolSize: 10,
    bundlePolicy: 'max-bundle'
  };

  // Detect relay vs direct connection and cap bitrate so we don't flood a
  // low-bandwidth TURN relay with an 8 Mbps stream.
  async function _adaptBitrateToConnection(pc) {
    try {
      const stats = await pc.getStats();
      const candidates = new Map();
      let activePairLocalId = null;
      stats.forEach(r => {
        if (r.type === 'local-candidate') candidates.set(r.id, r);
        if (r.type === 'candidate-pair' && r.nominated) activePairLocalId = r.localCandidateId;
      });
      const localCand = activePairLocalId ? candidates.get(activePairLocalId) : null;
      const isRelay = localCand && localCand.candidateType === 'relay';
      // Direct path: 8 Mbps. Relay path: 1.5 Mbps (safe ceiling for free TURN).
      const targetBitrate = isRelay ? 1500000 : 8000000;
      pc.getSenders().forEach(sender => {
        if (!sender.track || sender.track.kind !== 'video') return;
        const p = sender.getParameters();
        if (!p || !p.encodings || !p.encodings.length) return;
        if (p.encodings[0].maxBitrate === targetBitrate) return;
        p.encodings[0].maxBitrate = targetBitrate;
        sender.setParameters(p).catch(() => {});
      });
    } catch (_) {}
  }

  auth.onAuthStateChanged(async user => {
    if (!user) {
      _clearState();
      return;
    }
    currentUser = user;
    _initBridge();
    _consumePendingStart();
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

  function _consumePendingStart() {
    let cmd = null;
    try {
      const raw = localStorage.getItem(STREAM_PENDING_START_KEY);
      cmd = raw ? JSON.parse(raw) : null;
    } catch (_) {
      cmd = null;
    }
    if (!cmd) return;
    if (!currentUser || cmd.hostUid !== currentUser.uid) return;
    if (cmd.action !== 'start') return;
    if (!cmd.ts || Date.now() - cmd.ts > 20000) {
      localStorage.removeItem(STREAM_PENDING_START_KEY);
      return;
    }
    localStorage.removeItem(STREAM_PENDING_START_KEY);
    _handleCommand(cmd);
  }

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
      return;
    }

    try {
      const vid = document.getElementById('core-video');
      if (vid) vid.srcObject = localStream;

      localStream.getVideoTracks()[0].addEventListener('ended', () => {
        _stopStream(true);
      });

      isLive = true;
      startedAt = Date.now();
      _publishState();

      const streamRef = _streamRef();
      await streamRef.set({
        username: streamContext.username,
        startedAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      const viewersRef = streamRef.collection('viewers');
      const unsub = viewersRef.onSnapshot(snap => {
        snap.docChanges().forEach(change => {
          const viewerUid = change.doc.id;
          if (viewerUid === currentUser.uid) return;

          if (change.type === 'added' || change.type === 'modified') {
            const data = change.doc.data() || {};
            // Only create a new PC on a fresh join (new sessionId).
            // 'modified' also fires when the viewer writes their answer — ignore those.
            const sessionId = data.sessionId || 'default';
            if (_viewerSessions.get(viewerUid) === sessionId) return;
            _viewerSessions.set(viewerUid, sessionId);
            // Close any stale PC for this viewer before creating a fresh one.
            const old = streamerPCs.get(viewerUid);
            if (old) { old.close(); streamerPCs.delete(viewerUid); }
            _createStreamerPC(viewerUid);
          } else if (change.type === 'removed') {
            _viewerSessions.delete(viewerUid);
            const pc = streamerPCs.get(viewerUid);
            if (pc) {
              pc.close();
              streamerPCs.delete(viewerUid);
            }
          }
        });
      });
      streamUnsubs.push(unsub);
    } finally {
      isStarting = false;
    }
  }

  async function _createStreamerPC(viewerUid) {
    if (!localStream || !streamContext) return;

    const pc = new RTCPeerConnection(rtcConfig);
    streamerPCs.set(viewerUid, pc);

    localStream.getTracks().forEach(track => {
      const sender = pc.addTrack(track, localStream);
      if (track.kind === 'video' && sender && sender.getParameters) {
        const p = sender.getParameters() || {};
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = 8000000;
        p.encodings[0].maxFramerate = 60;
        sender.setParameters(p).catch(() => {});
      }
      if (track.kind === 'video') {
        try { track.contentHint = 'detail'; } catch (_) {}
      }
    });

    const viewerDocRef = _streamRef().collection('viewers').doc(viewerUid);

    pc.onicecandidate = e => {
      if (e.candidate) {
        viewerDocRef.collection('streamerCandidates').add(e.candidate.toJSON()).catch(() => {});
      }
    };

    let _bitrateTimer = null;
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        _adaptBitrateToConnection(pc);
        _bitrateTimer = setInterval(() => _adaptBitrateToConnection(pc), 8000);
      } else if (pc.connectionState === 'failed') {
        if (_bitrateTimer) { clearInterval(_bitrateTimer); _bitrateTimer = null; }
        pc.restartIce();
      } else if (pc.connectionState === 'closed') {
        if (_bitrateTimer) { clearInterval(_bitrateTimer); _bitrateTimer = null; }
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await viewerDocRef.update({ offer: { type: offer.type, sdp: offer.sdp } }).catch(() => {});

    let answerSet = false;
    const pendingViewerCandidates = [];

    const answerUnsub = viewerDocRef.onSnapshot(snap => {
      const data = snap.data();
      if (data && data.answer && !pc.currentRemoteDescription) {
        pc.setRemoteDescription(new RTCSessionDescription(data.answer))
          .then(() => {
            answerSet = true;
            for (const c of pendingViewerCandidates) { pc.addIceCandidate(c).catch(() => {}); }
            pendingViewerCandidates.length = 0;
          })
          .catch(() => {});
      }
    });
    streamUnsubs.push(answerUnsub);

    const candidateUnsub = viewerDocRef.collection('viewerCandidates').onSnapshot(snap => {
      snap.docChanges().forEach(change => {
        if (change.type === 'added') {
          const c = new RTCIceCandidate(change.doc.data());
          if (answerSet) { pc.addIceCandidate(c).catch(() => {}); }
          else { pendingViewerCandidates.push(c); }
        }
      });
    });
    streamUnsubs.push(candidateUnsub);
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

    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }

    streamerPCs.forEach(pc => pc.close());
    streamerPCs.clear();

    while (streamUnsubs.length) {
      const fn = streamUnsubs.pop();
      try { fn(); } catch (_) {}
    }

    try {
      if (streamContext) {
        const streamRef = _streamRef();
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
      }
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
    _viewerSessions.clear();
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
