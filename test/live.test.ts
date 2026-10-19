// Flatten and collect against trimmed real TwittrAPI responses (test/fixtures/live/*.json,
// captured 2026-10-10). Each fixture is { request, capturedAt, response }; `response` is the body.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TwittrAPI } from "twittrapi";
import { collect, type OutputItem, type Sink } from "../src/collect.js";
import { flattenTimeline, flattenTweet, flattenUsers, type TweetItem, type UserItem } from "../src/flatten.js";
import { parseInput, type RawInput } from "../src/input.js";
import { fakeFetch, fixture, type Route } from "./helpers.js";

const live = (name: string): any => structuredClone((fixture(`live/${name}.json`) as { response: unknown }).response);
const tweets = (data: unknown) => flattenTimeline(data).filter((i): i is TweetItem => i.type === "tweet");
const users = (data: unknown) => flattenTimeline(data).filter((i): i is UserItem => i.type === "user");

test("live: user tweets read core.screen_name authors and the pinned entry", () => {
  const [t] = tweets(live("user-userid-tweets"));
  assert.equal(t!.id, "2019881223666233717");
  assert.equal(t!.author?.username, "XDevelopers");
  assert.equal(t!.url, "https://x.com/XDevelopers/status/2019881223666233717");
  assert.equal(t!.created_at, "2026-02-06T21:09:45.000Z");
  assert.ok((t!.metrics.views ?? 0) > 0 && (t!.metrics.likes ?? 0) > 0);
  assert.equal(t!.is_retweet, false);
});

test("live: tweetsAndReplies, media, list, community, search and quotes yield tweets", () => {
  for (const name of [
    "user-userid-tweetsandreplies",
    "user-userid-media",
    "lists-tweets",
    "communities-communityid-tweets",
    "search",
    "tweet-tweetid-quotes",
  ]) {
    const list = tweets(live(name));
    assert.ok(list.length > 0, name);
    for (const t of list) assert.ok(t.id && t.author?.username && t.created_at, `${name}: ${t.id}`);
  }
  const [q] = tweets(live("tweet-tweetid-quotes"));
  assert.equal(q!.quoted_tweet?.id, "2019881223666233717");
  assert.equal(q!.is_quote, true);
});

test("live: follower lists read legacy.screen_name users", () => {
  for (const name of [
    "user-userid-followers",
    "user-userid-followings",
    "user-userid-verifiedfollowers",
    "lists-members",
    "tweet-tweetid-retweets",
  ]) {
    const list = users(live(name));
    assert.ok(list.length >= 2, name);
    for (const u of list) assert.ok(u.id && u.username && u.followers !== null && u.profile_image, `${name}: ${u.id}`);
  }
});

test("live: profiles and users-by-ids (core.screen_name, location.location, avatar)", () => {
  const [u] = flattenUsers(live("user-by-username-username"));
  assert.equal(u!.username, "XDevelopers");
  assert.equal(u!.created_at, "2013-12-14T04:35:55.000Z");
  assert.equal(u!.location, "127.0.0.1");
  assert.equal(u!.verified_type, "Business");
  assert.ok(u!.profile_image?.startsWith("https://pbs.twimg.com/"));
  assert.deepEqual(flattenUsers(live("user-userid")).map((x) => x.id), ["2244994945"]);
  const batch = live("user-users-by-ids");
  batch.data.users.push({}); // a missing user comes back as an empty object
  assert.deepEqual(flattenUsers(batch).map((x) => x.username), ["XDevelopers", "jack"]);
});

test("live: tweet detail returns the focal tweet and the reply", () => {
  const list = tweets(live("tweet-tweetid"));
  assert.deepEqual(list.map((t) => t.id), ["2019881223666233717", "2000000000000000001"]);
  assert.equal(list[1]!.in_reply_to_tweet_id, "2019881223666233717");
});

test("live: empty likes and favorites timelines flatten to nothing", () => {
  assert.deepEqual(flattenTimeline(live("user-userid-likes")), []);
  assert.deepEqual(flattenTimeline(live("tweet-tweetid-favorites")), []);
  assert.deepEqual(flattenUsers(live("user-userid-likes")), []);
});

