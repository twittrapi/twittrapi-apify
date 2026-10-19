/**
 * Collection logic, independent of the Apify runtime so it can be tested with a fake fetch and an
 * in-memory sink. main.ts wires it to Actor.pushData and status messages.
 */
import {
  AuthenticationError,
  InsufficientBalanceError,
  MAX_USERS_PER_REQUEST,
  RateLimitError,
  TwittrAPIError,
  type TwittrAPI,
} from "twittrapi";
import { flattenTimeline, flattenTrends, flattenUsers, type FlatItem, type FlattenOptions } from "./flatten.js";
import { targetLabel, type Mode, type ParsedInput, type Target } from "./input.js";

/** A dataset item as pushed: the flattened item plus where it came from. */
export type OutputItem = FlatItem & { input: string; mode: Mode };

/** Receives items. Returns false when no more items may be pushed (for example, the user's spending limit). */
export interface Sink {
  push(item: OutputItem): Promise<boolean>;
}

export interface Logger {
  info(msg: string): void;
  warning(msg: string): void;
}

export interface Hooks {
  log: Logger;
  /** Called after each page and target with a short progress line. */
  progress?(msg: string): Promise<void> | void;
}

export type StopReason = "balance" | "rate_limit" | "auth" | "charge_limit";

/** Thrown to end the whole run early (as opposed to skipping a single target). */
export class StopRunError extends Error {
  constructor(
    readonly reason: StopReason,
    message: string,
  ) {
    super(message);
    this.name = "StopRunError";
  }
}

export interface TargetResult {
  target: string;
  items: number;
  pages: number;
  error?: string;
}

export interface RunSummary {
  items: number;
  targets: TargetResult[];
  stopped?: { reason: StopReason; message: string };
}

/** Requested page size. X returns about 20 per page for most timelines regardless. */
function pageSize(maxItems: number): number {
  return Math.min(100, Math.max(20, maxItems));
}

function userTarget(t: Target): { userId: string } | { username: string } {
  if (t.kind === "userId") return { userId: t.value };
  if (t.kind === "username") return { username: t.value };
  throw new Error(`Expected a user target, got ${t.kind}`);
}

/** Path ID and query for user endpoints the SDK has no method for: a handle goes to /user/-1?username=. */
function userPath(t: Target): { id: string; query: { username?: string } } {
  const u = userTarget(t);
  return "userId" in u ? { id: u.userId, query: {} } : { id: "-1", query: { username: u.username } };
}

type PageFn = (p: { cursor?: string; count?: number }) => Promise<unknown>;

/** Builds the paginated API call for a mode and target. */
function pageMethod(client: TwittrAPI, input: ParsedInput, t: Target): PageFn {
  const count = pageSize(input.maxItems);
  switch (input.mode) {
    case "searchTweets":
      return (p) => client.search.tweets({ query: t.value, category: input.searchCategory, count, cursor: p.cursor });
    case "userTweets":
      return (p) => client.users.tweets({ ...userTarget(t), count, cursor: p.cursor });
    case "followers":
      return (p) => client.users.followers({ ...userTarget(t), count, cursor: p.cursor });
    case "following":
      return (p) => client.users.following({ ...userTarget(t), count, cursor: p.cursor });
    case "tweetReplies":
      return (p) => client.tweets.get({ tweetId: t.value, cursor: p.cursor });
    case "tweetRetweeters":
      return (p) => client.tweets.retweeters({ tweetId: t.value, count, cursor: p.cursor });
    case "listTweets":
      return (p) => client.lists.tweets({ listId: t.value, count, cursor: p.cursor });
    case "communityTweets":
      return (p) => client.communities.tweets({ communityId: t.value, count, cursor: p.cursor });
    case "tweetQuotes":
      return (p) => client.tweets.quotes({ tweetId: t.value, count, cursor: p.cursor });
    case "verifiedFollowers":
      return (p) => client.users.verifiedFollowers({ ...userTarget(t), count, cursor: p.cursor });
    case "listMembers":
      return (p) => client.lists.members({ listId: t.value, count, cursor: p.cursor });
    // No SDK method yet: plain GET through the client (same auth, retries and errors).
    case "userAffiliates": {
      const { id, query } = userPath(t);
      return (p) => client.get({ path: `/user/${id}/affiliates`, query: { ...query, count, cursor: p.cursor } });
    }
    case "communityMembers":
      return (p) => client.get({ path: `/communities/${t.value}/members`, query: { count, cursor: p.cursor } });
    default:
      throw new Error(`Mode ${input.mode} is not paginated`);
  }
}

