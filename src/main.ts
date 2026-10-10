import { Actor, log } from "apify";
import { TwittrAPI } from "twittrapi";
import { collect, type OutputItem, type Sink } from "./collect.js";
import { InputError, parseInput, type RawInput } from "./input.js";

/**
 * Pay-per-event event charged once per dataset item. The Actor owner creates an event with this
 * name in Apify Console (Publication > Monetization). Override with the CHARGE_EVENT_NAME env var.
 */
const CHARGE_EVENT_NAME = process.env.CHARGE_EVENT_NAME?.trim() || "result";

await Actor.init();

try {
  await run();
} catch (err) {
  // Last-resort handler: anything unexpected still ends with a readable status message.
  log.exception(err as Error, "Unexpected error");
  await Actor.fail(`Unexpected error: ${(err as Error)?.message ?? String(err)}`);
}

async function run(): Promise<void> {
  let input;
  try {
    input = parseInput((await Actor.getInput<RawInput>()) ?? {});
  } catch (err) {
    if (err instanceof InputError) {
      await Actor.fail(`Invalid input: ${err.message}`);
      return;
    }
    throw err;
  }

  const apiKey = process.env.TWITTRAPI_API_KEY?.trim();
  if (!apiKey) {
    await Actor.fail(
      "The Actor is not configured: the TWITTRAPI_API_KEY environment variable is missing. (Actor owner: add it as a secret environment variable.)",
    );
    return;
  }

  const client = new TwittrAPI({
    apiKey,
    baseUrl: process.env.TWITTRAPI_BASE_URL?.trim() || undefined, // SDK default: https://api.twittrapi.com
    maxRetries: 3, // 429, 5xx, timeouts; Retry-After on 429 is honoured by the SDK (capped at 60 s)
    timeoutMs: 60_000,
  });

  const sink = createSink();
  log.info(`Mode ${input.mode}: ${input.targets.length} input(s), up to ${input.maxItems} items and ${input.maxPages} pages each`);
  await Actor.setStatusMessage(`Starting: ${input.targets.length} input(s) in mode ${input.mode}`);

  const summary = await collect(client, input, sink, {
    log,
    progress: (msg) => {
      void Actor.setStatusMessage(msg).catch(() => undefined);
    },
  });

  const failed = summary.targets.filter((t) => t.error);
  await Actor.setValue("RUN_SUMMARY", summary);

  if (summary.stopped) {
    const msg = `${summary.stopped.message} Items saved: ${summary.items}.`;
    log.warning(msg);
    if (summary.items === 0 && summary.stopped.reason !== "charge_limit") await Actor.fail(msg);
    else await Actor.exit(msg);
    return;
  }

  const done = `Done: ${summary.items} items from ${summary.targets.length - failed.length} of ${summary.targets.length} input(s).`;
  const skipped = failed.length ? ` Skipped: ${failed.map((f) => `${f.target} (${f.error})`).join("; ")}`.slice(0, 900) : "";
  if (summary.items === 0 && failed.length === summary.targets.length) {
    await Actor.fail(`No results.${skipped}`);
    return;
  }
  await Actor.exit(done + skipped);
}

/**
 * Writes items to the default dataset and charges one pay-per-event event per item.
 *
 * - Pay-per-event run with the event configured: Actor.pushData(item, eventName) pushes and charges
 *   in one step (it calls the SDK's charge() for the event and respects the user's spending limit).
 * - Anything else (local runs, other pricing models, or the owner only uses the synthetic
 *   apify-default-dataset-item event): a plain push. Nothing is charged by this code.
 */
function createSink(): Sink {
  let pricing: { isPayPerEvent: boolean; perEventPrices: Record<string, number> } = {
    isPayPerEvent: false,
    perEventPrices: {},
  };
  try {
    pricing = Actor.getChargingManager().getPricingInfo();
  } catch {
    // older SDK or not initialised: treat as not pay-per-event
  }
  const chargeEvent = pricing.isPayPerEvent && CHARGE_EVENT_NAME in pricing.perEventPrices ? CHARGE_EVENT_NAME : undefined;
  if (pricing.isPayPerEvent && !chargeEvent) {
    log.warning(
      `Pay-per-event pricing is active but has no '${CHARGE_EVENT_NAME}' event; items are pushed without a custom charge.`,
    );
  }
  if (chargeEvent) log.info(`Charging event '${chargeEvent}' once per dataset item.`);

  return {
    async push(item: OutputItem): Promise<boolean> {
      if (!chargeEvent) {
        await Actor.pushData(item);
        // With only the synthetic per-item event, stop once the user's spending limit is used up.
        if (!pricing.isPayPerEvent) return true;
        return Actor.getChargingManager().calculateMaxEventChargeCountWithinLimit("apify-default-dataset-item") > 0;
      }
      const res = await Actor.pushData(item, chargeEvent);
      return !res.eventChargeLimitReached;
    },
  };
}
