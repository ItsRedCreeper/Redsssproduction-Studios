/* ───────────────────────────────────────────────
   App — RedsssProduction Studios v2
   Navigation, Games, Admin, Profiles, Toast
   ─────────────────────────────────────────────── */

let currentUser = null;
let currentProfile = null;

/* ─── TOAST ─── */

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3500);
}

/* ─── AUTH STATE ─── */

auth.onAuthStateChanged(async (user) => {
  const loading = document.getElementById('loading-screen');

  if (user) {
    currentUser = user;
    try {
      await loadUserProfile(user);
      Auth.hide();
      document.getElementById('app').classList.add('active');
      loadGames();
      Friends.init();
    } catch (err) {
      console.error('Failed to load profile:', err);
      showToast('Failed to load profile.', 'error');
    }
  } else {
    currentUser = null;
    currentProfile = null;
    document.getElementById('app').classList.remove('active');
    Auth.show();
  }

  loading.style.display = 'none';
});

async function loadUserProfile(user) {
  const doc = await db.collection('users').doc(user.uid).get();
  if (doc.exists) {
    currentProfile = { id: doc.id, ...doc.data() };
    updatePresence(true);
  } else {
    // Profile missing (e.g. Google sign-in where profile wasn't created) — create one
    await db.collection('users').doc(user.uid).set({
      username: user.displayName || 'User',
      usernameLower: (user.displayName || 'user').toLowerCase(),
      email: user.email,
      avatar: user.photoURL || '',
      status: '',
      role: 'user',
      friends: [],
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
      online: true
    });
    const newDoc = await db.collection('users').doc(user.uid).get();
    currentProfile = { id: newDoc.id, ...newDoc.data() };
  }
  renderUserUI();
}

function updatePresence(online) {
  if (!currentUser) return;
  db.collection('users').doc(currentUser.uid).update({
    online: online,
    lastSeen: firebase.firestore.FieldValue.serverTimestamp()
  }).catch(() => {});
}

window.addEventListener('beforeunload', () => updatePresence(false));

/* ─── RENDER USER UI ─── */

function renderUserUI() {
  if (!currentProfile) return;

  const initial = (currentProfile.username || '?')[0].toUpperCase();

  // Nav avatar
  const navAvatar = document.getElementById('nav-avatar');
  if (currentProfile.avatar) {
    navAvatar.innerHTML = '<img src="' + escapeHtml(currentProfile.avatar) + '" alt="">';
  } else {
    navAvatar.textContent = initial;
  }

  // Profile dropdown
  const profAvatarLg = document.getElementById('profile-avatar-lg');
  if (currentProfile.avatar) {
    profAvatarLg.innerHTML = '<img src="' + escapeHtml(currentProfile.avatar) + '" alt="">';
  } else {
    profAvatarLg.textContent = initial;
  }

  document.getElementById('profile-name').textContent = currentProfile.username;
  document.getElementById('profile-email').textContent = currentProfile.email;
  document.getElementById('profile-status').value = currentProfile.status || '';

  // Admin tab
  if (currentProfile.role === 'admin') {
    document.getElementById('nav-admin').style.display = '';
  }
}

/* ─── NAVIGATION ─── */

document.querySelectorAll('.nav-link[data-page]').forEach(link => {
  link.addEventListener('click', () => {
    const page = link.dataset.page;

    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
    link.classList.add('active');
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-' + page).classList.add('active');

    const titles = {
      home: 'RedsssProduction Studios',
      games: 'Games — RedsssProduction Studios',
      friends: 'Friends — RedsssProduction Studios',
      messenger: 'Messenger — RedsssProduction Studios',
      admin: 'Admin — RedsssProduction Studios'
    };
    document.title = titles[page] || 'RedsssProduction Studios';

    if (page === 'admin' && currentProfile && currentProfile.role === 'admin') {
      loadAdminGames();
      loadAdminUsers();
    }
  });
});

/* ─── PROFILE DROPDOWN ─── */

document.getElementById('nav-avatar').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('profile-dropdown').classList.toggle('active');
});

document.addEventListener('click', (e) => {
  const dd = document.getElementById('profile-dropdown');
  if (!dd.contains(e.target)) dd.classList.remove('active');
});

