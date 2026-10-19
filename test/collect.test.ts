import assert from "node:assert/strict";
import { test } from "node:test";
import { TwittrAPI } from "twittrapi";
import { collect, type OutputItem, type Sink } from "../src/collect.js";
import { parseInput, type RawInput } from "../src/input.js";
import { fakeFetch, fixture, type Route } from "./helpers.js";

const id = (i: OutputItem) => ("id" in i ? i.id : i.name);

function setup(routes: Record<string, Route | ((url: URL) => Route)>, raw: RawInput, limit = Infinity) {
  const { fetch, calls } = fakeFetch(routes);
  const client = new TwittrAPI({ apiKey: "test-key", baseUrl: "http://mock.local", fetch, maxRetries: 1, retryDelayMs: 0 });
  const items: OutputItem[] = [];
  const warnings: string[] = [];
  const sink: Sink = {
    async push(item) {
      items.push(item);
      return items.length < limit;
    },
  };
  const run = () => collect(client, parseInput(raw), sink, { log: { info: () => {}, warning: (m) => warnings.push(m) } });
  return { run, items, calls, warnings };
}

const searchRoutes = {
  "/search": { body: fixture("search_latest_page1.json") },
  "/search?cursor=SEARCH_PAGE_2": { body: fixture("search_latest_page2.json") },
  "/search?cursor=SEARCH_PAGE_3": { body: fixture("search_latest_page3.json") },
};

test("search follows the bottom cursor, dedupes and stops on an empty page", async () => {
  const s = setup(searchRoutes, { searchQueries: ["postgres"], searchCategory: "Latest" });
  const summary = await s.run();
  assert.deepEqual(s.items.map(id), ["1844000000000000001", "1844000000000000002", "1843990000000000005"]);
  assert.ok(s.items.every((i) => i.input === "postgres" && i.mode === "searchTweets"));
  assert.equal(s.calls.length, 3);
  assert.equal(s.calls[0]!.searchParams.get("searchItem"), "postgres");
  assert.equal(s.calls[0]!.searchParams.get("category"), "Latest");
  assert.equal(summary.items, 3);
  assert.equal(summary.stopped, undefined);
});

test("maxItems stops early without fetching more pages", async () => {
  const s = setup(searchRoutes, { searchQueries: ["postgres"], maxItems: 2 });
  await s.run();
  assert.equal(s.items.length, 2);
  assert.equal(s.calls.length, 1);
});

test("maxPages caps the number of requests", async () => {
  const s = setup(searchRoutes, { searchQueries: ["postgres"], maxPages: 1 });
  await s.run();
  assert.equal(s.calls.length, 1);
});

test("userTweets drops non-tweet entries; username goes through /user/-1", async () => {
  const s = setup({ "/user/-1/tweets": { body: fixture("user_tweets.json") } }, { mode: "userTweets", usernames: ["@ada_example"] });
  await s.run();
  assert.ok(s.items.every((i) => i.type === "tweet"));
  assert.equal(s.items.length, 4);
  assert.equal(s.calls[0]!.searchParams.get("username"), "ada_example");
});

test("tweetReplies excludes the tweet itself", async () => {
  const s = setup({ "/tweet/1844000000000000001": { body: fixture("tweet_detail.json") } }, { mode: "tweetReplies", tweetIds: ["https://x.com/ada_example/status/1844000000000000001"] });
  await s.run();
  assert.deepEqual(s.items.map(id), ["1844000000000000011", "1844000000000000012", "1844000000000000013"]);
});

test("followers paginate across pages; a 404 target is skipped and the run continues", async () => {
  const s = setup(
    {
      "/user/42/followers": { body: fixture("followers.json") },
      "/user/42/followers?cursor=FOLLOWERS_PAGE_2": { body: fixture("followers_page2.json") },
      "/user/-1/followers": { status: 404, body: { error: "User not found" } },
    },
    { mode: "followers", userIds: ["42"], usernames: ["ghost"] },
  );
  const summary = await s.run();
  assert.deepEqual(s.items.map((i) => (i.type === "user" ? i.username : "")), ["follower_one", "follower_two", "follower_five"]);
  assert.equal(summary.targets.find((t) => t.target === "@ghost")?.error, "404 User not found");
  assert.equal(s.warnings.length, 1);
});

test("userProfiles: usernames one by one, IDs in batches", async () => {
  const s = setup(
    {
      "/user/by/username/ada_example": { body: fixture("user_profile.json") },
      "/user/users/by/ids": { body: fixture("users_by_ids.json") },
    },
    { mode: "userProfiles", usernames: ["ada_example"], userIds: ["2001", "2002", "2003"] },
  );
  await s.run();
  assert.deepEqual(s.items.map(id), ["12345", "2001", "2002"]);
  assert.equal(s.calls[1]!.searchParams.get("ids"), "2001,2002,2003");
  assert.match(s.warnings[0] ?? "", /2003/);
});

