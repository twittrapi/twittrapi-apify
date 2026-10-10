import { readFileSync } from "node:fs";

/** Tests run from build-test/test/, fixtures stay in test/fixtures/. */
const FIXTURES = new URL("../../test/fixtures/", import.meta.url);

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));
}

export interface Route {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * A fake fetch. `routes` maps "path?cursor=X" (or just "path" for the first page) to a response.
 * Unknown requests get a 404. Every requested URL is recorded in `calls`.
 */
export function fakeFetch(routes: Record<string, Route | ((url: URL) => Route)>): { fetch: typeof fetch; calls: URL[] } {
  const calls: URL[] = [];
  const f = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url);
    const cursor = url.searchParams.get("cursor");
    const key = cursor ? `${url.pathname}?cursor=${cursor}` : url.pathname;
    const r = routes[key];
    const route = typeof r === "function" ? r(url) : r;
    if (!route) return new Response(JSON.stringify({ error: `no route for ${key}` }), { status: 404 });
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json", ...(route.headers ?? {}) },
    });
  };
  return { fetch: f as typeof fetch, calls };
}
