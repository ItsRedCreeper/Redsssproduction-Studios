/* ==========================================
   Authentication — Login Page (Google only)
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
            'auth/popup-blocked': 'Pop-up was blocked by your browser. Please allow pop-ups for this site and try again.',
            'auth/cancelled-popup-request': 'Sign-in cancelled. Please try again.',
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

    auth.onAuthStateChanged(function (user) {
        if (user) {
            console.log('[auth.js] Already signed in, redirecting');
            window.location.href = 'app.html';
        }
    });

    googleBtn.addEventListener('click', function () {
        console.log('[auth.js] Google sign-in clicked');
        var provider = new firebase.auth.GoogleAuthProvider();
        googleBtn.disabled = true;
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
            console.error('[auth.js] Google error:', err.code, err.message);
            if (err.code !== 'auth/popup-closed-by-user') {
                showMessage(friendlyError(err.code), 'error');
            } else {
                hideMessage();
            }
            googleBtn.disabled = false;
        });
    });

    console.log('[auth.js] Listeners attached');
});

    console.log('[auth.js] All listeners attached');
});
