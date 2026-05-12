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

  // Built-in games that always appear in the catalog (no Firestore needed)
  const BUILTIN_GAMES = [
    {
      id: '_builtin_sv3d',
      title: 'Space Vanguard 3D',
      description: 'Fly a 3D fighter through hostile space — dodge, shoot, upgrade, and topple waves of bosses.',
      status: 'early',
      url: 'space-vanguard-3d.html',
      mode: 'navigate'
    },
    {
      id: '_builtin_sv',
      title: 'Space Vanguard (Classic)',
      description: 'The original arcade-style shooter — collect Star Dust, upgrade your ship, and clear all six stages.',
      status: 'released',
      url: 'space-vanguard.html',
      mode: 'navigate'
    }
  ];

  async function _loadGames() {
    let remote = [];
    try {
      const snap = await db.collection('games').orderBy('title').get();
      snap.forEach(doc => remote.push({ id: doc.id, ...doc.data() }));
    } catch (err) {
      console.error('Failed to load games:', err);
    }
    // Merge: built-ins first, then remote (skip remote duplicates by id/title)
    const seen = new Set(BUILTIN_GAMES.map(g => g.title.toLowerCase()));
    const merged = BUILTIN_GAMES.concat(remote.filter(g => !seen.has(String(g.title || '').toLowerCase())));

    const grid = document.getElementById('games-grid');
    grid.innerHTML = merged.length
      ? merged.map(_cardHtml).join('')
      : '<p style="color:var(--text-muted)">No games yet. Check back soon!</p>';

    grid.querySelectorAll('.game-card').forEach(card => {
      card.addEventListener('click', () => {
        const url  = card.dataset.url;
        const mode = card.dataset.mode || 'iframe';
        if (!url) { showToast('This game is not available yet.', 'info'); return; }
        if (mode === 'navigate') {
          // Built-in games live on their own pages
          if (_user) {
            db.collection('users').doc(_user.uid).update({
              'activity.page':      'games',
              'activity.game':      card.dataset.title,
              'activity.updatedAt': firebase.firestore.FieldValue.serverTimestamp()
            }).catch(() => {});
          }
          window.location.href = url;
          return;
        }
        _openPlayer(card.dataset.title, url);
      });
    });
  }

  function _cardHtml(g) {
    const sClass = g.status === 'released' ? 'badge-released'
      : g.status === 'early' ? 'badge-early' : 'badge-coming';
    const sText = g.status === 'released' ? 'Released'
      : g.status === 'early' ? 'Early Access' : 'Coming Soon';
    const gamepadSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="12" x2="10" y2="12"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="15" y1="13" x2="15.01" y2="13"/><line x1="18" y1="11" x2="18.01" y2="11"/><rect x="2" y="6" width="20" height="12" rx="2"/></svg>';
    const e = s => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
    return '<div class="game-card" data-url="' + e(g.url || '') + '" data-title="' + e(g.title) + '" data-mode="' + e(g.mode || 'iframe') + '">' +
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