test("tweetThread: one request, the author's tweets in reading order, capped by maxItems", async () => {
  const s = setup({ "/tweet/1844000000000000102/thread": { body: fixture("tweet_thread.json") } }, { mode: "tweetThread", tweetIds: ["https://x.com/ada_example/status/1844000000000000102"] });
  const summary = await s.run();
  assert.deepEqual(s.items.map(id), ["1844000000000000101", "1844000000000000102", "1844000000000000103"]);
  assert.ok(s.items.every((i) => i.type === "tweet" && i.input === "1844000000000000102" && i.mode === "tweetThread"));
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0]!.searchParams.get("cursor"), null);
  assert.deepEqual(summary.targets, [{ target: "1844000000000000102", items: 3, pages: 1 }]);

  const capped = setup({ "/tweet/1844000000000000102/thread": { body: fixture("tweet_thread.json") } }, { mode: "tweetThread", tweetIds: ["1844000000000000102"], maxItems: 2 });
  await capped.run();
  assert.deepEqual(capped.items.map(id), ["1844000000000000101", "1844000000000000102"]);
});

test("userAffiliates: a username goes through /user/-1/affiliates and follows the cursor", async () => {
  const s = setup(
    {
      "/user/-1/affiliates": { body: fixture("affiliates.json") },
      "/user/-1/affiliates?cursor=AFFILIATES_PAGE_2": { body: fixture("followers_page2.json") },
      "/user/783214/affiliates": { body: fixture("affiliates.json") },
    },
    { mode: "userAffiliates", usernames: ["@ExampleOrg"], userIds: ["783214"], maxPages: 1 },
  );
  await s.run();
  assert.equal(s.calls[0]!.searchParams.get("username"), "ExampleOrg");
  assert.equal(s.calls[0]!.searchParams.get("count"), "100");
  assert.equal(s.calls[1]!.searchParams.get("username"), null);
  assert.deepEqual(s.items.map((i) => [i.type === "user" ? i.username : "", i.input]), [
    ["example_support", "@ExampleOrg"],
    ["example_engineering", "@ExampleOrg"],
    ["example_support", "783214"],
    ["example_engineering", "783214"],
  ]);

  const paged = setup(
    {
      "/user/-1/affiliates": { body: fixture("affiliates.json") },
      "/user/-1/affiliates?cursor=AFFILIATES_PAGE_2": { body: fixture("followers_page2.json") },
    },
    { mode: "userAffiliates", usernames: ["ExampleOrg"] },
  );
  await paged.run();
  assert.equal(paged.calls.length, 2, "stops on the 0| bottom cursor");
  assert.deepEqual(paged.items.map(id), ["4001", "4002", "2005"]);
});

test("trends respect maxItems per location", async () => {
  const s = setup({ "/trends/1": { body: fixture("trends_v1.json") }, "/trends/23424977": { body: fixture("trends_graphql.json") } }, { mode: "trends", woeids: ["1", "23424977"], maxItems: 1 });
  await s.run();
  assert.deepEqual(s.items.map((i) => [i.type === "trend" ? i.name : "", i.input]), [["#Postgres17", "1"], ["Champions League", "23424977"]]);
});

test("402 stops the whole run and keeps earlier items", async () => {
  const s = setup(
    {
      "/lists/tweets": (url) => (url.searchParams.get("listId") === "1" ? { body: fixture("list_tweets.json") } : { status: 402, body: { error: "Insufficient balance" } }),
    },
    { mode: "listTweets", listIds: ["1", "2", "3"], maxPages: 1 },
  );
  const summary = await s.run();
  assert.equal(s.items.length, 1);
  assert.equal(summary.stopped?.reason, "balance");
  assert.equal(s.calls.length, 2, "list 3 is never requested");
});

test("429 is retried with Retry-After, then stops the run", async () => {
  let n = 0;
  const s = setup(
    { "/communities/9/tweets": () => (n++ === 0 ? { status: 429, headers: { "retry-after": "0" }, body: {} } : { body: fixture("community_tweets.json") }) },
    { mode: "communityTweets", communityIds: ["9"], maxPages: 1 },
  );
  await s.run();
  assert.equal(s.items.length, 1, "retried once after 429");

  const t = setup({ "/communities/9/tweets": { status: 429, headers: { "retry-after": "0" }, body: { error: "Too many requests" } } }, { mode: "communityTweets", communityIds: ["9"] });
  const summary = await t.run();
  assert.equal(summary.stopped?.reason, "rate_limit");
  assert.equal(t.calls.length, 2, "1 try + 1 retry");
});

test("401 stops the run as a configuration problem", async () => {
  const s = setup({ "/tweet/5/retweets": { status: 401, body: {} } }, { mode: "tweetRetweeters", tweetIds: ["5"] });
  const summary = await s.run();
  assert.equal(summary.stopped?.reason, "auth");
});

test("sink returning false (spending limit) stops the run", async () => {
  const s = setup({ "/tweet/5/retweets": { body: fixture("retweeters.json") } }, { mode: "tweetRetweeters", tweetIds: ["5"] }, 1);
  const summary = await s.run();
  assert.equal(s.items.length, 1);
  assert.equal(summary.stopped?.reason, "charge_limit");
});



test("a server error after the first page keeps the partial result", async () => {
  const s = setup(
    { "/lists/tweets": (url) => (url.searchParams.get("cursor") ? { status: 500, body: { error: "upstream" } } : { body: fixture("list_tweets.json") }) },
    { mode: "listTweets", listIds: ["1"] },
  );
  const summary = await s.run();
  assert.equal(s.items.length, 1);
  assert.deepEqual(summary.targets, [{ target: "1", items: 1, pages: 1 }]);
  assert.match(s.warnings[0] ?? "", /stopped after 1 page/);
});
