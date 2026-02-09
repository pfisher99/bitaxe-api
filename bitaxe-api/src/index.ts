/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export interface Env {
  DB: D1Database;
  INGEST_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request) });
    }

    try {
      if (url.pathname === "/ingest" && request.method === "POST") {
        return await handleIngest(request, env);
      }

      if (url.pathname === "/latest" && request.method === "GET") {
        return await handleLatest(request, env, url);
      }

      if (url.pathname === "/range" && request.method === "GET") {
        return await handleRange(request, env, url);
      }

      return json({ error: "Not found" }, 404, request);
    } catch (err: any) {
      return json({ error: String(err?.message || err) }, 500, request);
    }
  },
};

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function json(obj: unknown, status: number, request: Request): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(request),
    },
  });
}

async function handleIngest(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || token !== env.INGEST_TOKEN) {
    return json({ error: "Unauthorized" }, 401, request);
  }

  const body = (await request.json()) as Record<string, unknown>;

  const miner_id = String(body.miner_id || "");
  if (!miner_id) return json({ error: "miner_id required" }, 400, request);

  const ts =
    Number.isFinite(body.ts as number)
      ? Math.floor(body.ts as number)
      : Math.floor(Date.now() / 1000);

  const row = {
    ts,
    miner_id,

    temp: num(body.temp),
    vrTemp: num(body.vrTemp),
    power: num(body.power),
    voltage: num(body.voltage),
    current: num(body.current),

    hashRate: num(body.hashRate),
    hashRate_1m: num(body.hashRate_1m),
    hashRate_10m: num(body.hashRate_10m),
    hashRate_1h: num(body.hashRate_1h),
    expectedHashrate: num(body.expectedHashrate),

    fanspeed: num(body.fanspeed),
    fanrpm: int(body.fanrpm),

    frequency: int(body.frequency),
    coreVoltageActual: int(body.coreVoltageActual),

    errorPercentage: num(body.errorPercentage),
    sharesAccepted: int(body.sharesAccepted),
    sharesRejected: int(body.sharesRejected),

    isUsingFallbackStratum: int(body.isUsingFallbackStratum),
    responseTime: num(body.responseTime),

    uptimeSeconds: int(body.uptimeSeconds),
    blockHeight: int(body.blockHeight),
    version: body.version ? String(body.version) : null,

    bestDiff: int(body.bestDiff),
    bestSessionDiff: int(body.bestSessionDiff),
  };

  const stmt = env.DB.prepare(`
    INSERT INTO bitaxe_samples (
      ts, miner_id,
      temp, vrTemp, power, voltage, current,
      hashRate, hashRate_1m, hashRate_10m, hashRate_1h, expectedHashrate,
      fanspeed, fanrpm,
      frequency, coreVoltageActual,
      errorPercentage, sharesAccepted, sharesRejected,
      isUsingFallbackStratum, responseTime,
      uptimeSeconds, blockHeight, version,
      bestDiff, bestSessionDiff
    ) VALUES (
      ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?
    )
  `).bind(
    row.ts, row.miner_id,
    row.temp, row.vrTemp, row.power, row.voltage, row.current,
    row.hashRate, row.hashRate_1m, row.hashRate_10m, row.hashRate_1h, row.expectedHashrate,
    row.fanspeed, row.fanrpm,
    row.frequency, row.coreVoltageActual,
    row.errorPercentage, row.sharesAccepted, row.sharesRejected,
    row.isUsingFallbackStratum, row.responseTime,
    row.uptimeSeconds, row.blockHeight, row.version,
    row.bestDiff, row.bestSessionDiff
  );

  await stmt.run();

  return json({ ok: true }, 200, request);
}

async function handleLatest(request: Request, env: Env, url: URL): Promise<Response> {
  const miner_id = url.searchParams.get("miner_id");
  if (!miner_id) return json({ error: "miner_id required" }, 400, request);

  const sample = await env.DB.prepare(
    `SELECT * FROM bitaxe_samples WHERE miner_id = ? ORDER BY ts DESC LIMIT 1`
  ).bind(miner_id).first();

  return json({ miner_id, sample: sample || null }, 200, request);
}

async function handleRange(request: Request, env: Env, url: URL): Promise<Response> {
  const miner_id = url.searchParams.get("miner_id");
  if (!miner_id) return json({ error: "miner_id required" }, 400, request);

  // default 24h, clamp to 90 days
  const hoursRaw = parseInt(url.searchParams.get("hours") || "24", 10);
  const hours = Math.max(1, Math.min(24 * 90, Number.isFinite(hoursRaw) ? hoursRaw : 24));
  const fromTs = Math.floor(Date.now() / 1000) - hours * 3600;

  const res = await env.DB.prepare(
    `SELECT ts, temp, vrTemp, power, hashRate_1m, fanrpm, errorPercentage, bestDiff
     FROM bitaxe_samples
     WHERE miner_id = ? AND ts >= ?
     ORDER BY ts ASC`
  ).bind(miner_id, fromTs).all();

  return json({ miner_id, fromTs, hours, samples: res.results }, 200, request);
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function int(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
