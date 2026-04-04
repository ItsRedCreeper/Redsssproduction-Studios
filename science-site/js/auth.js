/* ==========================================
   Authentication — Login Page
   ========================================== */

(function () {
    const loginForm = document.getElementById('login-form');
    const signupForm = document.getElementById('signup-form');
    const authToggleText = document.getElementById('auth-toggle-text');
    const googleBtn = document.getElementById('google-signin');
    const msgBox = document.getElementById('auth-message');

    let isLogin = true;

    // If already signed in, redirect to app
    auth.onAuthStateChanged(user => {
        if (user) {
            window.location.href = 'app.html';
        }
    });

    // Toggle login / signup — use event delegation so it survives innerHTML changes
    authToggleText.addEventListener('click', function (e) {
        if (e.target.id === 'toggle-auth' || e.target.closest('#toggle-auth')) {
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
        }
    });

    // Email/Password Login
    loginForm.addEventListener('submit', async e => {
        e.preventDefault();
        const email = document.getElementById('login-email').value.trim();
        const password = document.getElementById('login-password').value;
        if (!email || !password) return showMessage('Please fill in all fields.', 'error');
        try {
            disableButtons(true);
            await auth.signInWithEmailAndPassword(email, password);
        } catch (err) {
            showMessage(friendlyError(err.code), 'error');
            disableButtons(false);
        }
    });

    // Email/Password Signup
    signupForm.addEventListener('submit', async e => {
        e.preventDefault();
        const name = document.getElementById('signup-name').value.trim();
        const email = document.getElementById('signup-email').value.trim();
        const password = document.getElementById('signup-password').value;
        if (!name || !email || !password) return showMessage('Please fill in all fields.', 'error');
        try {
            disableButtons(true);
            const cred = await auth.createUserWithEmailAndPassword(email, password);
            await cred.user.updateProfile({ displayName: name });
            await db.collection('users').doc(cred.user.uid).set({
                displayName: name,
                email: email,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                avatarUrl: ''
            });
        } catch (err) {
            showMessage(friendlyError(err.code), 'error');
            disableButtons(false);
        }
    });

    // Google Sign-In
    googleBtn.addEventListener('click', async function () {
        const provider = new firebase.auth.GoogleAuthProvider();
        try {
            disableButtons(true);
            showMessage('Opening Google sign-in...', 'success');
            const result = await auth.signInWithPopup(provider);
            const user = result.user;
            await db.collection('users').doc(user.uid).set({
                displayName: user.displayName || '',
                email: user.email || '',
                avatarUrl: user.photoURL || '',
                lastLogin: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        } catch (err) {
            if (err.code !== 'auth/popup-closed-by-user') {
                showMessage(friendlyError(err.code), 'error');
            } else {
                hideMessage();
            }
            disableButtons(false);
        }
    });

    function showMessage(text, type) {
        msgBox.textContent = text;
        msgBox.className = 'auth-message ' + type;
        msgBox.classList.remove('hidden');
    }
    function hideMessage() {
        msgBox.classList.add('hidden');
    }
    function disableButtons(disabled) {
        document.querySelectorAll('.btn').forEach(b => b.disabled = disabled);
    }
    function friendlyError(code) {
        const map = {
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
})();