/** Which item type a mode returns. Other items in the timeline (suggestions, etc.) are dropped. */
export function expectedType(input: Pick<ParsedInput, "mode" | "searchCategory">): "tweet" | "user" {
  switch (input.mode) {
    case "searchTweets":
      return input.searchCategory === "People" ? "user" : "tweet";
    case "followers":
    case "following":
    case "tweetRetweeters":
    case "userProfiles":
    case "verifiedFollowers":
    case "userAffiliates":
    case "listMembers":
    case "communityMembers":
      return "user";
    default:
      return "tweet";
  }
}

/** Maps API errors that should end the whole run to StopRunError; returns other errors unchanged. */
function classify(err: unknown): unknown {
  if (err instanceof InsufficientBalanceError) {
    return new StopRunError(
      "balance",
      "The data provider rejected the request (402, no balance left). The run stopped early; items collected so far are saved. Please try again later.",
    );
  }
  if (err instanceof RateLimitError) {
    const wait = err.retryAfter !== undefined ? ` (Retry-After ${err.retryAfter}s)` : "";
    return new StopRunError(
      "rate_limit",
      `The data provider is rate limiting requests${wait} and retries did not help. The run stopped early; items collected so far are saved. Please try again in a few minutes.`,
    );
  }
  if (err instanceof AuthenticationError) {
    return new StopRunError(
      "auth",
      "The data provider rejected the Actor's API key (401/403). This is a configuration problem on the Actor owner's side.",
    );
  }
  return err;
}

