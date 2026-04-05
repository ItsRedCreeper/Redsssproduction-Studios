/* ==========================================
   Authentication — Login Page (Google only)
   ========================================== */
console.log('[auth.js] Script loaded');

document.addEventListener('DOMContentLoaded', function () {
    console.log('[auth.js] DOMContentLoaded fired');

    var googleBtn = document.getElementById('google-signin');
    var msgBox = document.getElementById('auth-message');
    var cancelTimer = null;

    function showMessage(text, type) {
        msgBox.textContent = text;
        msgBox.className = 'auth-message ' + type;
        msgBox.classList.remove('hidden');
    }
    function hideMessage() {
        msgBox.classList.add('hidden');
    }
    function resetButton() {
        clearTimeout(cancelTimer);
        googleBtn.disabled = false;
        googleBtn.querySelector('span').textContent = 'Continue with Google';
        hideMessage();
    }
    function friendlyError(code) {
        var map = {
            'auth/unauthorized-domain': 'This domain is not authorized. Add it in Firebase Console \u2192 Authentication \u2192 Settings \u2192 Authorized domains.',
            'auth/operation-not-allowed': 'Google sign-in is not enabled. Enable it in Firebase Console \u2192 Authentication \u2192 Sign-in method.',
            'auth/popup-blocked': 'Pop-up was blocked. Please allow pop-ups for this site and try again.',
            'auth/network-request-failed': 'Network error. Check your connection.',
            'auth/internal-error': 'Internal error. Please try again.',
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

    auth.onAuthStateChanged(function (user) {
        if (user) {
            console.log('[auth.js] Signed in, redirecting to app');
            window.location.href = 'app.html';
        }
    });

    googleBtn.addEventListener('click', function () {
        if (googleBtn.disabled) return;
        console.log('[auth.js] Google sign-in clicked');
        var provider = new firebase.auth.GoogleAuthProvider();
        googleBtn.disabled = true;
        googleBtn.querySelector('span').textContent = 'Signing in\u2026';

        // After 1.5s show a cancel link so the user isn't stuck if they close the popup
        cancelTimer = setTimeout(function () {
            msgBox.className = 'auth-message info';
            msgBox.classList.remove('hidden');
            msgBox.innerHTML = 'Window closed? <a href="#" id="auth-cancel-link" style="color:inherit;font-weight:600;text-decoration:underline">Click here to try again.</a>';
            var link = document.getElementById('auth-cancel-link');
            if (link) link.addEventListener('click', function (e) { e.preventDefault(); resetButton(); });
        }, 1500);

        auth.signInWithPopup(provider)
            .then(function (result) {
                clearTimeout(cancelTimer);
                console.log('[auth.js] Google sign-in success');
                var user = result.user;
                if (!user) return;
                return db.collection('users').doc(user.uid).set({
                    displayName: user.displayName || '',
                    email: user.email || '',
                    avatarUrl: user.photoURL || '',
                    lastLogin: firebase.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
            })
            .catch(function (err) {
                console.error('[auth.js] Google error:', err.code, err.message);
                var silent = ['auth/popup-closed-by-user', 'auth/cancelled-popup-request'];
                if (silent.indexOf(err.code) !== -1) {
                    resetButton();
                } else {
                    clearTimeout(cancelTimer);
                    showMessage(friendlyError(err.code), 'error');
                    googleBtn.disabled = false;
                    googleBtn.querySelector('span').textContent = 'Continue with Google';
                }
            });
    });

    console.log('[auth.js] Listeners attached');
});
