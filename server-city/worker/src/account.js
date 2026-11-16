// ==========================================================================
// Optional account-wide guard: what EVERY Durable Object on the account has
// used this cycle (Chat Motor, Death Run, this one), from the GraphQL
// Analytics API. Runs only when the secret CF_ANALYTICS_TOKEN exists (an API
// token with Account Analytics Read); without it nothing here is ever called.
// Pure apart from the `fetch` it is handed, so test.js stubs it in Node.
// ==========================================================================

import { GB_PER_OBJECT, MSGS_PER_REQUEST } from './budget.js';

export const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';

export const ACCOUNT_QUERY = `query CoopBudget($acc: string!, $start: Date!, $end: Date!) {
  viewer {
    accounts(filter: { accountTag: $acc }) {
      periodic: durableObjectsPeriodicGroups(limit: 10000, filter: { date_geq: $start, date_leq: $end }) {
        sum { activeTime inboundWebsocketMsgCount }
      }
      invocations: durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: { date_geq: $start, date_leq: $end }) {
        sum { requests }
      }
    }
  }
}`;

const sumOf = (groups, key) => (Array.isArray(groups) ? groups : [])
  .reduce((n, g) => n + (Number(g?.sum?.[key]) || 0), 0);

// The account's cycle-to-date usage: { gbs, requests }. Throws on any failure
// (HTTP, GraphQL errors, an answer without the account, a timeout) so the
// caller can tell "measured low" from "could not measure".
//
// Requests, as Cloudflare documents its datasets: `invocations.requests`
// counts every fetch, RPC call, alarm and closed WebSocket connection, AND
// every inbound message on a HIBERNATED WebSocket, one for one. Messages on
// a socket accepted the old way (accept()) are only in
// `periodic.inboundWebsocketMsgCount`. Billing counts every inbound message
// as 1/20 of a request (the 20:1 ratio is not applied to the analytics).
// The datasets have no documented dimension that tells a hibernated message
// from a fetch, so:
//   - this object's OWN inbound messages (ownMsgs, counted by its meter, all
//     hibernated) are taken out of the invocations and put back at 1/20.
//     Without that the guard counts co-op's own play 20 times over and
//     closes co-op for the month after a couple of hours of a full room.
//   - other Workers' hibernated messages (Chat Motor) stay counted one for
//     one. That errs toward closing co-op early, never toward overage.
export async function accountUsage({ fetch, url = GRAPHQL_URL, token, accountId, start, end,
  ownMsgs = 0, timeoutMs = 10000 }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: ACCOUNT_QUERY, variables: { acc: accountId, start, end } }),
    // a request that never answers must become an ordinary error
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`analytics HTTP ${res.status}`);
  const j = await res.json();
  if (j?.errors?.length) throw new Error(`analytics: ${String(j.errors[0]?.message || 'error').slice(0, 120)}`);
  const acc = j?.data?.viewer?.accounts?.[0];
  if (!acc) throw new Error('analytics: no such account');
  if (!Array.isArray(acc.periodic) || !Array.isArray(acc.invocations)) throw new Error('analytics: unexpected answer');
  // activeTime is in microseconds; every object is billed as 128 MB.
  const gbs = (sumOf(acc.periodic, 'activeTime') / 1e6) * GB_PER_OBJECT;
  const inv = sumOf(acc.invocations, 'requests');
  const own = Math.min(Math.max(0, Number(ownMsgs) || 0), inv);
  const requests = (inv - own)
    + (own + sumOf(acc.periodic, 'inboundWebsocketMsgCount')) / MSGS_PER_REQUEST;
  return { gbs: Math.round(gbs * 10) / 10, requests: Math.round(requests) };
}

export function accountOver(usage, limits) {
  if (!usage) return false;
  return (limits.gbs > 0 && usage.gbs >= limits.gbs) || (limits.requests > 0 && usage.requests >= limits.requests);
}

// The UTC dates the query covers: from the cycle's first day to today.
export function queryDates(cycle, now) {
  return { start: cycle.id, end: new Date(now).toISOString().slice(0, 10) };
}