test("live: articles skip an entry with empty tweet_results", () => {
  const data = live("user-userid-articles");
  data.data.user.result.timeline.timeline.instructions[0].entries.unshift({
    entryId: "tweet-1",
    content: { entryType: "TimelineTimelineItem", itemContent: { itemType: "TimelineTweet", tweet_results: {} } },
  });
  assert.deepEqual(tweets(data).map((t) => t.id), ["2041295840325636551"]);
});

test("live: TweetWithVisibilityResults and retweets built from a real tweet", () => {
  const original = live("user-userid-tweets").data.user.result.timeline.timeline.instructions[1].entry.content.itemContent
    .tweet_results.result;
  const wrapped = { result: { __typename: "TweetWithVisibilityResults", tweet: original } };
  assert.equal(flattenTweet(wrapped)?.id, original.rest_id);

  const retweeter = live("user-userid-followers").data.user.result.timeline.timeline.instructions.find(
    (i: any) => i.entries,
  ).entries[0].content.itemContent.user_results;
  const retweet = {
    result: {
      __typename: "Tweet",
      rest_id: "2100000000000000001",
      core: { user_results: retweeter },
      legacy: {
        created_at: "Fri Oct 09 10:00:00 +0000 2026",
        full_text: "RT @XDevelopers: Officially launching X API Pay-Per-Use",
        favorite_count: 0,
        retweet_count: 896,
        retweeted_status_result: wrapped,
      },
    },
  };
  const t = flattenTweet(retweet)!;
  assert.equal(t.is_retweet, true);
  assert.equal(t.author?.username, "example_user_1");
  assert.equal(t.retweeted_tweet?.id, "2019881223666233717");
  assert.equal(t.retweeted_tweet?.author?.username, "XDevelopers");
});

function setup(routes: Record<string, Route>, raw: RawInput) {
  const { fetch, calls } = fakeFetch(routes);
  const client = new TwittrAPI({ apiKey: "test-key", baseUrl: "http://mock.local", fetch, maxRetries: 1, retryDelayMs: 0 });
  const items: OutputItem[] = [];
  const sink: Sink = { push: async (item) => (items.push(item), true) };
  const run = () => collect(client, parseInput(raw), sink, { log: { info: () => {}, warning: () => {} } });
  return { run, items, calls };
}

const cursorOnly = (bottom: string) => ({
  data: {
    user: {
      result: {
        timeline: {
          timeline: {
            instructions: [
              {
                type: "TimelineAddEntries",
                entries: [
                  { entryId: "cursor-bottom-1", content: { cursorType: "Bottom", value: bottom } },
                  { entryId: "cursor-top-1", content: { cursorType: "Top", value: "-1|1" } },
                ],
              },
            ],
          },
        },
      },
    },
  },
});

test("live collect: followers follow the Bottom cursor (listed before Top) and stop on a cursor-only page", async () => {
  const page1 = live("user-userid-followers");
  const next = page1.data.user.result.timeline.timeline.instructions
    .find((i: any) => i.entries)
    .entries.find((e: any) => e.content.cursorType === "Bottom").content.value as string;
  const s = setup(
    {
      "/user/2244994945/followers": { body: page1 },
      [`/user/2244994945/followers?cursor=${next}`]: { body: cursorOnly("1000000000000000000|1") },
    },
    { mode: "followers", userIds: ["2244994945"], maxPages: 5 },
  );
  const summary = await s.run();
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[0]!.searchParams.get("username"), null);
  assert.equal(s.calls[1]!.searchParams.get("cursor"), next);
  assert.deepEqual(s.items.map((i) => (i as UserItem).username), ["example_user_1", "example_user_2"]);
  assert.equal(summary.targets[0]!.pages, 2);
});

