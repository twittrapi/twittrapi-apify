/**
 * Flatteners: turn X's raw GraphQL JSON (as returned by TwittrAPI) into small, stable dataset items.
 *
 * X changes these shapes without notice, so everything here is defensive:
 * - every field access goes through `get`, which never throws,
 * - anything that cannot be parsed is skipped (returns undefined), never thrown,
 * - both the older shape (`legacy.screen_name`, `profile_image_url_https`) and the newer one
 *   (`core.screen_name`, `avatar.image_url`, `location.location`) are read.
 *
 * The fixtures in test/fixtures are hand-written from X's documented/observed GraphQL shapes.
 * They must be checked against real TwittrAPI responses before relying on every field.
 */

type Obj = Record<string, unknown>;

export interface TweetAuthor {
  id: string | null;
  username: string | null;
  name: string | null;
  followers: number | null;
  verified: boolean;
}

export interface TweetMetrics {
  likes: number | null;
  retweets: number | null;
  replies: number | null;
  quotes: number | null;
  views: number | null;
  bookmarks: number | null;
}

export interface TweetMedia {
  type: string | null;
  url: string | null;
  /** Highest-bitrate MP4 for videos and GIFs. */
  video_url: string | null;
}

export interface TweetItem {
  type: "tweet";
  id: string;
  url: string | null;
  text: string;
  created_at: string | null;
  lang: string | null;
  author: TweetAuthor | null;
  metrics: TweetMetrics;
  media: TweetMedia[];
  is_reply: boolean;
  is_quote: boolean;
  is_retweet: boolean;
  conversation_id: string | null;
  in_reply_to_tweet_id: string | null;
  in_reply_to_username: string | null;
  quoted_tweet: Omit<TweetItem, "quoted_tweet" | "retweeted_tweet"> | null;
  retweeted_tweet: Omit<TweetItem, "quoted_tweet" | "retweeted_tweet"> | null;
  raw?: unknown;
}

export interface UserItem {
  type: "user";
  id: string;
  username: string | null;
  name: string | null;
  bio: string | null;
  location: string | null;
  website: string | null;
  followers: number | null;
  following: number | null;
  tweets: number | null;
  likes: number | null;
  media_count: number | null;
  created_at: string | null;
  verified: boolean;
  verified_type: string | null;
  protected: boolean;
  profile_image: string | null;
  profile_banner: string | null;
  url: string | null;
  raw?: unknown;
}

export interface TrendItem {
  type: "trend";
  name: string;
  query: string | null;
  url: string | null;
  tweet_volume: number | null;
  rank: number | null;
  context: string | null;
  raw?: unknown;
}

export type FlatItem = TweetItem | UserItem | TrendItem;

export interface FlattenOptions {
  includeRaw?: boolean;
}

// ---------------------------------------------------------------------------
// Safe accessors
// ---------------------------------------------------------------------------

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Reads a nested property by path. Never throws; returns undefined on any missing step. */
export function get(v: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = v;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Obj)[key as string];
  }
  return cur;
}

function str(v: unknown): string | null {
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** Numbers arrive as numbers or numeric strings ("12345" for views). */
function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return null;
}

function firstStr(...vals: unknown[]): string | null {
  for (const v of vals) {
    const s = str(v);
    if (s !== null) return s;
  }
  return null;
}

function firstNum(...vals: unknown[]): number | null {
  for (const v of vals) {
    const n = num(v);
    if (n !== null) return n;
  }
  return null;
}