// Avatar upload
document.getElementById('profile-avatar-lg').addEventListener('click', () => {
  document.getElementById('avatar-upload').click();
});

document.getElementById('avatar-upload').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { showToast('Image must be under 5MB.', 'error'); return; }

  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', CLOUDINARY_PRESET);

  try {
    showToast('Uploading avatar...', 'info');
    const res = await fetch('https://api.cloudinary.com/v1_1/' + CLOUDINARY_CLOUD + '/image/upload', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();
    if (data.secure_url) {
      await db.collection('users').doc(currentUser.uid).update({ avatar: data.secure_url });
      currentProfile.avatar = data.secure_url;
      renderUserUI();
      showToast('Avatar updated!', 'success');
    }
  } catch (err) {
    showToast('Upload failed.', 'error');
  }
});

// Save profile (status)
document.getElementById('save-profile-btn').addEventListener('click', async () => {
  const status = document.getElementById('profile-status').value.trim();
  try {
    await db.collection('users').doc(currentUser.uid).update({ status: status });
    currentProfile.status = status;
    showToast('Profile saved!', 'success');
    document.getElementById('profile-dropdown').classList.remove('active');
  } catch (err) {
    showToast('Failed to save.', 'error');
  }
});

/* ─── LOGOUT ─── */

document.getElementById('btn-logout').addEventListener('click', async () => {
  updatePresence(false);
  await auth.signOut();
});

/* ─── GAMES ─── */

let gamesCache = [];

async function loadGames() {
  try {
    const snap = await db.collection('games').orderBy('title').get();
    gamesCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderGamesGrid();
    renderHomeSlideshow();
  } catch (err) {
    console.error('Failed to load games:', err);
  }
}

function renderGamesGrid() {
  const grid = document.getElementById('games-grid');
  if (gamesCache.length === 0) {
    grid.innerHTML = '<p style="color:var(--text-muted)">No games yet. Check back soon!</p>';
    return;
  }
  grid.innerHTML = gamesCache.map(g => `
    <div class="game-card" onclick="openGame('${escapeHtml(g.url || '')}', '${escapeHtml(g.title)}')">
      <div class="game-card-img">
        ${g.image ? '<img src="' + escapeHtml(g.image) + '" alt="">' : '🎮'}
      </div>
      <div class="game-card-body">
        <h3>${escapeHtml(g.title)}</h3>
        <p>${escapeHtml(g.description || '')}</p>
        <span class="game-badge badge-${g.status || 'released'}">${badgeLabel(g.status)}</span>
      </div>
    </div>
  `).join('');
}

function renderHomeSlideshow() {
  const container = document.getElementById('home-slideshow');
  if (gamesCache.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted)">No games yet.</p>';
    return;
  }
  container.innerHTML = gamesCache.map(g => `
    <div class="game-card" style="min-width:300px;flex-shrink:0" onclick="openGame('${escapeHtml(g.url || '')}', '${escapeHtml(g.title)}')">
      <div class="game-card-img">
        ${g.image ? '<img src="' + escapeHtml(g.image) + '" alt="">' : '🎮'}
      </div>
      <div class="game-card-body">
        <h3>${escapeHtml(g.title)}</h3>
        <p>${escapeHtml(g.description || '')}</p>
      </div>
    </div>
  `).join('');
}

function badgeLabel(status) {
  return { released: 'Released', early: 'Early Access', coming: 'Coming Soon' }[status] || 'Released';
}

/* ─── GAME PLAYER ─── */

function openGame(url, title) {
  if (!url) { showToast('This game is not available yet.', 'info'); return; }
  document.getElementById('game-player-title').textContent = title;
  document.getElementById('game-iframe').src = url;
  document.getElementById('game-player').classList.add('active');
}

document.getElementById('game-player-close').addEventListener('click', () => {
  document.getElementById('game-player').classList.remove('active');
  document.getElementById('game-iframe').src = '';
});

/* ─── ADMIN: GAMES ─── */

let editingGameId = null;

