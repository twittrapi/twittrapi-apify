# Twitter (X) Data API: Tweets, Profiles, Followers, Search

Get tweets, search results, profiles, followers, replies, retweeters, list and community tweets, and trends from X (Twitter) as clean JSON, CSV or Excel. You don't need an X account, a login, cookies or proxies, and nothing runs in a browser.

This Actor gets its data from [TwittrAPI](https://twittrapi.com/?utm_source=apify), a hosted X data API, so runs are quick and use little memory. Every tweet and user comes back with the same flat fields, so you can load the results into a spreadsheet or database without cleaning them up first.

## What can it collect?

| Mode | You give it | You get |
|---|---|---|
| Search tweets | Search queries (X search operators work) | Tweets, or accounts with the People tab |
| User tweets | Usernames or user IDs | Tweets from the profile timeline, including the pinned tweet and retweets |
| User profiles | Usernames or user IDs | One profile per user |
| Followers of a user | Usernames or user IDs | Accounts that follow the user |
| Accounts a user follows | Usernames or user IDs | Accounts the user follows |
| Tweet replies | Tweet IDs or URLs | Replies in the tweet's conversation |
| Tweet retweeters | Tweet IDs or URLs | Accounts that retweeted the tweet |
| List tweets | List IDs or URLs | Tweets from an X list |
| Community tweets | Community IDs or URLs | Tweets posted in an X Community |
| Trends by location | WOEIDs (1 = worldwide) | Trending topics with rank and volume |

## How to use it

1. Pick a **Mode**.
2. Fill in the field for that mode, for example **Search queries** or **Usernames**. URLs work too: `https://x.com/nasa`, `https://x.com/nasa/status/1844000000000000001`, `https://x.com/i/lists/123`.
3. Set **Max items per input**. Each query, user, tweet, list or community is collected up to this number.
4. Click **Start** and download the results from the **Output** tab as JSON, CSV, Excel or HTML, or read them through the Apify API.

### Search operators

Search queries work the same way as the X search box:

- `from:nasa` gets tweets from one account. `to:nasa` gets replies sent to it.
- `"exact phrase"` matches the exact words. Add `-word` to leave a word out.
- `lang:en` limits results to one language.
- `since:2025-01-01 until:2025-02-01` sets a date range.
- `min_faves:100`, `min_retweets:20` and `min_replies:5` set an engagement minimum.
- `filter:media`, `filter:links` and `-filter:replies` filter by content type.

Use the **Latest** search tab for the newest tweets first. Use **Top** for X's own ranking.

## Input examples

Search for recent English tweets about a topic:

```json
{
  "mode": "searchTweets",
  "searchQueries": ["openai lang:en -filter:replies", "from:nasa since:2025-01-01"],
  "searchCategory": "Latest",
  "maxItems": 200
}
```

Get profiles for a few accounts:

```json
{
  "mode": "userProfiles",
  "usernames": ["nasa", "https://x.com/spacex"],
  "userIds": ["11348282"]
}
```

Get the first 1,000 followers of an account:

```json
{
  "mode": "followers",
  "usernames": ["nasa"],
  "maxItems": 1000,
  "maxPages": 60
}
```

Get replies to a tweet:

```json
{
  "mode": "tweetReplies",
  "tweetIds": ["https://x.com/nasa/status/1844000000000000001"],
  "maxItems": 500
}
```

Get trends for the whole world and the United States:

```json
{
  "mode": "trends",
  "woeids": ["1", "23424977"]
}
```

### Limits

- **Max items per input** (default 100) caps the number of results for each query, user, tweet, list, community or location.
- **Max pages per input** (default 20) caps the number of requests for each input. A page usually holds about 20 results, so for 1,000 items set it to at least 50.
- **Include raw X data** adds a `raw` field to each item with X's original JSON. Turn it on only if you need fields that the flat output doesn't include, because it makes items much larger.

## Output

Each dataset item has a `type` field set to `tweet`, `user` or `trend`. It also has an `input` field (the query, user, tweet, list, community or location it came from) and a `mode` field. The Output tab has separate table views for tweets, users and trends.

### Tweet

```json
{
  "type": "tweet",
  "id": "1844000000000000002",
  "url": "https://x.com/oldshape/status/1844000000000000002",
  "text": "@ada_example Here is a clip of it running",
  "created_at": "2024-10-09T13:59:00.000Z",
  "lang": "en",
  "author": {
    "id": "777",
    "username": "oldshape",
    "name": "Old Shape User",
    "followers": 12,
    "verified": false
  },
  "metrics": {
    "likes": 3,
    "retweets": 0,
    "replies": 0,
    "quotes": 0,
    "views": null,
    "bookmarks": 0
  },
  "media": [
    {
      "type": "video",
      "url": "https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/thumb.jpg",
      "video_url": "https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/high.mp4"
    }
  ],
  "is_reply": true,
  "is_quote": false,
  "is_retweet": false,
  "conversation_id": "1843999999999999000",
  "in_reply_to_tweet_id": "1843999999999999000",
  "in_reply_to_username": "ada_example",
  "quoted_tweet": null,
  "retweeted_tweet": null,
  "input": "postgres",
  "mode": "searchTweets"
}
```

- `text` is the full text, including long posts over 280 characters.
- `created_at` is in ISO 8601 format, in UTC.
- `media[].video_url` is the highest-quality MP4 for videos and GIFs.
- `quoted_tweet` and `retweeted_tweet` contain the original tweet, with the same fields, for quotes and retweets.
- A field is `null` when X didn't send it. For example, `views` is null for older tweets.

### User

```json
{
  "type": "user",
  "id": "12345",
  "username": "ada_example",
  "name": "Ada Example",
  "bio": "Writes about databases.",
  "location": "London",
  "website": "https://ada.example",
  "followers": 52000,
  "following": 310,
  "tweets": 8800,
  "likes": 1200,
  "media_count": 40,
  "created_at": "2006-03-21T20:50:14.000Z",
  "verified": true,
  "verified_type": null,
  "protected": false,
  "profile_image": "https://pbs.twimg.com/profile_images/1/ada_normal.jpg",
  "profile_banner": "https://pbs.twimg.com/profile_banners/12345/1",
  "url": "https://x.com/ada_example",
  "input": "@ada_example",
  "mode": "userProfiles"
}
```

### Trend

```json
{
  "type": "trend",
  "name": "#Postgres17",
  "query": "#Postgres17",
  "url": "http://twitter.com/search?q=%23Postgres17",
  "tweet_volume": 15400,
  "rank": 1,
  "context": null,
  "input": "1",
  "mode": "trends"
}
```

The examples above use made-up accounts.

## How much does it cost?

<!-- PRICING PLACEHOLDER: fill in once pay-per-event pricing is set in Apify Console. -->
You pay per result: **$X.XX per 1,000 items** (tweets, users or trends). You don't pay extra for proxies or compute. To control spending, set **Max items per input**, or set a maximum cost per run in the run options. The Actor stops when it reaches either limit, and it keeps the items it already collected.

## FAQ

**Do I need an X account or API key?** No. The Actor uses its own access to TwittrAPI.

**Why did I get fewer results than Max items?** X decides how far back a search or timeline goes, and some timelines end early. For example, X shows only some of the replies to popular tweets, and a profile timeline only goes back a limited number of tweets. To go further back on a profile, use Search tweets with `from:username since:... until:...`.

**Can I get private or deleted tweets?** No. Only public data is available. The Actor skips protected, deleted or suspended content.

**A run stopped early with a message about the provider.** If the data provider is rate limiting requests or is temporarily unavailable, the Actor stops and keeps the items it already collected. Wait a few minutes, then run it again.

**I need a field that isn't in the output.** Turn on **Include raw X data**, or contact us and we may add it.

**Can I call this from my own code?** Yes, through the [Apify API](https://docs.apify.com/api/v2) or the Apify clients. If you'd rather call TwittrAPI directly, without Apify, see [twittrapi.com](https://twittrapi.com/?utm_source=apify).

## Is it legal to collect data from X?

This Actor collects only publicly available data. Personal data is protected by laws such as the GDPR, so only collect it if you have a legitimate reason. If you're unsure, ask a lawyer.

## Disclaimer

Not affiliated with X Corp. "Twitter" and "X" are trademarks of X Corp., used here only to describe the data.

Powered by [TwittrAPI](https://twittrapi.com/?utm_source=apify).
