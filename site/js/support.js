/* ───────────────────────────────────────────────
   support.js — Support page
   ─────────────────────────────────────────────── */

const Support = (() => {
  let _user = null;
  let _profile = null;

  let _bugArea = null;
  let _bugImages = [];
  let _targetUser = null;
  let _userImages = [];
  let _allUsers = [];
  let _bugAreas = [
    { id: 'main_site', label: 'Main Site' },
    { id: 'messenger', label: 'RedsssMessenger' }
  ];

  function init(user, profile) {
    _user = user;
    _profile = profile;

    _loadUsers();
    _loadGames();

    document.getElementById('btn-bug-report').addEventListener('click', () => _showForm('bug'));
    document.getElementById('btn-user-support').addEventListener('click', () => _showForm('user'));
    document.getElementById('back-from-bug').addEventListener('click', _showTypeSelect);
    document.getElementById('back-from-user').addEventListener('click', _showTypeSelect);

    const bugSearch = document.getElementById('bug-area-search');
    bugSearch.addEventListener('input', () => _filterBugAreas(bugSearch.value));
    bugSearch.addEventListener('focus', () => _filterBugAreas(bugSearch.value));

    const userSearch = document.getElementById('user-search');
    userSearch.addEventListener('input', () => _filterUsers(userSearch.value));
    userSearch.addEventListener('focus', () => _filterUsers(userSearch.value));

    document.addEventListener('click', e => {
      if (!bugSearch.contains(e.target) && !document.getElementById('bug-area-dropdown').contains(e.target))
        document.getElementById('bug-area-dropdown').classList.remove('open');
      if (!userSearch.contains(e.target) && !document.getElementById('user-dropdown').contains(e.target))
        document.getElementById('user-dropdown').classList.remove('open');
    });

    document.getElementById('bug-img-input').addEventListener('change', e => _addImages(e, 'bug'));
    document.getElementById('user-img-input').addEventListener('change', e => _addImages(e, 'user'));

    document.getElementById('submit-bug').addEventListener('click', _submitBug);
    document.getElementById('submit-user').addEventListener('click', _submitUser);
  }

  async function _loadUsers() {
    try {
      const snap = await db.collection('users').get();
      _allUsers = [];
      snap.forEach(d => {
        const data = d.data();
        if (d.id !== _user.uid)
          _allUsers.push({ uid: d.id, username: data.username || '', avatar: data.avatar || '' });
      });
      _allUsers.sort((a, b) => a.username.localeCompare(b.username));
    } catch { /* ignore */ }
  }

  async function _loadGames() {
    try {
      const snap = await db.collection('games').orderBy('title').get();
      snap.forEach(d => _bugAreas.push({ id: 'game_' + d.id, label: d.data().title }));
    } catch { /* ignore */ }
  }

  function _showForm(type) {
    document.getElementById('support-type-row').style.display = 'none';
    document.getElementById('form-bug-report').style.display = type === 'bug' ? 'flex' : 'none';
    document.getElementById('form-user-support').style.display = type === 'user' ? 'flex' : 'none';
  }

  function _showTypeSelect() {
    document.getElementById('support-type-row').style.display = 'grid';
    document.getElementById('form-bug-report').style.display = 'none';
    document.getElementById('form-user-support').style.display = 'none';
    _bugArea = null; _bugImages = [];
    _targetUser = null; _userImages = [];
    document.getElementById('bug-area-search').value = '';
    document.getElementById('bug-area-tag').style.display = 'none';
    document.getElementById('user-search').value = '';
    document.getElementById('user-tag').style.display = 'none';
    document.getElementById('bug-description').value = '';
    document.getElementById('user-description').value = '';
    _renderImages('bug');
    _renderImages('user');
  }

  /* ── Bug area search ── */
  function _filterBugAreas(q) {
    const dd = document.getElementById('bug-area-dropdown');
    const filtered = q.trim()
      ? _bugAreas.filter(a => a.label.toLowerCase().includes(q.toLowerCase()))
      : _bugAreas;
    if (!filtered.length) {
      dd.innerHTML = '<div class="support-dd-empty">No results</div>';
    } else {
      dd.innerHTML = filtered.map(a =>
        `<div class="support-dd-item" data-id="${_esc(a.id)}" data-label="${_esc(a.label)}">
          <div class="dd-avatar">📍</div>${_esc(a.label)}</div>`
      ).join('');
      dd.querySelectorAll('.support-dd-item').forEach(el => {
        el.addEventListener('click', () => {
          _bugArea = { id: el.dataset.id, label: el.dataset.label };
          document.getElementById('bug-area-search').value = '';
          dd.classList.remove('open');
          _renderBugTag();
        });
      });
    }
    dd.classList.add('open');
  }

  function _renderBugTag() {
    const tag = document.getElementById('bug-area-tag');
    if (!_bugArea) { tag.style.display = 'none'; return; }
    tag.style.display = 'inline-flex';
    tag.innerHTML = `<span>${_esc(_bugArea.label)}</span><button>&#x2715;</button>`;
    tag.querySelector('button').addEventListener('click', () => { _bugArea = null; tag.style.display = 'none'; });
  }

  /* ── User search ── */
  function _filterUsers(q) {
    const dd = document.getElementById('user-dropdown');
    const filtered = q.trim()
      ? _allUsers.filter(u => u.username.toLowerCase().includes(q.toLowerCase()))
      : _allUsers.slice(0, 20);
    if (!filtered.length) {
      dd.innerHTML = '<div class="support-dd-empty">No users found</div>';
    } else {
      dd.innerHTML = filtered.map(u => {
        const initial = (u.username || 'U').charAt(0).toUpperCase();
        const avatarHtml = u.avatar ? `<img src="${_esc(u.avatar)}" alt="">` : initial;
        return `<div class="support-dd-item" data-uid="${_esc(u.uid)}">
          <div class="dd-avatar">${avatarHtml}</div>${_esc(u.username)}</div>`;
      }).join('');
      dd.querySelectorAll('.support-dd-item').forEach(el => {
        el.addEventListener('click', () => {
          const u = _allUsers.find(x => x.uid === el.dataset.uid);
          if (!u) return;
          _targetUser = u;
          document.getElementById('user-search').value = '';
          dd.classList.remove('open');
          _renderUserTag();
        });
      });
    }
    dd.classList.add('open');
  }

  function _renderUserTag() {
    const tag = document.getElementById('user-tag');
    if (!_targetUser) { tag.style.display = 'none'; return; }
    const avatarHtml = _targetUser.avatar
      ? `<img src="${_esc(_targetUser.avatar)}" alt="" style="width:20px;height:20px;border-radius:50%;object-fit:cover;">`
      : '';
    tag.style.display = 'inline-flex';
    tag.innerHTML = `${avatarHtml}<span>${_esc(_targetUser.username)}</span><button>&#x2715;</button>`;
    tag.querySelector('button').addEventListener('click', () => { _targetUser = null; tag.style.display = 'none'; });
  }

  /* ── Image handling ── */
  async function _addImages(e, type) {
    const arr = type === 'bug' ? _bugImages : _userImages;
    for (const f of Array.from(e.target.files)) {
      if (arr.length >= 3) break;
      if (!f.type.startsWith('image/')) continue;
      let blob;
      try { blob = await CropperUtil.open(f, { aspectRatio: NaN }); }
      catch { continue; } // user cancelled this crop
      arr.push(blob);
    }
    e.target.value = '';
    _renderImages(type);
  }

  function _renderImages(type) {
    const arr = type === 'bug' ? _bugImages : _userImages;
    const row = document.getElementById(type + '-img-row');
    const addBtn = document.getElementById(type + '-img-add');
    row.querySelectorAll('.support-img-wrap').forEach(el => el.remove());
    arr.forEach((f, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'support-img-wrap';
      const img = document.createElement('img');
      img.src = URL.createObjectURL(f);
      const del = document.createElement('button');
      del.className = 'support-img-remove';
      del.textContent = '✕';
      del.addEventListener('click', () => { arr.splice(i, 1); _renderImages(type); });
      wrap.appendChild(img);
      wrap.appendChild(del);
      row.insertBefore(wrap, addBtn);
    });
    addBtn.style.display = arr.length >= 3 ? 'none' : 'flex';
  }

  async function _uploadImages(files) {
    const urls = [];
    for (const f of files) {
      const fd = new FormData();
      fd.append('file', f);
      fd.append('upload_preset', CLOUDINARY_PRESET);
      const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/image/upload`, { method: 'POST', body: fd });
      const data = await res.json();
      if (data.secure_url) urls.push(data.secure_url);
    }
    return urls;
  }

  /* ── Submit ── */
  async function _submitBug() {
    const desc = document.getElementById('bug-description').value.trim();
    if (!_bugArea) { showToast('Please select where the bug is.', 'error'); return; }
    if (desc.length < 10) { showToast('Please describe the bug (min 10 characters).', 'error'); return; }
    const btn = document.getElementById('submit-bug');
    btn.disabled = true; btn.textContent = 'Submitting…';
    try {
      const images = _bugImages.length ? await _uploadImages(_bugImages) : [];
      await db.collection('support_tickets').add({
        type: 'bug',
        uid: _user.uid,
        username: _profile.username || '',
        area: _bugArea,
        description: desc,
        images,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        status: 'open'
      });
      showToast('Bug report submitted! Thank you.', 'success');
      _showTypeSelect();
    } catch { showToast('Failed to submit. Try again.', 'error'); }
    btn.disabled = false; btn.textContent = 'Submit Bug Report';
  }

  async function _submitUser() {
    const desc = document.getElementById('user-description').value.trim();
    if (!_targetUser) { showToast('Please select a user.', 'error'); return; }
    if (desc.length < 10) { showToast('Please describe the issue (min 10 characters).', 'error'); return; }
    const btn = document.getElementById('submit-user');
    btn.disabled = true; btn.textContent = 'Submitting…';
    try {
      const images = _userImages.length ? await _uploadImages(_userImages) : [];
      await db.collection('support_tickets').add({
        type: 'user_support',
        uid: _user.uid,
        username: _profile.username || '',
        targetUid: _targetUser.uid,
        targetUsername: _targetUser.username,
        description: desc,
        images,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        status: 'open'
      });
      showToast('Support request submitted!', 'success');
      _showTypeSelect();
    } catch { showToast('Failed to submit. Try again.', 'error'); }
    btn.disabled = false; btn.textContent = 'Submit Support Request';
  }

  function _esc(str) {
    const d = document.createElement('div'); d.textContent = String(str); return d.innerHTML;
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => {
  Nav.init('support').then(({ user, profile }) => Support.init(user, profile));
});