/** X dates look like "Wed Oct 10 20:19:24 +0000 2018". Returns ISO 8601, or the input if unparseable. */
export function toIsoDate(v: unknown): string | null {
  const s = str(v);
  if (s === null) return null;
  const m = /^\w{3} (\w{3}) (\d{1,2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{4}) (\d{4})$/.exec(s.trim());
  const t = m ? Date.parse(`${m[1]} ${m[2]} ${m[5]} ${m[3]} GMT${m[4]}`) : Date.parse(s);
  return Number.isNaN(t) ? s : new Date(t).toISOString();
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/** Unwraps `{ result: ... }` / `UserResults` wrappers and rejects UserUnavailable etc. */
function unwrapUser(v: unknown): Obj | undefined {
  let cur: unknown = v;
  for (let i = 0; i < 3 && isObj(cur); i++) {
    if (isObj(cur.result)) cur = cur.result;
    else break;
  }
  if (!isObj(cur)) return undefined;
  const tn = cur.__typename;
  if (tn !== undefined && tn !== "User") return undefined;
  if (!str(cur.rest_id)) return undefined;
  return cur;
}

export function flattenUser(v: unknown, opts: FlattenOptions = {}): UserItem | undefined {
  try {
    const u = unwrapUser(v);
    if (!u) return undefined;
    const legacy = isObj(u.legacy) ? u.legacy : {};
    const core = isObj(u.core) ? u.core : {};
    const id = str(u.rest_id)!;
    const username = firstStr(core.screen_name, legacy.screen_name);
    const urlEntity = get(legacy, "entities", "url", "urls", 0);
    const website = firstStr(get(urlEntity, "expanded_url"), legacy.url);
    const item: UserItem = {
      type: "user",
      id,
      username,
      name: firstStr(core.name, legacy.name),
      bio: firstStr(get(u, "profile_bio", "description"), legacy.description),
      location: firstStr(get(u, "location", "location"), typeof u.location === "string" ? u.location : null, legacy.location),
      website,
      followers: firstNum(legacy.followers_count, get(u, "relationship_counts", "followers")),
      following: firstNum(legacy.friends_count, get(u, "relationship_counts", "following")),
      tweets: firstNum(legacy.statuses_count),
      likes: firstNum(legacy.favourites_count),
      media_count: firstNum(legacy.media_count),
      created_at: toIsoDate(firstStr(core.created_at, legacy.created_at)),
      verified: Boolean(u.is_blue_verified || legacy.verified || get(u, "verification", "verified")),
      verified_type: firstStr(legacy.verified_type, get(u, "verification", "verified_type")),
      protected: Boolean(legacy.protected || get(u, "privacy", "protected")),
      profile_image: firstStr(get(u, "avatar", "image_url"), legacy.profile_image_url_https),
      profile_banner: firstStr(legacy.profile_banner_url, get(u, "banner", "image_url")),
      url: username ? `https://x.com/${username}` : null,
    };
    if (opts.includeRaw) item.raw = u;
    return item;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Tweets
// ---------------------------------------------------------------------------

/**
 * Unwraps `{ result }`, `TweetWithVisibilityResults { tweet }` and similar wrappers.
 * Returns undefined for TweetTombstone, TweetUnavailable and anything without a rest_id.
 */
function unwrapTweet(v: unknown): Obj | undefined {
  let cur: unknown = v;
  for (let i = 0; i < 4 && isObj(cur); i++) {
    if (isObj(cur.result)) cur = cur.result;
    else if (cur.__typename === "TweetWithVisibilityResults" && isObj(cur.tweet)) cur = cur.tweet;
    else break;
  }
  if (!isObj(cur)) return undefined;
  const tn = cur.__typename;
  if (tn !== undefined && tn !== "Tweet") return undefined;
  if (!str(cur.rest_id) || !isObj(cur.legacy)) return undefined;
  return cur;
}

function bestVideoUrl(media: Obj): string | null {
  const variants = get(media, "video_info", "variants");
  if (!Array.isArray(variants)) return null;
  let best: { url: string; bitrate: number } | null = null;
  for (const v of variants) {
    if (!isObj(v) || typeof v.url !== "string") continue;
    if (v.content_type !== undefined && v.content_type !== "video/mp4") continue;
    const bitrate = num(v.bitrate) ?? 0;
    if (!best || bitrate > best.bitrate) best = { url: v.url, bitrate };
  }
  return best?.url ?? null;
}

function extractMedia(legacy: Obj): TweetMedia[] {
  const list = get(legacy, "extended_entities", "media") ?? get(legacy, "entities", "media");
  if (!Array.isArray(list)) return [];
  const out: TweetMedia[] = [];
  for (const m of list) {
    if (!isObj(m)) continue;
    const url = firstStr(m.media_url_https, m.media_url);
    if (!url) continue;
    out.push({ type: str(m.type), url, video_url: bestVideoUrl(m) });
  }
  return out;
}

function tweetAuthor(t: Obj): TweetAuthor | null {
  const u = unwrapUser(get(t, "core", "user_results"));
  if (!u) return null;
  const flat = flattenUser(u);
  if (!flat) return null;
  return {
    id: flat.id,
    username: flat.username,
    name: flat.name,
    followers: flat.followers,
    verified: flat.verified,
  };
}

function tweetText(t: Obj, legacy: Obj): string {
  // Long posts keep the full text in note_tweet; legacy.full_text is cut at 280 characters.
  const note = firstStr(get(t, "note_tweet", "note_tweet_results", "result", "text"));
  return note ?? firstStr(legacy.full_text, legacy.text) ?? "";
}

function flattenTweetShallow(t: Obj, opts: FlattenOptions): Omit<TweetItem, "quoted_tweet" | "retweeted_tweet"> {
  const legacy = t.legacy as Obj;
  const id = str(t.rest_id)!;
  const author = tweetAuthor(t);
  const inReplyTo = firstStr(legacy.in_reply_to_status_id_str);
  const item: Omit<TweetItem, "quoted_tweet" | "retweeted_tweet"> = {
    type: "tweet",
    id,
    url: author?.username ? `https://x.com/${author.username}/status/${id}` : `https://x.com/i/status/${id}`,
    text: tweetText(t, legacy),
    created_at: toIsoDate(legacy.created_at),
    lang: str(legacy.lang),
    author,
    metrics: {
      likes: num(legacy.favorite_count),
      retweets: num(legacy.retweet_count),
      replies: num(legacy.reply_count),
      quotes: num(legacy.quote_count),
      views: num(get(t, "views", "count")),
      bookmarks: num(legacy.bookmark_count),
    },
    media: extractMedia(legacy),
    is_reply: inReplyTo !== null,
    is_quote: Boolean(legacy.is_quote_status) || isObj(t.quoted_status_result),
    is_retweet: isObj(legacy.retweeted_status_result) || isObj(t.retweeted_status_result),
    conversation_id: firstStr(legacy.conversation_id_str),
    in_reply_to_tweet_id: inReplyTo,
    in_reply_to_username: firstStr(legacy.in_reply_to_screen_name),
  };
  if (opts.includeRaw) item.raw = t;
  return item;
}

export function flattenTweet(v: unknown, opts: FlattenOptions = {}): TweetItem | undefined {
  try {
    const t = unwrapTweet(v);
    if (!t) return undefined;
    const base = flattenTweetShallow(t, opts);
    const nestedOpts = { includeRaw: false };
    const quoted = unwrapTweet(t.quoted_status_result);
    const retweeted = unwrapTweet(get(t, "legacy", "retweeted_status_result") ?? t.retweeted_status_result);
    let quotedFlat = null;
    let retweetedFlat = null;
    try {
      quotedFlat = quoted ? flattenTweetShallow(quoted, nestedOpts) : null;
    } catch {
      quotedFlat = null;
    }
    try {
      retweetedFlat = retweeted ? flattenTweetShallow(retweeted, nestedOpts) : null;
    } catch {
      retweetedFlat = null;
    }
    const item: TweetItem = { ...base, quoted_tweet: quotedFlat, retweeted_tweet: retweetedFlat };
    // Put raw last so the column order in the dataset stays readable.
    if (item.raw !== undefined) {
      const raw = item.raw;
      delete item.raw;
      item.raw = raw;
    }
    return item;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Timelines
// ---------------------------------------------------------------------------

const MAX_NODES = 200_000;

/** Collects every timeline entry (`{ entryId, content }`) found anywhere in the response. */
export function findEntries(data: unknown): Obj[] {
  const out: Obj[] = [];
  const stack: unknown[] = [data];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_NODES) {
    const node = stack.pop();
    visited++;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
      continue;
    }
    if (!isObj(node)) continue;
    if (typeof node.entryId === "string" && (isObj(node.content) || isObj(node.item))) {
      out.push(node);
      continue; // entries do not contain other top-level entries
    }
    const values = Object.values(node);
    for (let i = values.length - 1; i >= 0; i--) {
      const v = values[i];
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return out;
}

/** The itemContent objects of an entry: one for TimelineTimelineItem, several for modules. */
function entryItemContents(entry: Obj): Obj[] {
  const out: Obj[] = [];
  const content = isObj(entry.content) ? entry.content : isObj(entry.item) ? entry.item : undefined;
  if (!content) return out;
  if (isObj(content.itemContent)) out.push(content.itemContent);
  if (isObj(content.content)) out.push(content.content);
  const items = content.items ?? get(content, "moduleItems");
  if (Array.isArray(items)) {
    for (const it of items) {
      const ic = get(it, "item", "itemContent") ?? get(it, "item", "content") ?? get(it, "itemContent");
      if (isObj(ic)) out.push(ic);
    }
  }
  return out;
}

function isPromoted(entryId: string, ic: Obj): boolean {
  return entryId.startsWith("promoted") || isObj(ic.promotedMetadata) || isObj(ic.promoted_metadata);
}

/**
 * Extracts tweets and users from a timeline response (search, user tweets, followers, replies,
 * list, community, retweeters). Promoted entries and cursors are skipped. Order follows the
 * response; duplicates are kept here and removed by the caller.
 */
export function flattenTimeline(data: unknown, opts: FlattenOptions = {}): (TweetItem | UserItem)[] {
  const out: (TweetItem | UserItem)[] = [];
  let entries: Obj[];
  try {
    entries = findEntries(data);
  } catch {
    return out;
  }
  for (const entry of entries) {
    try {
      const entryId = entry.entryId as string;
      if (entryId.startsWith("cursor-")) continue;
      for (const ic of entryItemContents(entry)) {
        if (isPromoted(entryId, ic)) continue;
        if (isObj(ic.tweet_results)) {
          const t = flattenTweet(ic.tweet_results, opts);
          if (t) out.push(t);
        } else if (isObj(ic.user_results)) {
          const u = flattenUser(ic.user_results, opts);
          if (u) out.push(u);
        }
      }
    } catch {
      // skip this entry
    }
  }
  return out;
}

/**
 * Extracts user profiles from a single-user response (`data.user.result`) or a batch response
 * (`data.users[].result`). Falls back to timeline extraction for anything else.
 */
export function flattenUsers(data: unknown, opts: FlattenOptions = {}): UserItem[] {
  const out: UserItem[] = [];
  try {
    const candidates: unknown[] = [];
    const single = get(data, "data", "user") ?? get(data, "user");
    if (single !== undefined) candidates.push(single);
    for (const listKey of ["users", "users_results"]) {
      const list = get(data, "data", listKey) ?? get(data, listKey);
      if (Array.isArray(list)) candidates.push(...list);
    }
    if (candidates.length === 0 && isObj(data) && (data.rest_id !== undefined || isObj(data.result))) {
      candidates.push(data);
    }
    for (const c of candidates) {
      const u = flattenUser(c, opts);
      if (u) out.push(u);
    }
    if (out.length === 0) {
      for (const item of flattenTimeline(data, opts)) if (item.type === "user") out.push(item);
    }
  } catch {
    // return what we have
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------

function flattenTrendObject(o: Obj, rank: number | null, opts: FlattenOptions): TrendItem | undefined {
  const name = firstStr(o.name, o.trend_name, get(o, "trend", "name"));
  if (!name) return undefined;
  const url = firstStr(o.url, get(o, "trend_url", "url"));
  const query = firstStr(
    typeof o.query === "string" ? decodeSafe(o.query) : null,
    queryFromUrl(url),
    name,
  );
  const item: TrendItem = {
    type: "trend",
    name,
    query,
    url: url && url.startsWith("http") ? url : query ? `https://x.com/search?q=${encodeURIComponent(query)}` : null,
    tweet_volume: firstNum(o.tweet_volume, o.tweet_count, get(o, "trend_metadata", "tweet_count")),
    rank: firstNum(o.rank, rank),
    context: firstStr(
      get(o, "trend_metadata", "domain_context"),
      get(o, "trend_metadata", "meta_description"),
      o.domain_context,
      o.description,
    ),
  };
  if (opts.includeRaw) item.raw = o;
  return item;
}

function queryFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const params = new URL(url, "https://x.com").searchParams;
    return params.get("q") ?? params.get("query");
  } catch {
    return null;
  }
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

/**
 * Extracts trends. Handles the v1.1-style `[{ trends: [{ name, url, query, tweet_volume }] }]`
 * shape and GraphQL `TimelineTrend` item contents.
 */
export function flattenTrends(data: unknown, opts: FlattenOptions = {}): TrendItem[] {
  const out: TrendItem[] = [];
  const stack: unknown[] = [data];
  let visited = 0;
  try {
    while (stack.length > 0 && visited < MAX_NODES) {
      const node = stack.pop();
      visited++;
      if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
        continue;
      }
      if (!isObj(node)) continue;
      if (Array.isArray(node.trends)) {
        let rank = 0;
        for (const t of node.trends) {
          if (!isObj(t)) continue;
          rank++;
          const item = flattenTrendObject(t, rank, opts);
          if (item) out.push(item);
        }
        continue;
      }
      if (node.itemType === "TimelineTrend" || node.__typename === "TimelineTrend") {
        const item = flattenTrendObject(node, null, opts);
        if (item) out.push(item);
        continue;
      }
      const values = Object.values(node);
      for (let i = values.length - 1; i >= 0; i--) {
        const v = values[i];
        if (v && typeof v === "object") stack.push(v);
      }
    }
  } catch {
    // return what we have
  }
  // Number GraphQL trends in document order when X did not send a rank.
  let next = 1;
  for (const t of out) {
    if (t.rank === null) t.rank = next;
    next = t.rank + 1;
  }
  return out;
}
