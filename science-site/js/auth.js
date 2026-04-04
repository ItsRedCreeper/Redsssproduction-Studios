/* ==========================================
   Authentication — Login Page
   ========================================== */
console.log('[auth.js] Script loaded');

document.addEventListener('DOMContentLoaded', function () {
    console.log('[auth.js] DOMContentLoaded fired');

    var loginForm = document.getElementById('login-form');
    var signupForm = document.getElementById('signup-form');
    var authToggleText = document.getElementById('auth-toggle-text');
    var googleBtn = document.getElementById('google-signin');
    var msgBox = document.getElementById('auth-message');

    console.log('[auth.js] Elements found:', {
        loginForm: !!loginForm,
        signupForm: !!signupForm,
        authToggleText: !!authToggleText,
        googleBtn: !!googleBtn,
        msgBox: !!msgBox
    });

    var isLogin = true;

    function showMessage(text, type) {
        msgBox.textContent = text;
        msgBox.className = 'auth-message ' + type;
        msgBox.classList.remove('hidden');
    }
    function hideMessage() {
        msgBox.classList.add('hidden');
    }
    function disableButtons(disabled) {
        document.querySelectorAll('.btn').forEach(function (b) { b.disabled = disabled; });
    }
    function friendlyError(code) {
        var map = {
            'auth/user-not-found': 'No account found with this email.',
            'auth/wrong-password': 'Incorrect password.',
            'auth/invalid-credential': 'Invalid email or password.',
            'auth/email-already-in-use': 'An account with this email already exists.',
            'auth/weak-password': 'Password must be at least 6 characters.',
            'auth/invalid-email': 'Please enter a valid email address.',
            'auth/too-many-requests': 'Too many attempts. Please try again later.',
            'auth/network-request-failed': 'Network error. Check your connection.',
            'auth/unauthorized-domain': 'This domain is not authorized. Add it in Firebase Console → Authentication → Settings → Authorized domains.',
            'auth/operation-not-allowed': 'This sign-in method is not enabled. Enable it in Firebase Console → Authentication → Sign-in method.',
            'auth/popup-blocked': 'Pop-up was blocked by your browser. Allow pop-ups for this site and try again.',
            'auth/cancelled-popup-request': 'Sign-in cancelled. Please try again.',
            'auth/internal-error': 'Internal error. Please check your internet connection and try again.'
        };
        return map[code] || 'Error (' + code + '). Please try again.';
    }

    // Check Firebase loaded
    if (typeof firebase === 'undefined') {
        console.error('[auth.js] firebase is undefined — SDK not loaded');
        showMessage('Error: Firebase SDK failed to load. Check your internet connection and refresh.', 'error');
        return;
    }
    if (typeof auth === 'undefined' || typeof db === 'undefined') {
        console.error('[auth.js] auth or db undefined — firebase-config.js may have failed');
        showMessage('Error: Firebase config failed to initialize. Check console for details.', 'error');
        return;
    }

    console.log('[auth.js] Firebase ready, attaching listeners');

    // If already signed in, redirect to app
    auth.onAuthStateChanged(function (user) {
        if (user) {
            console.log('[auth.js] User already signed in, redirecting');
            window.location.href = 'app.html';
        }
    });

    // Toggle login / signup
    document.addEventListener('click', function (e) {
        var link = e.target.closest('#toggle-auth');
        if (!link) return;
        e.preventDefault();
        console.log('[auth.js] Toggle clicked');
        isLogin = !isLogin;
        if (isLogin) {
            loginForm.classList.remove('hidden');
            signupForm.classList.add('hidden');
            authToggleText.innerHTML = 'Don\'t have an account? <a href="#" id="toggle-auth">Sign up</a>';
        } else {
            loginForm.classList.add('hidden');
            signupForm.classList.remove('hidden');
            authToggleText.innerHTML = 'Already have an account? <a href="#" id="toggle-auth">Sign in</a>';
        }
        hideMessage();
    });

    // Email/Password Login
    loginForm.addEventListener('submit', function (e) {
        e.preventDefault();
        console.log('[auth.js] Login submit');
        var email = document.getElementById('login-email').value.trim();
        var password = document.getElementById('login-password').value;
        if (!email || !password) { showMessage('Please fill in all fields.', 'error'); return; }
        disableButtons(true);
        auth.signInWithEmailAndPassword(email, password).catch(function (err) {
            console.error('[auth.js] Login error:', err.code, err.message);
            showMessage(friendlyError(err.code), 'error');
            disableButtons(false);
        });
    });

    // Email/Password Signup
    signupForm.addEventListener('submit', function (e) {
        e.preventDefault();
        console.log('[auth.js] Signup submit');
        var name = document.getElementById('signup-name').value.trim();
        var email = document.getElementById('signup-email').value.trim();
        var password = document.getElementById('signup-password').value;
        if (!name || !email || !password) { showMessage('Please fill in all fields.', 'error'); return; }
        disableButtons(true);
        auth.createUserWithEmailAndPassword(email, password).then(function (cred) {
            return cred.user.updateProfile({ displayName: name }).then(function () {
                return db.collection('users').doc(cred.user.uid).set({
                    displayName: name,
                    email: email,
                    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                    avatarUrl: ''
                });
            });
        }).catch(function (err) {
            console.error('[auth.js] Signup error:', err.code, err.message);
            showMessage(friendlyError(err.code), 'error');
            disableButtons(false);
        });
    });

    // Google Sign-In
    googleBtn.addEventListener('click', function () {
        console.log('[auth.js] Google sign-in clicked');
        var provider = new firebase.auth.GoogleAuthProvider();
        disableButtons(true);
        showMessage('Opening Google sign-in...', 'success');
        auth.signInWithPopup(provider).then(function (result) {
            console.log('[auth.js] Google sign-in success');
            var user = result.user;
            return db.collection('users').doc(user.uid).set({
                displayName: user.displayName || '',
                email: user.email || '',
                avatarUrl: user.photoURL || '',
                lastLogin: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        }).catch(function (err) {
            console.error('[auth.js] Google sign-in error:', err.code, err.message);
            if (err.code !== 'auth/popup-closed-by-user') {
                showMessage(friendlyError(err.code), 'error');
            } else {
                hideMessage();
            }
            disableButtons(false);
        });
    });

    console.log('[auth.js] All listeners attached');
});
