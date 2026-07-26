// ==========================================================================
// Among The City — dedicated co-op server (client configuration).
//
// Point this at the server's origin (no trailing path). The main menu polls
// <SERVER_URL>/health and only enables the "Multiplayer (server)" button while
// that answers { ready: true }; the game transport (js/netcity.js) then
// connects to  <SERVER_URL→ws(s)>/ws  and everyone lands in the ONE shared
// Pardubice room.
//
// Local play-testing (run server-city/ on this machine, see its README):
//   export const SERVER_URL = 'http://localhost:8081';
// A deployed box (must be https:// — the site is served over HTTPS and
// browsers block plaintext ws:// / http:// from a secure page; http://localhost
// is the one exception browsers allow):
//   export const SERVER_URL = 'https://city.example.com';
// Leave it EMPTY ('') to hide server play entirely.
// ==========================================================================

// The live box, shared with Among The Woods (which sits on :8080 under
// woods.*). sslip.io resolves <anything>.91-99-52-127.sslip.io to 91.99.52.127
// with no DNS to own, and Caddy terminates TLS and proxies /ws to :8081.
// NOTE: 'http://localhost:8081' above is correct ONLY while you run
// server-city/ yourself. Shipping it is what made the deployed menu read
// "server nedostupný" for everyone — every visitor's browser dutifully went
// looking for a relay on their own machine, and of course found none.
export const SERVER_URL = 'https://city.91-99-52-127.sslip.io';
