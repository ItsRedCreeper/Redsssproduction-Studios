/* ───────────────────────────────────────────────
   support.js — Support page
   Loaded by support.html after nav.js resolves auth.
   ─────────────────────────────────────────────── */

const Support = (() => {
  let _user    = null;
  let _profile = null;

  function init(user, profile) {
    _user    = user;
    _profile = profile;
    document.getElementById('submit-support').addEventListener('click', _submit);
  }

  async function _submit() {
    const subject = document.getElementById('support-subject').value.trim();
    const message = document.getElementById('support-message').value.trim();
    if (!subject || !message) { showToast('Please fill in both fields.', 'error'); return; }
    try {
      await db.collection('support_tickets').add({
        uid:       _user.uid,
        username:  _profile.username || '',
        subject,
        message,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        status:    'open'
      });
      document.getElementById('support-subject').value = '';
      document.getElementById('support-message').value = '';
      showToast("Message sent! We'll get back to you.", 'success');
    } catch { showToast('Failed to send. Try again later.', 'error'); }
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => {
  Nav.init('support').then(({ user, profile }) => Support.init(user, profile));
});