function describe(err: unknown): string {
  if (err instanceof TwittrAPIError) return err.message;
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

class Collector {
  readonly summary: RunSummary = { items: 0, targets: [] };
  readonly #opts: FlattenOptions;

  constructor(
    private readonly client: TwittrAPI,
    private readonly input: ParsedInput,
    private readonly sink: Sink,
    private readonly hooks: Hooks,
  ) {
    this.#opts = { includeRaw: input.includeRaw };
  }

  async #emit(item: FlatItem, label: string): Promise<void> {
    const { raw, ...rest } = item as FlatItem & { raw?: unknown };
    const out = { ...rest, input: label, mode: this.input.mode } as OutputItem;
    if (raw !== undefined) (out as { raw?: unknown }).raw = raw;
    const more = await this.sink.push(out);
    this.summary.items++;
    if (!more) {
      throw new StopRunError(
        "charge_limit",
        `Reached the maximum cost you set for this run after ${this.summary.items} items. Raise the limit to collect more.`,
      );
    }
  }

  async run(): Promise<RunSummary> {
    const { mode, targets } = this.input;
    try {
      if (mode === "userProfiles") await this.#profiles(targets);
      else if (mode === "tweetThread") for (const t of targets) await this.#guard(t, (res) => this.#thread(t, res));
      else if (mode === "trends") for (const t of targets) await this.#guard(t, (res) => this.#trends(t, res));
      else for (const t of targets) await this.#guard(t, (res) => this.#paginated(t, res));
    } catch (err) {
      if (err instanceof StopRunError) this.summary.stopped = { reason: err.reason, message: err.message };
      else throw err;
    }
    return this.summary;
  }

  /** Runs one target. Errors that affect only this target are logged and the run continues. */
  /**
   * Runs one target. `fn` records progress in `res` as it goes, so a failure mid-way still reports
   * the items already pushed. Errors that affect only this target are logged and the run continues;
   * a failure after the first page counts as a partial result, not a skipped target.
   */
  async #guard(t: Target, fn: (res: TargetResult) => Promise<void>): Promise<void> {
    const label = targetLabel(t);
    const res: TargetResult = { target: label, items: 0, pages: 0 };
    this.summary.targets.push(res);
    try {
      await fn(res);
      this.hooks.log.info(`${label}: ${res.items} items from ${res.pages} page(s)`);
    } catch (err) {
      const c = classify(err);
      if (c instanceof StopRunError) {
        res.error = c.message;
        throw c;
      }
      const msg = describe(c);
      if (res.pages > 0) {
        this.hooks.log.warning(`${label}: stopped after ${res.pages} page(s) and ${res.items} items (${msg})`);
      } else {
        res.error = msg;
        this.hooks.log.warning(`${label}: skipped (${msg})`);
      }
    }
  }

  async #paginated(t: Target, res: TargetResult): Promise<void> {
    const { maxItems, maxPages, mode } = this.input;
    const label = res.target;
    const method = pageMethod(this.client, this.input, t);
    const want = expectedType(this.input);
    const seen = new Set<string>();
    let emptyPages = 0;

    // client.paginate follows the bottom cursor and stops on a missing or repeated cursor,
    // or on a page with only cursor entries.
    for await (const page of this.client.paginate(method, {}, { maxPages })) {
      res.pages++;
      let fresh = 0;
      for (const item of flattenTimeline(page.data, this.#opts)) {
        if (item.type !== want) continue;
        if (mode === "tweetReplies" && item.id === t.value) continue; // the tweet itself, not a reply
        const key = `${item.type}:${item.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        fresh++;
        await this.#emit(item, label);
        res.items++;
        if (res.items >= maxItems) break;
      }
      await this.hooks.progress?.(`${label}: ${res.items} items after ${res.pages} page(s)`);
      if (res.items >= maxItems) break;
      // Follower/following timelines signal the end with a bottom cursor like "0|1844...".
      if (page.nextCursor?.startsWith("0|")) break;
      emptyPages = fresh === 0 ? emptyPages + 1 : 0;
      if (emptyPages >= 2) break; // X keeps sending cursors but no new results
    }
  }

  /** The author's thread around a tweet, in reading order. One request, no pagination. */
  async #thread(t: Target, res: TargetResult): Promise<void> {
    const data = await this.client.get({ path: `/tweet/${t.value}/thread` });
    res.pages = 1;
    const seen = new Set<string>();
    for (const item of flattenTimeline(data, this.#opts)) {
      if (res.items >= this.input.maxItems) break;
      if (item.type !== "tweet" || seen.has(item.id)) continue;
      seen.add(item.id);
      await this.#emit(item, res.target);
      res.items++;
    }
  }

  async #trends(t: Target, res: TargetResult): Promise<void> {
    const data = await this.client.trends.get(t.value);
    res.pages = 1;
    for (const trend of flattenTrends(data, this.#opts)) {
      if (res.items >= this.input.maxItems) break;
      await this.#emit(trend, res.target);
      res.items++;
    }
  }

  async #profiles(targets: Target[]): Promise<void> {
    const ids = targets.filter((t) => t.kind === "userId").map((t) => t.value);
    const names = targets.filter((t) => t.kind === "username");

    for (const t of names) {
      await this.#guard(t, async (res) => {
        const users = flattenUsers(await this.client.users.getByUsername(t.value), this.#opts);
        if (users.length === 0) throw new Error("profile not found or could not be parsed");
        res.pages = 1;
        await this.#emit(users[0]!, res.target);
        res.items = 1;
      });
    }

    for (let i = 0; i < ids.length; i += MAX_USERS_PER_REQUEST) {
      const chunk = ids.slice(i, i + MAX_USERS_PER_REQUEST);
      const batchTarget: Target = { kind: "userId", value: chunk.length === 1 ? chunk[0]! : `${chunk[0]}..(${chunk.length} IDs)` };
      await this.#guard(batchTarget, async (res) => {
        const users = flattenUsers(await this.client.users.getMany(chunk), this.#opts);
        res.pages = 1;
        const wanted = new Set(chunk);
        for (const u of users) {
          if (!wanted.has(u.id)) continue;
          wanted.delete(u.id);
          await this.#emit(u, u.id);
          res.items++;
        }
        if (wanted.size > 0) this.hooks.log.warning(`No profile returned for user IDs: ${[...wanted].join(", ")}`);
      });
    }
  }
}

/** Collects everything the input asks for and pushes it to the sink. Never throws for API errors. */
export function collect(client: TwittrAPI, input: ParsedInput, sink: Sink, hooks: Hooks): Promise<RunSummary> {
  return new Collector(client, input, sink, hooks).run();
}
