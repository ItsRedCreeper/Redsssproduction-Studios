/* ───────────────────────────────────────────────
   Auth — RedsssProduction Studios v2
   Email/Password + Google Sign-In
   ─────────────────────────────────────────────── */

const Auth = (() => {
  const googleProvider = new firebase.auth.GoogleAuthProvider();

  // DOM refs
  const els = {
    screen: () => document.getElementById('auth-screen'),
    tabs: () => document.querySelectorAll('.auth-tab'),
    loginForm: () => document.getElementById('login-form'),
    registerForm: () => document.getElementById('register-form'),
    loginEmail: () => document.getElementById('login-email'),
    loginPassword: () => document.getElementById('login-password'),
    loginBtn: () => document.getElementById('login-btn'),
    loginError: () => document.getElementById('login-error'),
    regUsername: () => document.getElementById('reg-username'),
    regEmail: () => document.getElementById('reg-email'),
    regPassword: () => document.getElementById('reg-password'),
    regConfirm: () => document.getElementById('reg-confirm'),
    regBtn: () => document.getElementById('reg-btn'),
    regError: () => document.getElementById('reg-error'),
    googleBtns: () => document.querySelectorAll('.btn-google'),
  };

  function init() {
    // Tab switching
    els.tabs().forEach(tab => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.tab;
        els.tabs().forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
        document.getElementById(target + '-form').classList.add('active');
      });
    });

    // Login
    els.loginBtn().addEventListener('click', handleLogin);
    els.loginForm().addEventListener('keydown', e => { if (e.key === 'Enter') handleLogin(); });

    // Register
    els.regBtn().addEventListener('click', handleRegister);
    els.registerForm().addEventListener('keydown', e => { if (e.key === 'Enter') handleRegister(); });

    // Google sign-in
    els.googleBtns().forEach(btn => btn.addEventListener('click', handleGoogle));
  }

  async function handleLogin() {
    const email = els.loginEmail().value.trim();
    const password = els.loginPassword().value;
    els.loginError().textContent = '';

    if (!email || !password) {
      els.loginError().textContent = 'Please fill in all fields.';
      return;
    }

    els.loginBtn().disabled = true;
    try {
      await auth.signInWithEmailAndPassword(email, password);
    } catch (err) {
      els.loginError().textContent = friendlyError(err.code);
      els.loginBtn().disabled = false;
    }
  }

  async function handleRegister() {
    const username = els.regUsername().value.trim();
    const email = els.regEmail().value.trim();
    const password = els.regPassword().value;
    const confirm = els.regConfirm().value;
    els.regError().textContent = '';

    if (!username || !email || !password || !confirm) {
      els.regError().textContent = 'Please fill in all fields.';
      return;
    }
    if (username.length < 3 || username.length > 20) {
      els.regError().textContent = 'Username must be 3-20 characters.';
      return;
    }
    if (password.length < 6) {
      els.regError().textContent = 'Password must be at least 6 characters.';
      return;
    }
    if (password !== confirm) {
      els.regError().textContent = 'Passwords do not match.';
      return;
    }

    els.regBtn().disabled = true;
    try {
      // Check username uniqueness
      const snap = await db.collection('users').where('usernameLower', '==', username.toLowerCase()).get();
      if (!snap.empty) {
        els.regError().textContent = 'Username is already taken.';
        els.regBtn().disabled = false;
        return;
      }

      const cred = await auth.createUserWithEmailAndPassword(email, password);
      await createUserProfile(cred.user, username);
    } catch (err) {
      els.regError().textContent = friendlyError(err.code);
      els.regBtn().disabled = false;
    }
  }

  async function handleGoogle() {
    try {
      const result = await auth.signInWithPopup(googleProvider);
      if (result.additionalUserInfo.isNewUser) {
        const name = result.user.displayName || 'User';
        await createUserProfile(result.user, name);
      }
    } catch (err) {
      showToast(friendlyError(err.code), 'error');
    }
  }

  async function createUserProfile(user, username) {
    await db.collection('users').doc(user.uid).set({
      username: username,
      usernameLower: username.toLowerCase(),
      email: user.email,
      avatar: user.photoURL || '',
      status: '',
      role: 'user',
      friends: [],
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
      online: true
    });
  }

  function friendlyError(code) {
    const map = {
      'auth/email-already-in-use': 'An account with this email already exists.',
      'auth/invalid-email': 'Please enter a valid email address.',
      'auth/wrong-password': 'Incorrect password.',
      'auth/user-not-found': 'No account found with this email.',
      'auth/weak-password': 'Password must be at least 6 characters.',
      'auth/too-many-requests': 'Too many attempts. Please try again later.',
      'auth/popup-closed-by-user': 'Sign-in popup was closed.',
      'auth/network-request-failed': 'Network error. Check your connection.',
      'auth/invalid-credential': 'Invalid email or password.',
    };
    return map[code] || 'Something went wrong. Please try again.';
  }

  function show() {
    els.screen().style.display = 'flex';
  }

  function hide() {
    els.screen().style.display = 'none';
  }

  return { init, show, hide };
})();