async function loadAdminGames() {
  try {
    const snap = await db.collection('games').orderBy('title').get();
    const tbody = document.getElementById('games-table-body');
    tbody.innerHTML = snap.docs.map(d => {
      const g = d.data();
      return `<tr>
        <td>${escapeHtml(g.title)}</td>
        <td>${badgeLabel(g.status)}</td>
        <td>
          <button class="btn-edit" onclick="editGame('${d.id}')">Edit</button>
          <button class="btn-delete" onclick="deleteGame('${d.id}')">Delete</button>
        </td>
      </tr>`;
    }).join('');
  } catch (err) {
    showToast('Failed to load games.', 'error');
  }
}

document.getElementById('save-game-btn').addEventListener('click', async () => {
  const title = document.getElementById('game-title').value.trim();
  const desc = document.getElementById('game-desc').value.trim();
  const url = document.getElementById('game-url').value.trim();
  const image = document.getElementById('game-img').value.trim();
  const status = document.getElementById('game-status').value;

  if (!title) { showToast('Game title is required.', 'error'); return; }

  const data = { title, description: desc, url, image, status };

  try {
    if (editingGameId) {
      await db.collection('games').doc(editingGameId).update(data);
      showToast('Game updated!', 'success');
      editingGameId = null;
      document.getElementById('save-game-btn').textContent = 'Add Game';
    } else {
      await db.collection('games').add(data);
      showToast('Game added!', 'success');
    }
    clearGameForm();
    loadAdminGames();
    loadGames();
  } catch (err) {
    showToast('Failed to save game.', 'error');
  }
});

async function editGame(id) {
  const doc = await db.collection('games').doc(id).get();
  if (!doc.exists) return;
  const g = doc.data();
  document.getElementById('game-title').value = g.title || '';
  document.getElementById('game-desc').value = g.description || '';
  document.getElementById('game-url').value = g.url || '';
  document.getElementById('game-img').value = g.image || '';
  document.getElementById('game-status').value = g.status || 'released';
  editingGameId = id;
  document.getElementById('save-game-btn').textContent = 'Update Game';
}

async function deleteGame(id) {
  if (!confirm('Delete this game?')) return;
  try {
    await db.collection('games').doc(id).delete();
    showToast('Game deleted.', 'success');
    loadAdminGames();
    loadGames();
  } catch (err) {
    showToast('Failed to delete.', 'error');
  }
}

function clearGameForm() {
  document.getElementById('game-title').value = '';
  document.getElementById('game-desc').value = '';
  document.getElementById('game-url').value = '';
  document.getElementById('game-img').value = '';
  document.getElementById('game-status').value = 'released';
}

/* ─── ADMIN: USERS ─── */

async function loadAdminUsers() {
  try {
    const snap = await db.collection('users').orderBy('username').get();
    const tbody = document.getElementById('users-table-body');
    tbody.innerHTML = snap.docs.map(d => {
      const u = d.data();
      return `<tr>
        <td>${escapeHtml(u.username)}</td>
        <td>${escapeHtml(u.email)}</td>
        <td>${u.role || 'user'}</td>
        <td>
          ${u.role !== 'admin' ? `<button class="btn-edit" onclick="promoteUser('${d.id}')">Make Admin</button>` : '<em>Admin</em>'}
          ${d.id !== currentUser.uid ? `<button class="btn-delete" onclick="deleteUser('${d.id}')">Delete</button>` : ''}
        </td>
      </tr>`;
    }).join('');
  } catch (err) {
    showToast('Failed to load users.', 'error');
  }
}

async function promoteUser(uid) {
  if (!confirm('Make this user an admin?')) return;
  try {
    await db.collection('users').doc(uid).update({ role: 'admin' });
    showToast('User promoted to admin.', 'success');
    loadAdminUsers();
  } catch (err) {
    showToast('Failed to promote user.', 'error');
  }
}

async function deleteUser(uid) {
  if (!confirm('Delete this user? This removes their profile data.')) return;
  try {
    await db.collection('users').doc(uid).delete();
    showToast('User deleted.', 'success');
    loadAdminUsers();
  } catch (err) {
    showToast('Failed to delete user.', 'error');
  }
}

/* ─── HTML ESCAPE UTILITY ─── */

function escapeHtml(str) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

/* ─── INIT ─── */

Auth.init();
