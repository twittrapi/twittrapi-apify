/** Input parsing and validation. Pure functions, unit tested. */

export const MODES = [
  "searchTweets",
  "userTweets",
  "userProfiles",
  "followers",
  "following",
  "tweetReplies",
  "tweetRetweeters",
  "listTweets",
  "communityTweets",
  "trends",
  "tweetQuotes",
  "tweetThread",
  "userAffiliates",
  "verifiedFollowers",
  "listMembers",
  "communityMembers",
] as const;
export type Mode = (typeof MODES)[number];

export const SEARCH_CATEGORIES = ["Latest", "Top", "People", "Photos", "Videos"] as const;
export type SearchCategoryInput = (typeof SEARCH_CATEGORIES)[number];

export const DEFAULT_MAX_ITEMS = 100;
export const DEFAULT_MAX_PAGES = 20;
export const MAX_MAX_ITEMS = 100_000;
export const MAX_MAX_PAGES = 1_000;

export interface RawInput {
  mode?: unknown;
  searchQueries?: unknown;
  searchCategory?: unknown;
  usernames?: unknown;
  userIds?: unknown;
  tweetIds?: unknown;
  listIds?: unknown;
  communityIds?: unknown;
  woeids?: unknown;
  maxItems?: unknown;
  maxPages?: unknown;
  includeRaw?: unknown;
}

/** One unit of work: a query, a user, a tweet, a list, a community or a location. */
export type Target =
  | { kind: "query"; value: string }
  | { kind: "username"; value: string }
  | { kind: "userId"; value: string }
  | { kind: "tweetId"; value: string }
  | { kind: "listId"; value: string }
  | { kind: "communityId"; value: string }
  | { kind: "woeid"; value: string };

export interface ParsedInput {
  mode: Mode;
  searchCategory: SearchCategoryInput;
  targets: Target[];
  maxItems: number;
  maxPages: number;
  includeRaw: boolean;
}

export class InputError extends Error {}

function stringList(v: unknown, field: string): string[] {
  if (v === undefined || v === null || v === "") return [];
  const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\n,]/) : null;
  if (!arr) throw new InputError(`${field} must be a list of strings`);
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item === "number") out.push(String(item));
    else if (typeof item === "string" && item.trim()) out.push(item.trim());
  }
  return [...new Set(out)];
}

const NUMERIC = /^\d{1,30}$/;
const X_HOST = /^(?:https?:\/\/)?(?:(?:www|mobile)\.)?(?:x|twitter)\.com\//i;

/** Accepts "jack", "@jack" or "https://x.com/jack". */
export function parseUsername(s: string): string | undefined {
  let v = s.trim();
  if (X_HOST.test(v)) {
    v = v.replace(X_HOST, "").split(/[/?#]/)[0] ?? "";
  }
  v = v.replace(/^@/, "");
  return /^[A-Za-z0-9_]{1,15}$/.test(v) ? v : undefined;
}

/** Accepts "1234" or a URL containing /status/1234. */
export function parseTweetId(s: string): string | undefined {
  const v = s.trim();
  if (NUMERIC.test(v)) return v;
  const m = /\/status(?:es)?\/(\d{1,30})/.exec(v);
  return m?.[1];
}

/** Accepts "1234" or a URL like x.com/i/lists/1234 (segment = "lists") or x.com/i/communities/1234. */
export function parseIdFromUrl(s: string, segment: string): string | undefined {
  const v = s.trim();
  if (NUMERIC.test(v)) return v;
  const m = new RegExp(`/${segment}/(\\d{1,30})`).exec(v);
  return m?.[1];
}

function intInRange(v: unknown, field: string, fallback: number, min: number, max: number): number {
  if (v === undefined || v === null || v === "") return fallback;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
    throw new InputError(`${field} must be a whole number from ${min} to ${max}`);
  }
  return n;
}

function collect(
  values: string[],
  parse: (s: string) => string | undefined,
  kind: Target["kind"],
  invalid: string[],
): Target[] {
  const out: Target[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const v = parse(raw);
    if (!v) {
      invalid.push(raw);
      continue;
    }
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, value: v } as Target);
  }
  return out;
}

/** Validates the raw input and expands it into a list of targets. Throws InputError with a readable message. */
export function parseInput(raw: RawInput | null | undefined): ParsedInput {
  const input = raw ?? {};
  const mode = (input.mode ?? "searchTweets") as Mode;
  if (!MODES.includes(mode)) throw new InputError(`mode must be one of: ${MODES.join(", ")}`);

  const searchCategory = (input.searchCategory ?? "Latest") as SearchCategoryInput;
  if (!SEARCH_CATEGORIES.includes(searchCategory)) {
    throw new InputError(`searchCategory must be one of: ${SEARCH_CATEGORIES.join(", ")}`);
  }

  const maxItems = intInRange(input.maxItems, "maxItems", DEFAULT_MAX_ITEMS, 1, MAX_MAX_ITEMS);
  const maxPages = intInRange(input.maxPages, "maxPages", DEFAULT_MAX_PAGES, 1, MAX_MAX_PAGES);
  const includeRaw = input.includeRaw === true;

  const invalid: string[] = [];
  let targets: Target[] = [];
  let need = "";

  switch (mode) {
    case "searchTweets":
      targets = stringList(input.searchQueries, "searchQueries").map((q) => ({ kind: "query", value: q }) as Target);
      targets = targets.filter((t) => {
        if (t.value.length > 512) invalid.push(t.value.slice(0, 40) + "...");
        return t.value.length <= 512;
      });
      need = "at least one search query in searchQueries";
      break;
    case "userTweets":
    case "userProfiles":
    case "followers":
    case "following":
    case "verifiedFollowers":
    case "userAffiliates":
      targets = [
        ...collect(stringList(input.usernames, "usernames"), parseUsername, "username", invalid),
        ...collect(stringList(input.userIds, "userIds"), (s) => (NUMERIC.test(s) ? s : undefined), "userId", invalid),
      ];
      need = "at least one username in usernames or one numeric ID in userIds";
      break;
    case "tweetReplies":
    case "tweetRetweeters":
    case "tweetQuotes":
    case "tweetThread":
      targets = collect(stringList(input.tweetIds, "tweetIds"), parseTweetId, "tweetId", invalid);
      need = "at least one tweet ID or tweet URL in tweetIds";
      break;
    case "listTweets":
    case "listMembers":
      targets = collect(stringList(input.listIds, "listIds"), (s) => parseIdFromUrl(s, "lists"), "listId", invalid);
      need = "at least one list ID or list URL in listIds";
      break;
    case "communityTweets":
    case "communityMembers":
      targets = collect(
        stringList(input.communityIds, "communityIds"),
        (s) => parseIdFromUrl(s, "communities"),
        "communityId",
        invalid,
      );
      need = "at least one community ID or community URL in communityIds";
      break;
    case "trends": {
      const woeids = stringList(input.woeids, "woeids");
      targets = collect(woeids.length ? woeids : ["1"], (s) => (/^\d{1,12}$/.test(s) ? s : undefined), "woeid", invalid);
      need = "at least one numeric WOEID in woeids";
      break;
    }
  }

  if (invalid.length > 0) {
    throw new InputError(`Could not read these values for mode ${mode}: ${invalid.slice(0, 10).join(", ")}`);
  }
  if (targets.length === 0) throw new InputError(`Mode ${mode} needs ${need}.`);

  return { mode, searchCategory, targets, maxItems, maxPages, includeRaw };
}

/** Human-readable label for logs and the `input` field of dataset items. */
export function targetLabel(t: Target): string {
  return t.kind === "username" ? `@${t.value}` : t.value;
}
