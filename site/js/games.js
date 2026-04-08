/* ───────────────────────────────────────────────
   games.js — Games page
   Loaded by games.html after nav.js resolves auth.
   ─────────────────────────────────────────────── */

const Games = (() => {
  let _user = null;

  function init(user) {
    _user = user;
    _loadGames();
    document.getElementById('game-player-close').addEventListener('click', _closePlayer);

    // Receive activity updates from Unity WebGL games running inside the iframe
    // Unity plugin calls: window.parent.postMessage({ type:'gameActivity', game:'Title', relayCode:'XXXX' }, '*')
    window.addEventListener('message', e => {
      if (e.data && e.data.type === 'gameActivity' && _user) {
        db.collection('users').doc(_user.uid).update({
          'activity.page':      'games',
          'activity.game':      e.data.game      || '',
          'activity.relayCode': e.data.relayCode || '',
          'activity.updatedAt': firebase.firestore.FieldValue.serverTimestamp()
        }).catch(() => {});
      }
    });
  }

  async function _loadGames() {
    try {
      const snap = await db.collection('games').orderBy('title').get();
      const games = [];
      snap.forEach(doc => games.push({ id: doc.id, ...doc.data() }));

      const grid = document.getElementById('games-grid');
      grid.innerHTML = games.length
        ? games.map(_cardHtml).join('')
        : '<p style="color:var(--text-muted)">No games yet. Check back soon!</p>';

      grid.querySelectorAll('.game-card').forEach(card => {
        card.addEventListener('click', () => {
          const url = card.dataset.url;
          if (!url) { showToast('This game is not available yet.', 'info'); return; }
          _openPlayer(card.dataset.title, url);
        });
      });
    } catch (err) {
      console.error('Failed to load games:', err);
    }
  }

  function _cardHtml(g) {
    const sClass = g.status === 'released' ? 'badge-released'
      : g.status === 'early' ? 'badge-early' : 'badge-coming';
    const sText = g.status === 'released' ? 'Released'
      : g.status === 'early' ? 'Early Access' : 'Coming Soon';
    const gamepadSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="12" x2="10" y2="12"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="15" y1="13" x2="15.01" y2="13"/><line x1="18" y1="11" x2="18.01" y2="11"/><rect x="2" y="6" width="20" height="12" rx="2"/></svg>';
    const e = s => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
    return '<div class="game-card" data-url="' + e(g.url || '') + '" data-title="' + e(g.title) + '">' +
      '<div class="game-card-img">' + (g.image ? '<img src="' + e(g.image) + '" alt="">' : gamepadSvg) + '</div>' +
      '<div class="game-card-body"><h3>' + e(g.title) + '</h3>' +
      '<p>' + e(g.description || '') + '</p>' +
      '<span class="badge ' + sClass + '">' + sText + '</span></div></div>';
  }

  function _openPlayer(title, url) {
    document.getElementById('game-player-title').textContent = title;
    document.getElementById('game-iframe').src = url;
    document.getElementById('game-player').classList.add('active');
    if (_user) {
      db.collection('users').doc(_user.uid).update({
        'activity.page':      'games',
        'activity.game':      title,
        'activity.updatedAt': firebase.firestore.FieldValue.serverTimestamp()
      }).catch(() => {});
    }
  }

  function _closePlayer() {
    document.getElementById('game-player').classList.remove('active');
    document.getElementById('game-iframe').src = '';
    if (_user) {
      db.collection('users').doc(_user.uid).update({
        'activity.page':      'games',
        'activity.game':      '',
        'activity.relayCode': '',
        'activity.updatedAt': firebase.firestore.FieldValue.serverTimestamp()
      }).catch(() => {});
    }
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => {
  Nav.init('games').then(({ user }) => Games.init(user));
});
