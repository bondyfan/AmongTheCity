// ==========================================================================
// Worker tests: `npm run test:worker` inside server-city/ (about a minute).
//
// Spawns `wrangler dev --local` (no login, no deploy, nothing leaves this
// machine) on free ports with test vars, then runs the Node relay's
// scenarios against the Durable Object plus what only the Durable Object
// has: waking from hibernation, the budget guard, reaping by alarm, the
// /health isolate cache, a restart. The budget arithmetic and the account
// guard are pure and are tested directly. Every wrangler is killed at the end.
// ==========================================================================

import './test/pure.js';
import './test/relay.js';
import './test/guard.js';
import './test/cost.js';
