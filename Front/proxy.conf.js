const BACKEND = 'http://localhost:3000';
const base = { target: BACKEND, secure: false, changeOrigin: true };

// For /invite: proxy API calls (XHR) but serve Angular SPA for browser navigation
function inviteBypass(req) {
  const accept = req.headers['accept'] ?? '';
  if (accept.includes('text/html')) {
    return '/index.html';
  }
}

module.exports = {
  '/auth':         { ...base },
  '/org':          { ...base },
  '/me':           { ...base },
  '/user':         { ...base },
  '/work-session': { ...base },
  '/notifications':{ ...base },
  '/stars':        { ...base },
  '/chat':         { ...base },
  '/tasks':        { ...base },
  '/invite':       { ...base, bypass: inviteBypass },
  '/sprints':      { ...base },
  '/dashboards':   { ...base },
  '/teams':        { ...base },
  '/meetings':     { ...base },
  '/ai':           { ...base },
  '/socket.io':    { ...base, ws: true },
};
