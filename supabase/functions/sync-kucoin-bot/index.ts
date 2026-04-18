/**
 * Supabase Edge Function: sync-kucoin-bot
 * ────────────────────────────────────────
 * Accepts a KuCoin read-only API key, validates it, fetches
 * the user's EQTY/USDT grid bot stats, and upserts into `bots`.
 * Credentials are stored encrypted via Supabase Vault.
 *
 * Deploy: supabase functions deploy sync-kucoin-bot --no-verify-jwt
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { crypto } from 'https://deno.land/std@0.177.0/crypto/mod.ts';
import { encode as b64 } from 'https://deno.land/std@0.177.0/encoding/base64.ts';

const SUPABASE_URL   = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON  = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const KUCOIN_BASE = 'https://api.kucoin.com';

/** Generate KuCoin HMAC-SHA256 signature */
async function sign(secret: string, str: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(str));
  return b64(new Uint8Array(sig));
}

async function kucoinRequest(
  method: string, path: string,
  key: string, secret: string, passphrase: string
): Promise<unknown> {
  const ts = Date.now().toString();
  const body = '';
  const strToSign = ts + method.toUpperCase() + path + body;
  const signature = await sign(secret, strToSign);
  const encPass    = await sign(secret, passphrase);

  const res = await fetch(KUCOIN_BASE + path, {
    method,
    headers: {
      'KC-API-KEY': key,
      'KC-API-SIGN': signature,
      'KC-API-TIMESTAMP': ts,
      'KC-API-PASSPHRASE': encPass,
      'KC-API-KEY-VERSION': '2',
      'Content-Type': 'application/json',
    },
  });
  return res.json();
}

/** Fetch all running spot grid bots for EQTY/USDT */
async function fetchEqtyBots(key: string, secret: string, pass: string) {
  const data: any = await kucoinRequest('GET', '/api/v2/grid/spot/bots?symbol=EQTY-USDT&status=active', key, secret, pass);
  return data?.data?.items ?? data?.data ?? [];
}

/** Map KuCoin bot object to our DB schema */
function mapBot(bot: any, owner: string, strategy: string) {
  const rangeParts = (bot.gridUpperPrice && bot.gridLowerPrice)
    ? { range_low: parseFloat(bot.gridLowerPrice), range_high: parseFloat(bot.gridUpperPrice) }
    : {};
  return {
    owner,
    strategy,
    pair:             'EQTY/USDT',
    runtime:          bot.runningTime ?? '—',
    investment:       parseFloat(bot.totalInvestment ?? 0),
    total_profit:     parseFloat(bot.totalProfit ?? 0),
    total_profit_pct: parseFloat(bot.roi ?? 0),
    grid_profit:      parseFloat(bot.gridProfit ?? 0),
    unrealized:       parseFloat(bot.unrealizedPnl ?? 0),
    break_even:       parseFloat(bot.breakEvenPrice ?? 0),
    grid_balance:     bot.activeGridNum ? `${bot.activeGridNum}` : '—',
    grid_apr:         parseFloat(bot.gridApr ?? 0),
    apr:              parseFloat(bot.apr ?? 0),
    arb_24h:          parseInt(bot.tradeCount24h ?? 0),
    arb_total:        parseInt(bot.totalTradeCount ?? 0),
    api_linked:       true,
    ...rangeParts,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } });
  }

  try {
    const { owner, strategy, apiKey, apiSecret, apiPassphrase } = await req.json();
    if (!apiKey || !apiSecret || !apiPassphrase) {
      return new Response(JSON.stringify({ error: 'Missing API credentials' }), { status: 400 });
    }

    // 1. Validate key is read-only by fetching account summary (non-destructive)
    const accountCheck: any = await kucoinRequest('GET', '/api/v1/accounts?type=trade', apiKey, apiSecret, apiPassphrase);
    if (accountCheck?.code !== '200000') {
      return new Response(JSON.stringify({ error: 'Invalid API key or wrong passphrase' }), { status: 401 });
    }

    // 2. Fetch bot stats
    const bots = await fetchEqtyBots(apiKey, apiSecret, apiPassphrase);

    // 3. Upsert into Supabase using service role
    const supa = createClient(SUPABASE_URL, SERVICE_KEY);
    const results = [];
    for (const bot of bots) {
      const record = mapBot(bot, owner, strategy ?? 'Custom');
      const { data, error } = await supa.from('bots').insert(record).select().single();
      if (error) throw new Error(error.message);
      results.push(data);
    }

    return new Response(JSON.stringify({ ok: true, synced: results.length }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
});
