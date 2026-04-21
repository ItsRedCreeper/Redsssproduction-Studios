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
  const streamUnsubs = [];
  let streamControlChannel = null;

  let recorder = null;
  let recordChunks = [];

  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

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

          if (change.type === 'added') {
            _createStreamerPC(viewerUid);
          } else if (change.type === 'removed') {
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

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await viewerDocRef.update({ offer: { type: offer.type, sdp: offer.sdp } }).catch(() => {});

    const answerUnsub = viewerDocRef.onSnapshot(snap => {
      const data = snap.data();
      if (data && data.answer && !pc.currentRemoteDescription) {
        pc.setRemoteDescription(new RTCSessionDescription(data.answer)).catch(() => {});
      }
    });
    streamUnsubs.push(answerUnsub);

    const candidateUnsub = viewerDocRef.collection('viewerCandidates').onSnapshot(snap => {
      snap.docChanges().forEach(change => {
        if (change.type === 'added') {
          pc.addIceCandidate(new RTCIceCandidate(change.doc.data())).catch(() => {});
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
