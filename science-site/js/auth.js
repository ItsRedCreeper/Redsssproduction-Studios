/* ==========================================
   Authentication — Login Page
   ========================================== */

document.addEventListener('DOMContentLoaded', function () {
    var loginForm = document.getElementById('login-form');
    var signupForm = document.getElementById('signup-form');
    var authToggleText = document.getElementById('auth-toggle-text');
    var googleBtn = document.getElementById('google-signin');
    var msgBox = document.getElementById('auth-message');

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
            'auth/network-request-failed': 'Network error. Check your connection.'
        };
        return map[code] || 'Something went wrong. Please try again.';
    }

    // Check Firebase loaded
    if (typeof firebase === 'undefined' || typeof auth === 'undefined' || typeof db === 'undefined') {
        showMessage('Error: Firebase failed to load. Check your internet connection and refresh.', 'error');
        return;
    }

    // If already signed in, redirect to app
    auth.onAuthStateChanged(function (user) {
        if (user) {
            window.location.href = 'app.html';
        }
    });

    // Toggle login / signup
    document.addEventListener('click', function (e) {
        var link = e.target.closest('#toggle-auth');
        if (!link) return;
        e.preventDefault();
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
        var email = document.getElementById('login-email').value.trim();
        var password = document.getElementById('login-password').value;
        if (!email || !password) { showMessage('Please fill in all fields.', 'error'); return; }
        disableButtons(true);
        auth.signInWithEmailAndPassword(email, password).catch(function (err) {
            showMessage(friendlyError(err.code), 'error');
            disableButtons(false);
        });
    });

    // Email/Password Signup
    signupForm.addEventListener('submit', function (e) {
        e.preventDefault();
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
            showMessage(friendlyError(err.code), 'error');
            disableButtons(false);
        });
    });

    // Google Sign-In
    googleBtn.addEventListener('click', function () {
        var provider = new firebase.auth.GoogleAuthProvider();
        disableButtons(true);
        showMessage('Opening Google sign-in...', 'success');
        auth.signInWithPopup(provider).then(function (result) {
            var user = result.user;
            return db.collection('users').doc(user.uid).set({
                displayName: user.displayName || '',
                email: user.email || '',
                avatarUrl: user.photoURL || '',
                lastLogin: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        }).catch(function (err) {
            if (err.code !== 'auth/popup-closed-by-user') {
                showMessage(friendlyError(err.code), 'error');
            } else {
                hideMessage();
            }
            disableButtons(false);
        });
    });
});
