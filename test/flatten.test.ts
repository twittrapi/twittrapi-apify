import assert from "node:assert/strict";
import { test } from "node:test";
import { flattenTimeline, flattenTrends, flattenTweet, flattenUser, flattenUsers, toIsoDate, type TweetItem, type UserItem } from "../src/flatten.js";
import { fixture } from "./helpers.js";

const tweets = (data: unknown, raw = false) => flattenTimeline(data, { includeRaw: raw }).filter((i): i is TweetItem => i.type === "tweet");
const users = (data: unknown) => flattenTimeline(data).filter((i): i is UserItem => i.type === "user");

test("toIsoDate converts X dates and keeps unknown strings", () => {
  assert.equal(toIsoDate("Wed Oct 09 14:03:11 +0000 2024"), "2024-10-09T14:03:11.000Z");
  assert.equal(toIsoDate("Wed Oct 09 14:03:11 +0200 2024"), "2024-10-09T12:03:11.000Z");
  assert.equal(toIsoDate("2024-10-09T14:03:11Z"), "2024-10-09T14:03:11.000Z");
  assert.equal(toIsoDate("not a date"), "not a date");
  assert.equal(toIsoDate(undefined), null);
});

test("search page: tweets, visibility wrapper, video, skips promoted/tombstone/broken", () => {
  const items = tweets(fixture("search_latest_page1.json"));
  assert.deepEqual(items.map((t) => t.id), ["1844000000000000001", "1844000000000000002"]);

  const [a, b] = items as [TweetItem, TweetItem];
  assert.equal(a.url, "https://x.com/ada_example/status/1844000000000000001");
  assert.equal(a.created_at, "2024-10-09T14:03:11.000Z");
  assert.equal(a.lang, "en");
  assert.deepEqual(a.author, { id: "12345", username: "ada_example", name: "Ada Example", followers: 52000, verified: true });
  assert.deepEqual(a.metrics, { likes: 420, retweets: 61, replies: 18, quotes: 7, views: 15234, bookmarks: 95 });
  assert.deepEqual(a.media, [{ type: "photo", url: "https://pbs.twimg.com/media/PHOTO1.jpg", video_url: null }]);
  assert.equal(a.is_reply, false);
  assert.equal(a.is_quote, false);
  assert.equal(a.is_retweet, false);
  assert.equal(a.conversation_id, "1844000000000000001");
  assert.equal(a.raw, undefined);

  // TweetWithVisibilityResults + legacy (old) user shape + reply + video
  assert.equal(b.author?.username, "oldshape");
  assert.equal(b.author?.verified, false);
  assert.equal(b.is_reply, true);
  assert.equal(b.in_reply_to_tweet_id, "1843999999999999000");
  assert.equal(b.in_reply_to_username, "ada_example");
  assert.equal(b.metrics.views, null);
  assert.equal(b.media[0]?.type, "video");
  assert.equal(b.media[0]?.video_url, "https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/high.mp4");
});

test("includeRaw keeps the raw tweet object as the last field", () => {
  const [a] = tweets(fixture("search_latest_page1.json"), true);
  assert.ok(a?.raw && typeof a.raw === "object");
  assert.equal((a.raw as { rest_id: string }).rest_id, "1844000000000000001");
  assert.equal(Object.keys(a).at(-1), "raw");
});

test("retweet: flags and nested original tweet", () => {
  const items = tweets(fixture("search_latest_page2.json"));
  const rt = items.find((t) => t.id === "1843990000000000005");
  assert.ok(rt);
  assert.equal(rt.is_retweet, true);
  assert.equal(rt.retweeted_tweet?.id, "1843980000000000000");
  assert.equal(rt.retweeted_tweet?.author?.username, "dbnews");
  assert.equal(rt.retweeted_tweet?.text, "Postgres 17 released today");
  assert.equal(rt.retweeted_tweet?.metrics.views, 90000);
});

test("user timeline: pinned entry, long note text, quote, conversation module, suggestions are users", () => {
  const all = flattenTimeline(fixture("user_tweets.json"));
  const ts = all.filter((i): i is TweetItem => i.type === "tweet");
  assert.deepEqual(ts.map((t) => t.id), [
    "1800000000000000001",
    "1844100000000000001",
    "1844050000000000001",
    "1844050000000000002",
  ]);
  assert.ok(ts[0]!.text.endsWith("End."), "prefers note_tweet over truncated full_text");
  const q = ts[1]!;
  assert.equal(q.is_quote, true);
  assert.equal(q.quoted_tweet?.id, "1844000000000000777");
  assert.equal(q.quoted_tweet?.author?.username, "dbnews");
  assert.equal(ts[3]!.is_reply, true);
  // the who-to-follow module yields a user; the collector drops it because userTweets expects tweets
  assert.deepEqual(all.filter((i) => i.type === "user").map((u) => u.id), ["5"]);
});

