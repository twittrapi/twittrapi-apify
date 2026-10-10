// Local end-to-end run: starts the mock API, runs the built Actor once per scenario with the
// Apify SDK's local storage (storage/ by default), and checks the dataset and exit status.
// Run `npm run build` first. Never calls the real API.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startMockServer } from "./mock-server.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const STORAGE = process.env.E2E_STORAGE_DIR ?? join(ROOT, "storage");

const SCENARIOS = [
  { name: "search", input: { mode: "searchTweets", searchQueries: ["postgres"], maxItems: 50 }, expectItems: 3, expectExit: 0 },
  { name: "user-tweets", input: { mode: "userTweets", usernames: ["ada_example"], maxItems: 3 }, expectItems: 3, expectExit: 0 },
  { name: "profiles", input: { mode: "userProfiles", usernames: ["ada_example"], userIds: ["2001", "2002"] }, expectItems: 3, expectExit: 0 },
  { name: "followers", input: { mode: "followers", userIds: ["42"], includeRaw: true }, expectItems: 3, expectExit: 0 },
  { name: "following", input: { mode: "following", usernames: ["ada_example"] }, expectItems: 3, expectExit: 0 },
  { name: "replies", input: { mode: "tweetReplies", tweetIds: ["https://x.com/ada_example/status/1844000000000000001"] }, expectItems: 3, expectExit: 0 },
  { name: "retweeters", input: { mode: "tweetRetweeters", tweetIds: ["1844000000000000001"] }, expectItems: 2, expectExit: 0 },
  { name: "list", input: { mode: "listTweets", listIds: ["https://x.com/i/lists/123"] }, expectItems: 1, expectExit: 0 },
  { name: "community", input: { mode: "communityTweets", communityIds: ["456"] }, expectItems: 1, expectExit: 0 },
  { name: "trends", input: { mode: "trends", woeids: ["1", "23424977"] }, expectItems: 4, expectExit: 0 },
  // 402 after one good user: run ends early with a status message, items kept, exit 0.
  { name: "balance-402", input: { mode: "userTweets", usernames: ["ada_example", "broke", "never_reached"], maxItems: 2 }, expectItems: 2, expectExit: 0, expectStatus: /no balance left/ },
  // 429 on the only input (SDK retries with Retry-After, then gives up): nothing collected, run fails.
  { name: "rate-limit-429", input: { mode: "userTweets", usernames: ["busy"] }, expectItems: 0, expectExit: 1, expectStatus: /rate limiting/ },
  // Simulated pay-per-event run (SDK local PPE mode): 'result' costs $1 and the user's limit is
  // $2.50 (the SDK prices events at $1 when not on Apify anyway), so exactly 2 items are pushed and charged, then the run stops with a status message.
  {
    name: "ppe-limit",
    input: { mode: "searchTweets", searchQueries: ["postgres"] },
    env: {
      APIFY_ACTOR_PRICING_INFO: JSON.stringify({ pricingModel: "PAY_PER_EVENT", pricingPerEvent: { actorChargeEvents: { result: { eventPriceUsd: 1, eventTitle: "Result" } } } }),
      APIFY_CHARGED_ACTOR_EVENT_COUNTS: "{}",
      ACTOR_MAX_TOTAL_CHARGE_USD: "2.5",
      ACTOR_USE_CHARGING_LOG_DATASET: "1",
    },
    expectItems: 2,
    expectExit: 0,
    expectStatus: /maximum cost you set/,
    expectCharges: 2,
  },
  { name: "bad-input", input: { mode: "tweetReplies", tweetIds: [] }, expectItems: 0, expectExit: 1, expectStatus: /Invalid input/ },
];

function run(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, opts);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

const { server, port, log } = await startMockServer(0);
let failed = 0;
try {
  for (const s of SCENARIOS) {
    const dir = join(STORAGE, "e2e", s.name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, "key_value_stores", "default"), { recursive: true });
    writeFileSync(join(dir, "key_value_stores", "default", "INPUT.json"), JSON.stringify(s.input, null, 2));

    // Async spawn: the mock server runs in this process and must keep serving.
    const r = await run(process.execPath, [join(ROOT, "dist", "main.js")], {
      cwd: ROOT,
      env: {
        ...process.env,
        APIFY_LOCAL_STORAGE_DIR: dir,
        CRAWLEE_STORAGE_DIR: dir,
        APIFY_PURGE_ON_START: "0",
        TWITTRAPI_API_KEY: "mock-key",
        TWITTRAPI_BASE_URL: `http://127.0.0.1:${port}`,
        ...(s.env ?? {}),
      },
    });
    const dsDir = join(dir, "datasets", "default");
    let files = [];
    try {
      files = readdirSync(dsDir).filter((f) => f.endsWith(".json") && f !== "__metadata__.json");
    } catch {}
    const items = files.sort().map((f) => JSON.parse(readFileSync(join(dsDir, f), "utf8")));
    const output = r.stdout + r.stderr;
    try {
      assert.equal(r.status, s.expectExit, `exit code\n${output}`);
      assert.equal(items.length, s.expectItems, `item count\n${output}`);
      if (s.expectStatus) assert.match(output, s.expectStatus);
      if (s.expectCharges !== undefined) {
        const logDir = join(dir, "datasets", "charging_log");
        const charges = readdirSync(logDir)
          .filter((f) => /^\d+\.json$/.test(f))
          .map((f) => JSON.parse(readFileSync(join(logDir, f), "utf8")))
          .filter((c) => c.eventName === "result")
          .reduce((n, c) => n + c.chargedCount, 0);
        assert.equal(charges, s.expectCharges, "charged 'result' events");
      }
      for (const it of items) {
        assert.ok(["tweet", "user", "trend"].includes(it.type));
        assert.equal(it.mode, s.input.mode);
        assert.equal("raw" in it, s.input.includeRaw === true);
      }
      console.log(`ok   ${s.name.padEnd(15)} exit=${r.status} items=${items.length}  -> ${dsDir}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${s.name}: ${e.message}`);
    }
  }
} finally {
  server.close();
}
console.log(`\n${SCENARIOS.length - failed}/${SCENARIOS.length} scenarios passed, ${log.length} mock requests.`);
process.exit(failed ? 1 : 0);