test("live collect: search wrapper, tweet replies and retweeters", async () => {
  const s = setup({ "/search": { body: live("search") } }, { searchQueries: ["openai"], maxPages: 1 });
  await s.run();
  assert.deepEqual(s.items.map((i) => (i as TweetItem).id), ["2000000000000000001"]);

  const r = setup({ "/tweet/2019881223666233717": { body: live("tweet-tweetid") } }, {
    mode: "tweetReplies",
    tweetIds: ["https://x.com/XDevelopers/status/2019881223666233717"],
    maxPages: 1,
  });
  await r.run();
  assert.deepEqual(r.items.map((i) => (i as TweetItem).id), ["2000000000000000001"]);

  const rt = setup({ "/tweet/2019881223666233717/retweets": { body: live("tweet-tweetid-retweets") } }, {
    mode: "tweetRetweeters",
    tweetIds: ["2019881223666233717"],
    maxPages: 1,
  });
  await rt.run();
  assert.equal(rt.items.length, 2);
  assert.ok(rt.items.every((i) => i.type === "user"));
});

test("live collect: user tweets by username go to /user/-1 with the handle and a 1..100 count", async () => {
  const s = setup({ "/user/-1/tweets": { body: live("user-userid-tweets") } }, {
    mode: "userTweets",
    usernames: ["@XDevelopers"],
    maxItems: 500,
    maxPages: 1,
  });
  await s.run();
  assert.equal(s.calls[0]!.searchParams.get("username"), "XDevelopers");
  assert.equal(s.calls[0]!.searchParams.get("count"), "100");
  assert.deepEqual(s.items.map((i) => i.type), ["tweet"]);
});

test("live: community members come from members_slice.items_results", () => {
  const list = flattenTimeline(live("communities-communityid-members"));
  assert.deepEqual(list.map((u) => [u.type, u.id]), [
    ["user", "1000000000000000001"],
    ["user", "1000000000000000002"],
  ]);
  const [admin] = list as UserItem[];
  assert.equal(admin!.username, "example_user_1");
  assert.equal(admin!.verified, true);
  assert.ok(admin!.profile_image?.startsWith("https://pbs.twimg.com/"));
});

test("live collect: quotes, verified followers, list members and community members", async () => {
  const q = setup({ "/tweet/2019881223666233717/quotes": { body: live("tweet-tweetid-quotes") } }, {
    mode: "tweetQuotes",
    tweetIds: ["https://x.com/XDevelopers/status/2019881223666233717"],
    maxPages: 1,
  });
  await q.run();
  assert.ok(q.items.length > 0);
  assert.ok(q.items.every((i) => i.type === "tweet" && (i as TweetItem).quoted_tweet?.id === "2019881223666233717"));

  const v = setup({ "/user/-1/verifiedFollowers": { body: live("user-userid-verifiedfollowers") } }, {
    mode: "verifiedFollowers",
    usernames: ["XDevelopers"],
    maxPages: 1,
  });
  await v.run();
  assert.equal(v.calls[0]!.searchParams.get("username"), "XDevelopers");
  assert.deepEqual(v.items.map((i) => (i as UserItem).username), ["example_user_1", "example_user_2"]);

  const l = setup({ "/lists/members": { body: live("lists-members") } }, { mode: "listMembers", listIds: ["https://x.com/i/lists/84839422"], maxPages: 1 });
  await l.run();
  assert.equal(l.calls[0]!.searchParams.get("listId"), "84839422");
  assert.ok(l.items.length >= 2 && l.items.every((i) => i.type === "user"));

  const page1 = live("communities-communityid-members");
  const next = page1.data.communityResults.result.members_slice.slice_info.next_cursor as string;
  const lastPage = { data: { communityResults: { result: { __typename: "Community", members_slice: { items_results: [], slice_info: {} } } } } };
  const c = setup(
    {
      "/communities/1762494276565426592/members": { body: page1 },
      [`/communities/1762494276565426592/members?cursor=${next}`]: { body: lastPage },
    },
    { mode: "communityMembers", communityIds: ["https://x.com/i/communities/1762494276565426592"] },
  );
  const summary = await c.run();
  assert.equal(c.calls.length, 2, "follows slice_info.next_cursor, then stops");
  assert.equal(c.calls[1]!.searchParams.get("cursor"), next);
  assert.deepEqual(c.items.map((i) => (i as UserItem).username), ["example_user_1", "example_user_2"]);
  assert.ok(c.items.every((i) => i.mode === "communityMembers" && i.input === "1762494276565426592"));
  assert.equal(summary.targets[0]!.items, 2);
});
