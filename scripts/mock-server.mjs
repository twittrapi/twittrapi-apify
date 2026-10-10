// Local mock of the TwittrAPI HTTP API that serves the hand-written fixtures in test/fixtures.
// Used for local end-to-end runs (scripts/e2e.mjs). Never talks to the real API.
//
//   node scripts/mock-server.mjs [port]      (default 8787)
//
// Special cases: username "broke" -> 402, username "busy" -> 429 with Retry-After: 1 every time,
// any request without an X-API-KEY header -> 401.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const FIXTURES = new URL("../test/fixtures/", import.meta.url);
const fx = (name) => readFileSync(new URL(name, FIXTURES), "utf8");
const EMPTY = JSON.stringify({ data: { timeline: { instructions: [{ type: "TimelineAddEntries", entries: [] }] } } });

/** [pathRegex, cursor or null, fixture file] — first match wins. */
const ROUTES = [
  [/^\/search$/, null, "search_latest_page1.json"],
  [/^\/search$/, "SEARCH_PAGE_2", "search_latest_page2.json"],
  [/^\/search$/, "SEARCH_PAGE_3", "search_latest_page3.json"],
  [/^\/user\/[^/]+\/tweets$/, null, "user_tweets.json"],
  [/^\/user\/[^/]+\/(followers|followings)$/, null, "followers.json"],
  [/^\/user\/[^/]+\/(followers|followings)$/, "FOLLOWERS_PAGE_2", "followers_page2.json"],
  [/^\/user\/by\/username\/[^/]+$/, null, "user_profile.json"],
  [/^\/user\/users\/by\/ids$/, null, "users_by_ids.json"],
  [/^\/tweet\/\d+$/, null, "tweet_detail.json"],
  [/^\/tweet\/\d+\/retweets$/, null, "retweeters.json"],
  [/^\/lists\/tweets$/, null, "list_tweets.json"],
  [/^\/communities\/\d+\/tweets$/, null, "community_tweets.json"],
  [/^\/trends\/1$/, null, "trends_v1.json"],
  [/^\/trends\/\d+$/, null, "trends_graphql.json"],
];

export function startMockServer(port = 8787) {
  const log = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const cursor = url.searchParams.get("cursor");
    const send = (status, body, headers = {}) => {
      log.push(`${status} ${url.pathname}${url.search}`);
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(body);
    };
    if (!req.headers["x-api-key"]) return send(401, JSON.stringify({ error: "Missing API key" }));
    const username = url.searchParams.get("username") ?? url.pathname.split("/").pop();
    if (username === "broke") return send(402, JSON.stringify({ error: "Insufficient balance" }));
    if (username === "busy") return send(429, JSON.stringify({ error: "Too many requests" }), { "retry-after": "1" });

    const pathMatches = ROUTES.filter(([re]) => re.test(url.pathname));
    if (pathMatches.length === 0) return send(404, JSON.stringify({ error: "Not found" }));
    const hit = pathMatches.find(([, c]) => c === (cursor || null));
    // Unknown cursor on a known path: an empty last page.
    return send(200, hit ? fx(hit[2]) : EMPTY);
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port, log }));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port } = await startMockServer(Number(process.argv[2] ?? 8787));
  console.log(`Mock TwittrAPI listening on http://127.0.0.1:${port}`);
}
