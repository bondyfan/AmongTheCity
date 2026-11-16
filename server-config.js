// ==========================================================================
// Among The City: co-op server (client configuration).
//
// Point this at the server's origin (no trailing path). The main menu polls
// <SERVER_URL>/health and only enables the "Multiplayer (server)" button while
// that answers { ready: true }; the game transport (js/netcity.js) then
// connects to  <SERVER_URL as ws(s)>/ws  and everyone lands in the ONE shared
// Pardubice room.
//
// The live server is a Cloudflare Worker with one Durable Object
// (server-city/worker/, see server-city/README.md):
//   export const SERVER_URL = 'https://among-the-city-coop.digifycz.workers.dev';
// It must be https:// on the deployed site: the page is served over HTTPS and
// browsers block plaintext ws:// / http:// from a secure page (http://localhost
// is the one exception they allow).
//
// Local play-testing, one of:
//   'http://localhost:8787'  the Worker under `wrangler dev --local` (server-city/worker)
//   'http://localhost:8081'  the Node relay, `npm start` in server-city/
// A localhost URL is correct ONLY while you run that server yourself. Shipping
// one is what once made the deployed menu read "server nedostupný" for
// everyone: every visitor's browser went looking for a relay on their own
// machine, and of course found none.
//
// Leave it EMPTY ('') to hide server play entirely.
// ==========================================================================

export const SERVER_URL = 'https://among-the-city-coop.digifycz.workers.dev';
