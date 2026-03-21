/**
 * Tracerrr — Beehiiv Sync
 * Vercel Cron: 0 7,12,18 * * * (3x daily)
 * Also callable manually: GET /api/beehiiv-sync?full=true
 */

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const NEWSLETTERS = [
  {
    slug: "bryan-brief",
    pubId: process.env.BEEHIIV_PUB_ID_BRYAN_BRIEF!,
    apiKey: process.env.BEEHIIV_API_KEY_BRYAN_BRIEF!,
  },
  {
    slug: "zire-golf",
    pubId: process.env.BEEHIIV_PUB_ID_ZIRE_GOLF!,
    apiKey: process.env.BEEHIIV_API_KEY_ZIRE_GOLF!,
  },
];

async function beehiivFetch(apiKey: string, url: string) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Beehiiv error ${res.status}: ${url}`);
  return res.json();
}

async function syncNewsletter(
  nlId: string,
  slug: string,
  pubId: string,
  apiKey: string,
  fullSync: boolean
) {
  // 1. Subscriber snapshot
  // Use expand[]=stats — field is data.stats.active_subscriptions
  const pub = await beehiivFetch(
    apiKey,
    `https://api.beehiiv.com/v2/publications/${pubId}?expand%5B%5D=stats`
  );

  const totalSubs = pub.data?.stats?.active_subscriptions ?? 0;
  const activeSubs = pub.data?.stats?.active_subscriptions ?? 0;

  // new_subscribers_7d: diff against snapshot from 7 days ago
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const { data: oldSnap } = await supabase
    .from("subscriber_snapshots")
    .select("total_subscribers")
    .eq("newsletter_id", nlId)
    .lte("date", sevenDaysAgo.toISOString().split("T")[0])
    .order("date", { ascending: false })
    .limit(1);

  const new7dCount = oldSnap?.[0]
    ? Math.max(0, totalSubs - (oldSnap[0].total_subscribers ?? 0))
    : 0;

  const today = new Date().toISOString().split("T")[0];
  await supabase.from("subscriber_snapshots").upsert(
    {
      newsletter_id: nlId,
      date: today,
      total_subscribers: totalSubs,
      active_subscribers: activeSubs,
      new_subscribers_7d: new7dCount,
      synced_from: "beehiiv",
    },
    { onConflict: "newsletter_id,date" }
  );


  // 2. Posts / sends
  const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000);
  let page = 1;
  let synced = 0;

  while (true) {
    const params = new URLSearchParams({
      limit: "100",
      page: String(page),
      expand: "stats",
      status: "confirmed",
      order_by: "publish_date",
      direction: "desc",
    });

    if (!fullSync) {
      params.set(
        "created_after",
        String(Math.floor(since48h.getTime() / 1000))
      );
    }

    const data = await beehiivFetch(
      apiKey,
      `https://api.beehiiv.com/v2/publications/${pubId}/posts?${params}`
    );

    const posts = data.data ?? [];
    if (posts.length === 0) break;

    const rows = posts
      .filter((p: Record<string, unknown>) => p.publish_date)
      .map((p: Record<string, unknown>) => {
        const emailStats = (p.stats as Record<string, Record<string, unknown>>)?.email ?? {};
        return {
          newsletter_id: nlId,
          beehiiv_post_id: p.id,
          send_date: new Date((p.publish_date as number) * 1000)
            .toISOString()
            .split("T")[0],
          subject_line: p.subject,
          preview_text: p.preview_text ?? null,
          subscribers_at_send: (emailStats.recipients as number) ?? null,
          delivered: (emailStats.delivered as number) ?? null,
          open_rate: emailStats.open_rate != null
            ? (emailStats.open_rate as number) / 100
            : null,
          click_rate: emailStats.click_rate != null
            ? (emailStats.click_rate as number)
            : null,
          unique_opens: (emailStats.unique_opens as number) ?? null,
          unique_clicks: (emailStats.unique_clicks as number) ?? null,
          unsubscribes: (emailStats.unsubscribes as number) ?? null,
          stats_last_synced_at: new Date().toISOString(),
        };
      });

    // Upsert in chunks of 50
    for (let i = 0; i < rows.length; i += 50) {
      await supabase
        .from("sends")
        .upsert(rows.slice(i, i + 50), { onConflict: "beehiiv_post_id" });
    }

    synced += rows.length;
    if (posts.length < 100) break;
    page++;
    await new Promise((r) => setTimeout(r, 300));
  }

  return { subscribers: totalSubs, active: activeSubs, sends_synced: synced };
}

export default async function handler(
  req: { method: string; url?: string; query: Record<string, string>; headers: Record<string, string> },
  res: { status: (n: number) => { json: (d: unknown) => void } }
) {
  const fullSync = req.query?.full === "true";

  const { data: newsletters } = await supabase
    .from("newsletters")
    .select("id, slug")
    .in("slug", NEWSLETTERS.map((n) => n.slug));

  if (!newsletters) {
    return res.status(500).json({ error: "Could not fetch newsletters" });
  }

  const results: Record<string, unknown> = {};
  const errors: string[] = [];

  for (const config of NEWSLETTERS) {
    const nl = newsletters.find((n) => n.slug === config.slug);
    if (!nl) { errors.push(`${config.slug} not found`); continue; }
    if (!config.pubId || !config.apiKey) { errors.push(`${config.slug} missing credentials`); continue; }

    try {
      results[config.slug] = await syncNewsletter(
        nl.id, config.slug, config.pubId, config.apiKey, fullSync
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${config.slug}: ${msg}`);
      results[config.slug] = { error: msg };
    }
  }

  return res.status(200).json({
    success: errors.length === 0,
    synced_at: new Date().toISOString(),
    full_sync: fullSync,
    results,
    errors,
  });
}
