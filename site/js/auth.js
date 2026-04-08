/* ───────────────────────────────────────────────
   Auth — RedsssProduction Studios
   Login: username + password
   Register: username, email, password, optional avatar
   Google sign-in
   ─────────────────────────────────────────────── */

const Auth = (() => {
  const googleProvider = new firebase.auth.GoogleAuthProvider();
  let _regAvatarBlob = null;

  function init() {
    // Login form
    document.getElementById('login-btn').addEventListener('click', handleLogin);
    document.getElementById('login-form').addEventListener('keydown', e => { if (e.key === 'Enter') handleLogin(); });

    // Register form
    document.getElementById('register-btn').addEventListener('click', handleRegister);
    document.getElementById('register-form').addEventListener('keydown', e => { if (e.key === 'Enter') handleRegister(); });

    // Google buttons
    document.querySelectorAll('.btn-google').forEach(b => b.addEventListener('click', handleGoogle));

    // Switch between login/register
    document.getElementById('goto-register').addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById('login-page').style.display = 'none';
      document.getElementById('register-page').style.display = 'flex';
    });
    document.getElementById('goto-login').addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById('register-page').style.display = 'none';
      document.getElementById('login-page').style.display = 'flex';
    });

    // Avatar preview on register (with crop)
    document.getElementById('reg-avatar-input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) { showToast('Image must be under 5 MB', 'error'); return; }
      try {
        _regAvatarBlob = await CropperUtil.open(file, { aspectRatio: 1, width: 256, height: 256 });
        const url = URL.createObjectURL(_regAvatarBlob);
        document.getElementById('reg-avatar-preview').innerHTML = '<img src="' + url + '" alt="">';
      } catch { _regAvatarBlob = null; }
      e.target.value = '';
    });

    document.getElementById('reg-avatar-preview').addEventListener('click', () => {
      document.getElementById('reg-avatar-input').click();
    });
  }

  async function handleLogin() {
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const errorEl = document.getElementById('login-error');
    errorEl.textContent = '';

    if (!username || !password) {
      errorEl.textContent = 'Please fill in all fields.';
      return;
    }

    document.getElementById('login-btn').disabled = true;

    try {
      // Look up email by username
      const snap = await db.collection('users')
        .where('usernameLower', '==', username.toLowerCase())
        .limit(1)
        .get();

      if (snap.empty) {
        errorEl.textContent = 'No account found with that username.';
        document.getElementById('login-btn').disabled = false;
        return;
      }

      const email = snap.docs[0].data().email;
      await auth.signInWithEmailAndPassword(email, password);
    } catch (err) {
      errorEl.textContent = friendlyError(err.code);
      document.getElementById('login-btn').disabled = false;
    }
  }

  async function handleRegister() {
    const username = document.getElementById('reg-username').value.trim();
    const email = document.getElementById('reg-email').value.trim();
    const password = document.getElementById('reg-password').value;
    const confirm = document.getElementById('reg-confirm').value;
    const errorEl = document.getElementById('reg-error');
    errorEl.textContent = '';

    if (!username || !email || !password || !confirm) {
      errorEl.textContent = 'Please fill in all fields.';
      return;
    }
    if (username.length < 3 || username.length > 20) {
      errorEl.textContent = 'Username must be 3–20 characters.';
      return;
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      errorEl.textContent = 'Username can only contain letters, numbers, and underscores.';
      return;
    }
    if (password.length < 6 || password.length > 128) {
      errorEl.textContent = 'Password must be 6–128 characters.';
      return;
    }
    if (password !== confirm) {
      errorEl.textContent = 'Passwords do not match.';
      return;
    }

    document.getElementById('register-btn').disabled = true;

    try {
      // Check username uniqueness
      const existing = await db.collection('users')
        .where('usernameLower', '==', username.toLowerCase())
        .limit(1)
        .get();

      if (!existing.empty) {
        errorEl.textContent = 'Username is already taken.';
        document.getElementById('register-btn').disabled = false;
        return;
      }

      // Upload avatar if provided
      let avatarUrl = '';
      if (_regAvatarBlob) {
        avatarUrl = await uploadToCloudinary(_regAvatarBlob);
        _regAvatarBlob = null;
      }

      const cred = await auth.createUserWithEmailAndPassword(email, password);
      await createUserProfile(cred.user, username, avatarUrl);
    } catch (err) {
      errorEl.textContent = friendlyError(err.code);
      document.getElementById('register-btn').disabled = false;
    }
  }

  async function handleGoogle() {
    try {
      const result = await auth.signInWithPopup(googleProvider);
      if (result.additionalUserInfo && result.additionalUserInfo.isNewUser) {
        const name = result.user.displayName || 'User';
        await createUserProfile(result.user, name, result.user.photoURL || '');
      }
    } catch (err) {
      showToast(friendlyError(err.code), 'error');
    }
  }

  async function createUserProfile(user, username, avatar) {
    await db.collection('users').doc(user.uid).set({
      username: username,
      usernameLower: username.toLowerCase(),
      email: user.email,
      avatar: avatar || '',
      status: 'auto',
      effectiveStatus: 'online',
      role: 'user',
      friends: [],
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
      online: true
    });
  }

  async function uploadToCloudinary(file) {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('upload_preset', CLOUDINARY_PRESET);
    const res = await fetch('https://api.cloudinary.com/v1_1/' + CLOUDINARY_CLOUD + '/image/upload', {
      method: 'POST', body: fd
    });
    const data = await res.json();
    return data.secure_url || '';
  }

  function friendlyError(code) {
    const map = {
      'auth/email-already-in-use': 'An account with this email already exists.',
      'auth/invalid-email': 'Please enter a valid email address.',
      'auth/wrong-password': 'Incorrect password.',
      'auth/user-not-found': 'No account found.',
      'auth/weak-password': 'Password must be at least 6 characters.',
      'auth/too-many-requests': 'Too many attempts. Try again later.',
      'auth/popup-closed-by-user': 'Sign-in popup was closed.',
      'auth/network-request-failed': 'Network error. Check your connection.',
      'auth/invalid-credential': 'Invalid username or password.',
    };
    return map[code] || 'Something went wrong. Please try again.';
  }

  function showLogin() {
    document.getElementById('login-page').style.display = 'flex';
    document.getElementById('register-page').style.display = 'none';
  }

  function hideAll() {
    document.getElementById('login-page').style.display = 'none';
    document.getElementById('register-page').style.display = 'none';
  }

  return { init, showLogin, hideAll };
})();
