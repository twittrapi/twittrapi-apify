# Development and publishing notes

.actor/README.md is the Apify Store page; README.md is the GitHub page. This file is for the Actor owner and contributors.

## Layout

```
.actor/actor.json           Actor definition (name, memory, schema paths, Dockerfile)
.actor/input_schema.json    Input form
.actor/dataset_schema.json  Dataset fields and the Tweets / Users / Trends output views
.actor/output_schema.json   Output tab links (dataset items, RUN_SUMMARY record)
Dockerfile                  Two-stage build on apify/actor-node:24
src/main.ts                 Apify wiring: input, API key, push + charge, status messages, exit
src/collect.ts              Per-mode collection, pagination, error handling (no Apify imports)
src/flatten.ts              Raw X GraphQL -> flat tweet / user / trend items (pure, defensive)
src/input.ts                Input validation, URL -> ID parsing
test/                       Unit tests (node:test) and hand-written fixtures
scripts/mock-server.mjs     Local mock of the TwittrAPI HTTP API serving the fixtures
scripts/e2e.mjs             Runs the built Actor against the mock with local storage
```

## The TwittrAPI SDK

The actor uses the published npm package `twittrapi` (pinned in package.json). To update it: `npm install twittrapi@<version> --save-exact`, run the tests, then `apify push`.

## Flattening

`src/flatten.ts` walks the response for timeline entries (`{ entryId, content }`) wherever they are,
so it does not depend on the per-endpoint path (`search_by_raw_query.search_timeline...`,
`user.result.timeline...`, `threaded_conversation_with_injections_v2...`). For each entry it reads
`content.itemContent` or, for modules (threads, conversations), `content.items[].item.itemContent`,
then `tweet_results` or `user_results`. It skips cursors, promoted entries, `TweetTombstone`,
`UserUnavailable` and anything without a `rest_id` or `legacy`. It unwraps `TweetWithVisibilityResults`.
It reads both user shapes: the older one (`legacy.screen_name`, `legacy.profile_image_url_https`) and
the newer one (`core.screen_name`, `avatar.image_url`, `location.location`). Long posts use `note_tweet`
text. Each mode keeps only its expected type (for example, "who to follow" users inside a user's
tweet timeline are dropped). Items are deduplicated per input.

**The fixtures are hand-written** from X's documented and commonly observed GraphQL shapes. They are not
captured from TwittrAPI. Before you publish, run each mode once against the real API with
`includeRaw: true`, compare the `raw` field with the flat fields, and save one real response per mode as
a new fixture. Paths that are most likely to differ are `views.count`, the `core`/`avatar`/`location`
user fields, the trends shape, and where replies sit in the tweet detail response.

## Charging

`src/main.ts` charges one pay-per-event event per dataset item:

- On a pay-per-event run where the event `result` (or `CHARGE_EVENT_NAME`) is defined, it calls
  `Actor.pushData(item, "result")`. This is the SDK's push-and-charge: it calls the charging manager
  (the same as `Actor.charge({ eventName: "result" })`) for each item, and it does not push items past
  the user's maximum cost per run. When `eventChargeLimitReached` is true, the run stops with a status message.
- On any other run (local, pay-per-result, free), it does a plain `Actor.pushData(item)` and charges nothing.
- If the pricing only uses Apify's synthetic `apify-default-dataset-item` event, the platform charges
  each item automatically. The code then only stops once the user's limit is used up.

Use either the custom `result` event or the synthetic `apify-default-dataset-item` event, not both,
or each item is charged twice.

## Local testing

```bash
npm install
npm test          # tsc + node:test: flatteners, input parsing, collection with a fake fetch
npm run build
npm run e2e       # 14 scenarios against the mock API, local storage under storage/e2e/<scenario>/
```

To use the Apify CLI instead (no login needed, nothing is pushed):

```bash
node scripts/mock-server.mjs 8787 &
mkdir -p storage/key_value_stores/default
echo '{"mode":"searchTweets","searchQueries":["postgres"]}' > storage/key_value_stores/default/INPUT.json
TWITTRAPI_API_KEY=mock TWITTRAPI_BASE_URL=http://127.0.0.1:8787 npx apify-cli@1.10.0 run --purge
ls storage/datasets/default
```

The e2e `ppe-limit` scenario simulates a pay-per-event run locally (`APIFY_ACTOR_PRICING_INFO`,
`ACTOR_MAX_TOTAL_CHARGE_USD`, `ACTOR_USE_CHARGING_LOG_DATASET`) and checks that exactly as many
events are charged as items are pushed.

## Publishing and monetizing (owner steps)

1. Push this repo to a private Git repository. In Apify Console, create a new Actor from that Git repository
   (or run `apify login` and `apify push` yourself).
2. In **Source > Environment variables**, add `TWITTRAPI_API_KEY` with the partner key and tick
   **Secret**. Optionally add `TWITTRAPI_BASE_URL`. Don't put the key in actor.json or in the repo.
3. Build, then run each mode once with `includeRaw: true`. Check the flat fields against `raw`, and
   update the fixtures and flatteners where they differ (see Flattening).
4. In **Publication > Monetization**, choose **Pay per event**. Add an event named `result` (title
   "Result", description "One tweet, user or trend in the dataset") with your price per item. Either
   remove the synthetic `apify-default-dataset-item` event or keep it and drop `result`, not both.
   Keep the default `apify-actor-start` event. Pricing changes take effect after the notice period
   Apify shows.
5. Fill in the pricing placeholder in .actor/README.md, add an icon, pick categories (Social media, Lead
   generation), and publish to the Store.
6. Watch for failed runs: 401/403 means the key is wrong, and 402 means the partner balance is empty.
   Both stop runs with a clear status message.
