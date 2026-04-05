/* ==========================================
   Authentication — Login Page (Google only)
   Uses signInWithRedirect for reliable flow.
   ========================================== */
console.log('[auth.js] Script loaded');

document.addEventListener('DOMContentLoaded', function () {
    console.log('[auth.js] DOMContentLoaded fired');

    var googleBtn = document.getElementById('google-signin');
    var msgBox = document.getElementById('auth-message');

    function showMessage(text, type) {
        msgBox.textContent = text;
        msgBox.className = 'auth-message ' + type;
        msgBox.classList.remove('hidden');
    }
    function hideMessage() {
        msgBox.classList.add('hidden');
    }
    function friendlyError(code) {
        var map = {
            'auth/unauthorized-domain': 'This domain is not authorized. Add it in Firebase Console → Authentication → Settings → Authorized domains.',
            'auth/operation-not-allowed': 'Google sign-in is not enabled. Enable it in Firebase Console → Authentication → Sign-in method.',
            'auth/network-request-failed': 'Network error. Check your connection.',
            'auth/internal-error': 'Internal error. Please check your internet connection and try again.',
            'auth/too-many-requests': 'Too many attempts. Please try again later.'
        };
        return map[code] || 'Error (' + code + '). Please try again.';
    }

    if (typeof firebase === 'undefined') {
        console.error('[auth.js] firebase undefined — SDK not loaded');
        showMessage('Error: Firebase SDK failed to load. Check your internet connection and refresh.', 'error');
        return;
    }
    if (typeof auth === 'undefined' || typeof db === 'undefined') {
        console.error('[auth.js] auth or db undefined — firebase-config.js may have failed');
        showMessage('Error: Firebase config failed to initialize.', 'error');
        return;
    }

    console.log('[auth.js] Firebase ready');

    // Handle redirect result (runs on page load after Google redirects back)
    auth.getRedirectResult().then(function (result) {
        if (result && result.user) {
            console.log('[auth.js] Redirect sign-in success');
            var user = result.user;
            return db.collection('users').doc(user.uid).set({
                displayName: user.displayName || '',
                email: user.email || '',
                avatarUrl: user.photoURL || '',
                lastLogin: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        }
    }).catch(function (err) {
        console.error('[auth.js] Redirect error:', err.code, err.message);
        showMessage(friendlyError(err.code), 'error');
    });

    // If already signed in, go to app
    auth.onAuthStateChanged(function (user) {
        if (user) {
            console.log('[auth.js] Signed in, redirecting to app');
            window.location.href = 'app.html';
        }
    });

    // Google button — just starts a redirect, no popup
    googleBtn.addEventListener('click', function () {
        if (googleBtn.disabled) return;
        console.log('[auth.js] Google sign-in clicked — redirecting');
        var provider = new firebase.auth.GoogleAuthProvider();
        googleBtn.disabled = true;
        googleBtn.querySelector('span').textContent = 'Redirecting\u2026';
        auth.signInWithRedirect(provider);
    });

    console.log('[auth.js] Listeners attached');
});
