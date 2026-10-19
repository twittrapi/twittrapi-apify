# Changelog

## Unreleased

- New modes: quote tweets (`tweetQuotes`), tweet thread (`tweetThread`), affiliates of an
  organization (`userAffiliates`), verified followers (`verifiedFollowers`), list members
  (`listMembers`) and community members (`communityMembers`).

## 0.1.0 (2026-10-10)

First release.

- Modes: search tweets (Latest, Top, People, Photos, Videos), user tweets, user profiles, followers,
  following, tweet replies, tweet retweeters, list tweets, community tweets, trends by WOEID.
- Accepts usernames, IDs, or X URLs for users, tweets, lists and communities.
- Flat dataset items for tweets, users and trends, with an optional `raw` field.
- Max items and max pages per input. Results are deduplicated per input.
- Charges one pay-per-event event per item and stops at the user's maximum cost per run.
- Stops cleanly with a status message on 402 and 429 (after retries that honour Retry-After), and
  keeps the items already collected.
