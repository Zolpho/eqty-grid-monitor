/**
 * Supabase Edge Function: sync-kucoin-bot v2.1
 * Fixes:
 * 1) Uses built-in SUPABASE_SERVICE_ROLE_KEY correctly
 * 2) Removes strict symbol/status URL filter
 * 3) Adds logs so we can see what KuCoin returns
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { crypto } from 'https://deno.land/std@0.177.0/crypto/mod.ts';
import { encode as b64 } from 'https://deno.land/std@0.177.0/encoding/base64.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const KUCOIN_BASE = 'https://api.kucoin.com';

async function sign(secret: string, str: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(str));
  return b64(new Uint8Array(sig));
}

async function kucoinRequest(
  method: string,
  path: string,
  key: string,
  secret: string,
  passphrase: string
): Promise<any> {
  const ts = Date.now().toString();
  const strToSign = ts + method.toUpperCase() + path;
  const signature = await sign(secret, strToSign);
  const encPass = await sign(secret, passphrase);

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

  const json = await res.json();
  return json;
}

async function fetchAllBots(key: string, secret: string, pass: string) {
  const data = await kucoinRequest('GET', '/api/v2/grid/spot/bots', key, secret, pass);
  console.log('KuCoin raw response:', JSON.stringify(data));

  const items = data?.data?.items ?? data?.data ?? [];
  console.log('Total bots returned:', items.length);

  const eqtyBots = items.filter((bot: any) => {
    const symbol = String(bot.symbol ?? bot.tradingPair ?? '').toUpperCase();
    return symbol.includes('EQTY');
  });

  console.log('EQTY bots after filter:', eqtyBots.length);
  return eqtyBots;
}

function mapBot(bot: any, owner: string, strategy: string) {
  console.log('Bot keys:', Object.keys(bot));

  return {
    owner,
    strategy,
    pair: 'EQTY/USDT',
    runtime: bot.runningTime ?? bot.runtime ?? '—',
    investment: parseFloat(bot.totalInvestment ?? bot.investment ?? 0),
    total_profit: parseFloat(bot.totalProfit ?? bot.profit ?? 0),
    total_profit_pct: parseFloat(bot.roi ?? 0),
    grid_profit: parseFloat(bot.gridProfit ?? 0),
    unrealized: parseFloat(bot.unrealizedPnl ?? bot.floatingProfit ?? 0),
    break_even: parseFloat(bot.breakEvenPrice ?? bot.breakEven ?? 0),
    range_low: parseFloat(bot.gridLowerPrice ?? bot.lowerPrice ?? 0),
    range_high: parseFloat(bot.gridUpperPrice ?? bot.upperPrice ?? 0),
    grid_balance: String(bot.activeGridNum ?? bot.gridCount ?? '—'),
    grid_apr: parseFloat(bot.gridApr ?? 0),
    apr: parseFloat(bot.apr ?? bot.annualizedReturn ?? 0),
    arb_24h: parseInt(bot.tradeCount24h ?? 0),
    arb_total: parseInt(bot.totalTradeCount ?? bot.totalTrades ?? 0),
    api_linked: true,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
      },
    });
  }

  try {
    const { owner, strategy, apiKey, apiSecret, apiPassphrase } = await req.json();

    if (!apiKey || !apiSecret || !apiPassphrase) {
      return new Response(JSON.stringify({ error: 'Missing API credentials' }), {
        status: 400,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    }

    console.log('SUPABASE_URL exists:', !!SUPABASE_URL);
    console.log('SERVICE_KEY exists:', !!SERVICE_KEY);

    const accountCheck = await kucoinRequest(
      'GET',
      '/api/v1/accounts?type=trade',
      apiKey,
      apiSecret,
      apiPassphrase
    );

    console.log('Account check:', JSON.stringify(accountCheck));

    if (accountCheck?.code !== '200000') {
      return new Response(
        JSON.stringify({
          error: `KuCoin auth failed: ${accountCheck?.msg ?? accountCheck?.code}`,
        }),
        {
          status: 401,
          headers: { 'Access-Control-Allow-Origin': '*' },
        }
      );
    }

    const bots = await fetchAllBots(apiKey, apiSecret, apiPassphrase);

    if (bots.length === 0) {
      return new Response(
        JSON.stringify({
          ok: true,
          synced: 0,
          note: 'No EQTY bots found on this account',
        }),
        {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }

    const supa = createClient(SUPABASE_URL, SERVICE_KEY);
    const results = [];

    for (const bot of bots) {
      const record = mapBot(bot, owner ?? 'Anonymous', strategy ?? 'Custom');
      const { data, error } = await supa.from('bots').insert(record).select().single();

      if (error) {
        console.error('DB insert error:', error.message);
        throw new Error(error.message);
      }

      results.push(data);
    }

    console.log('Synced bot count:', results.length);

    return new Response(JSON.stringify({ ok: true, synced: results.length }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    console.error('Unhandled error:', String(err));

    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }
});