test("followers: both user shapes, skips unavailable and empty results", () => {
  const us = users(fixture("followers.json"));
  assert.deepEqual(us.map((u) => u.id), ["2001", "2002"]);
  const [one, two] = us as [UserItem, UserItem];
  assert.deepEqual(
    { username: one.username, name: one.name, bio: one.bio, location: one.location, website: one.website, followers: one.followers, following: one.following, tweets: one.tweets, created_at: one.created_at, verified: one.verified, profile_image: one.profile_image, url: one.url, protected: one.protected },
    { username: "follower_one", name: "Follower One", bio: "Coffee and code", location: null, website: "https://follower.example", followers: 150, following: 300, tweets: 1000, created_at: "2020-02-14T12:00:00.000Z", verified: false, profile_image: "https://pbs.twimg.com/profile_images/3/f1_normal.jpg", url: "https://x.com/follower_one", protected: false },
  );
  assert.equal(two.username, "follower_two");
  assert.equal(two.verified, true);
  assert.equal(two.verified_type, "Business");
  assert.equal(two.protected, true);
  assert.equal(two.bio, null);
  assert.equal(two.profile_banner, "https://pbs.twimg.com/profile_banners/2002/1");
});

test("tweet detail: focal tweet and replies inside conversation modules, cursors ignored", () => {
  const ts = tweets(fixture("tweet_detail.json"));
  assert.deepEqual(ts.map((t) => t.id), ["1844000000000000001", "1844000000000000011", "1844000000000000012", "1844000000000000013"]);
  assert.ok(ts.slice(1).every((t) => t.conversation_id === "1844000000000000001"));
});

test("retweeters, list and community timelines", () => {
  assert.deepEqual(users(fixture("retweeters.json")).map((u) => u.username), ["follower_one", "replier_a"]);
  assert.deepEqual(tweets(fixture("list_tweets.json")).map((t) => t.text), ["List timeline tweet"]);
  const [c] = tweets(fixture("community_tweets.json"));
  assert.equal(c?.lang, "de");
  assert.equal(c?.author?.username, "follower_one");
});

test("single profile (new shape) and batch profiles", () => {
  const [u] = flattenUsers(fixture("user_profile.json"));
  assert.ok(u);
  assert.equal(u.id, "12345");
  assert.equal(u.username, "ada_example");
  assert.equal(u.location, "London");
  assert.equal(u.website, "https://ada.example");
  assert.equal(u.followers, 52000);
  assert.equal(u.following, 310);
  assert.equal(u.tweets, 8800);
  assert.equal(u.likes, 1200);
  assert.equal(u.media_count, 40);
  assert.equal(u.created_at, "2006-03-21T20:50:14.000Z");
  assert.equal(u.verified, true);
  assert.equal(u.profile_image, "https://pbs.twimg.com/profile_images/1/ada_normal.jpg");

  assert.deepEqual(flattenUsers(fixture("users_by_ids.json")).map((x) => x.id), ["2001", "2002"]);
});

test("trends: v1.1 array shape and GraphQL TimelineTrend", () => {
  const v1 = flattenTrends(fixture("trends_v1.json"));
  assert.deepEqual(v1.map((t) => [t.name, t.query, t.tweet_volume, t.rank]), [
    ["#Postgres17", "#Postgres17", 15400, 1],
    ["Ada Lovelace Day", '"Ada Lovelace Day"', null, 2],
  ]);
  assert.equal(v1[0]!.url, "http://twitter.com/search?q=%23Postgres17");

  const gql = flattenTrends(fixture("trends_graphql.json"));
  assert.deepEqual(gql.map((t) => [t.name, t.query, t.rank, t.context]), [
    ["Champions League", '"Champions League"', 1, "Sports · Trending"],
    ["Rust", "Rust", 2, "Technology · Trending"],
  ]);
  assert.equal(gql[1]!.url, "https://x.com/search?q=Rust");
});

test("never throws on garbage", () => {
  const junk: unknown[] = [null, undefined, 0, "x", [], {}, { data: null }, [[[]]], { entryId: "tweet-1" }, { entryId: 5, content: {} },
    { data: { user: { result: { __typename: "User", rest_id: "1", legacy: null, core: 7 } } } },
    { trends: [null, 1, { name: "" }, { name: "ok", url: "::::" }] }];
  for (const j of junk) {
    assert.doesNotThrow(() => flattenTimeline(j));
    assert.doesNotThrow(() => flattenUsers(j));
    assert.doesNotThrow(() => flattenTrends(j));
    assert.equal(flattenTweet(j), undefined);
  }
  assert.equal(flattenUser({ __typename: "User", rest_id: "1", legacy: null, core: 7 })?.id, "1");
  const cyclic: Record<string, unknown> = { entries: [] };
  cyclic.self = { inner: { a: 1 } };
  assert.deepEqual(flattenTimeline(cyclic), []);
});
