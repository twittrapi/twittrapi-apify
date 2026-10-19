import assert from "node:assert/strict";
import { test } from "node:test";
import { InputError, parseIdFromUrl, parseInput, parseTweetId, parseUsername } from "../src/input.js";

test("parseUsername accepts handles, @handles and profile URLs", () => {
  assert.equal(parseUsername("jack"), "jack");
  assert.equal(parseUsername(" @Jack_1 "), "Jack_1");
  assert.equal(parseUsername("https://x.com/jack"), "jack");
  assert.equal(parseUsername("https://twitter.com/jack/status/20"), "jack");
  assert.equal(parseUsername("x.com/jack?lang=en"), "jack");
  assert.equal(parseUsername("not a handle"), undefined);
  assert.equal(parseUsername("waytoolongusername123"), undefined);
});

test("parseTweetId and parseIdFromUrl", () => {
  assert.equal(parseTweetId("20"), "20");
  assert.equal(parseTweetId("https://x.com/jack/status/20?s=20"), "20");
  assert.equal(parseTweetId("https://twitter.com/i/web/status/1844000000000000001"), "1844000000000000001");
  assert.equal(parseTweetId("abc"), undefined);
  assert.equal(parseIdFromUrl("https://x.com/i/lists/1234567", "lists"), "1234567");
  assert.equal(parseIdFromUrl("https://x.com/i/communities/1500", "communities"), "1500");
  assert.equal(parseIdFromUrl("https://x.com/i/lists/abc", "lists"), undefined);
});

test("defaults", () => {
  const p = parseInput({ searchQueries: ["postgres"] });
  assert.equal(p.mode, "searchTweets");
  assert.equal(p.searchCategory, "Latest");
  assert.equal(p.maxItems, 100);
  assert.equal(p.maxPages, 20);
  assert.equal(p.includeRaw, false);
  assert.deepEqual(p.targets, [{ kind: "query", value: "postgres" }]);
});

test("user modes combine usernames and userIds, dedupe case-insensitively", () => {
  const p = parseInput({ mode: "followers", usernames: ["jack", "@Jack", "https://x.com/ada"], userIds: ["12", 12] });
  assert.deepEqual(p.targets, [
    { kind: "username", value: "jack" },
    { kind: "username", value: "ada" },
    { kind: "userId", value: "12" },
  ]);
});

test("new modes read the matching field", () => {
  const tweet = "https://x.com/jack/status/20";
  assert.deepEqual(parseInput({ mode: "tweetQuotes", tweetIds: [tweet] }).targets, [{ kind: "tweetId", value: "20" }]);
  assert.deepEqual(parseInput({ mode: "tweetThread", tweetIds: [tweet] }).targets, [{ kind: "tweetId", value: "20" }]);
  for (const mode of ["userAffiliates", "verifiedFollowers"]) {
    assert.deepEqual(parseInput({ mode, usernames: ["@jack"], userIds: ["12"] }).targets, [
      { kind: "username", value: "jack" },
      { kind: "userId", value: "12" },
    ]);
  }
  assert.deepEqual(parseInput({ mode: "listMembers", listIds: ["https://x.com/i/lists/123"] }).targets, [{ kind: "listId", value: "123" }]);
  assert.deepEqual(parseInput({ mode: "communityMembers", communityIds: ["https://x.com/i/communities/456"] }).targets, [
    { kind: "communityId", value: "456" },
  ]);
  assert.throws(() => parseInput({ mode: "tweetThread", usernames: ["jack"] }), /needs at least one tweet ID/);
  assert.throws(() => parseInput({ mode: "communityMembers", listIds: ["1"] }), /needs at least one community ID/);
});

test("trends default to worldwide", () => {
  assert.deepEqual(parseInput({ mode: "trends" }).targets, [{ kind: "woeid", value: "1" }]);
});

test("validation errors are readable", () => {
  assert.throws(() => parseInput({ mode: "nope" }), InputError);
  assert.throws(() => parseInput({ mode: "searchTweets" }), /needs at least one search query/);
  assert.throws(() => parseInput({ mode: "tweetReplies", tweetIds: ["x"] }), /Could not read these values/);
  assert.throws(() => parseInput({ searchQueries: ["a"], maxItems: 0 }), /maxItems/);
  assert.throws(() => parseInput({ searchQueries: ["a"], maxPages: 1.5 }), /maxPages/);
  assert.throws(() => parseInput({ searchQueries: ["a"], searchCategory: "Old" }), /searchCategory/);
  assert.throws(() => parseInput({ mode: "userTweets", usernames: "jack" as unknown as string[], userIds: {} }), /userIds must be a list/);
});
