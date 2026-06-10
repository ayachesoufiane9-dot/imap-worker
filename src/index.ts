import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

const PORT = Number(process.env.PORT ?? 8787);
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const userClient = (token: string) =>
  createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN ?? "*" }));
app.use(express.json());

// Gmail folder name → our enum
const GMAIL_FOLDERS: Record<string, string> = {
  INBOX: "inbox",
  "[Gmail]/Spam": "spam",
  "[Gmail]/All Mail": "all",
  "CATEGORY_PROMOTIONS": "promotions",
  "CATEGORY_SOCIAL": "social",
  "CATEGORY_UPDATES": "updates",
  "CATEGORY_FORUMS": "forums",
};

async function requireUser(req: express.Request) {
  const auth = req.header("authorization");
  if (!auth?.startsWith("Bearer ")) throw new Error("Unauthorized");
  const token = auth.slice(7);
  const { data, error } = await userClient(token).auth.getUser();
  if (error || !data.user) throw new Error("Unauthorized");
  return data.user.id;
}

function parseAuthResults(headers: string | undefined) {
  if (!headers) return { spf: null, dkim: null, dmarc: null };
  const ar = /Authentication-Results:[^\n]*\n(?:[ \t][^\n]*\n)*/i.exec(headers)?.[0] ?? "";
  const grab = (k: string) => new RegExp(`${k}=([a-z]+)`, "i").exec(ar)?.[1]?.toLowerCase() ?? null;
  return { spf: grab("spf"), dkim: grab("dkim"), dmarc: grab("dmarc") };
}

async function openImap(email: string, appPassword: string) {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: email, pass: appPassword },
    logger: false,
  });
  await client.connect();
  return client;
}

app.post("/api/accounts/validate", async (req, res) => {
  try {
    await requireUser(req);
    const { accountId } = req.body as { accountId: string };
    const { data: acc } = await supabase.from("gmail_accounts").select("*").eq("id", accountId).single();
    if (!acc) return res.status(404).json({ error: "not found" });
    try {
      const c = await openImap(acc.email, acc.app_password);
      await c.logout();
      await supabase.from("gmail_accounts").update({ status: "connected", error_message: null, last_validated_at: new Date().toISOString() }).eq("id", accountId);
      res.json({ ok: true });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const status = /AUTHENTICATIONFAILED|Invalid credentials/i.test(msg) ? "invalid_credentials"
        : /IMAP access|disabled/i.test(msg) ? "imap_disabled" : "error";
      await supabase.from("gmail_accounts").update({ status, error_message: msg.slice(0, 200) }).eq("id", accountId);
      res.json({ ok: false, error: msg });
    }
  } catch (e: any) { res.status(401).json({ error: e.message }); }
});

async function scanFolder(client: ImapFlow, mailbox: string, folderEnum: string, search: any, userId: string, searchId: string, accountId: string, accountEmail: string) {
  let lock;
  try {
    lock = await client.getMailboxLock(mailbox);
    const criteria: any = {};
    if (search.query_subject) criteria.subject = search.query_subject;
    if (search.query_from) criteria.from = search.query_from;
    if (search.query_keywords) criteria.body = search.query_keywords;
    if (search.after_date) criteria.since = new Date(search.after_date);
    else if (search.last_minutes) criteria.since = new Date(Date.now() - search.last_minutes * 60_000);
    if (search.before_date) criteria.before = new Date(search.before_date);

    for await (const msg of client.fetch(criteria, { envelope: true, headers: true, bodyStructure: false, source: false }) as any) {
      const headers = msg.headers?.toString();
      const auth = parseAuthResults(headers);
      await supabase.from("search_results").insert({
        user_id: userId, search_id: searchId, account_id: accountId, account_email: accountEmail,
        folder: folderEnum, message_id: msg.envelope?.messageId ?? null,
        subject: msg.envelope?.subject ?? null,
        from_address: msg.envelope?.from?.[0]?.address ?? null,
        to_address: msg.envelope?.to?.[0]?.address ?? null,
        received_at: msg.envelope?.date ?? null,
        spf: auth.spf, dkim: auth.dkim, dmarc: auth.dmarc,
        raw_headers: headers ?? null,
      });
    }
  } finally { lock?.release(); }
}

app.post("/api/search/start", async (req, res) => {
  try {
    const userId = await requireUser(req);
    const { searchId } = req.body as { searchId: string };
    const { data: search } = await supabase.from("searches").select("*").eq("id", searchId).single();
    if (!search) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });

    await supabase.from("searches").update({ status: "running", started_at: new Date().toISOString() }).eq("id", searchId);
    const { data: accs } = await supabase.from("gmail_accounts").select("*").in("id", search.account_ids);
    const folders = (search.folders as string[]).includes("all")
      ? ["INBOX", "[Gmail]/Spam", "[Gmail]/All Mail"]
      : (search.folders as string[]).map((f) => f === "inbox" ? "INBOX" : f === "spam" ? "[Gmail]/Spam" : "[Gmail]/All Mail");

    await Promise.all((accs ?? []).map(async (acc) => {
      try {
        const c = await openImap(acc.email, acc.app_password);
        await Promise.all(folders.map((mb) => scanFolder(c, mb, GMAIL_FOLDERS[mb] ?? "all", search, userId, searchId, acc.id, acc.email).catch(() => {})));
        await c.logout();
      } catch (e) { /* per-account error */ }
    }));

    await supabase.from("searches").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", searchId);
  } catch (e: any) { if (!res.headersSent) res.status(401).json({ error: e.message }); }
});

// Capture: simple poll loop until ends_at
const activeCaptures = new Set<string>();
app.post("/api/capture/start", async (req, res) => {
  try {
    const userId = await requireUser(req);
    const { captureId } = req.body as { captureId: string };
    res.json({ ok: true });
    activeCaptures.add(captureId);
    const { data: cap } = await supabase.from("captures").select("*").eq("id", captureId).single();
    if (!cap) return;
    const endTs = new Date(cap.ends_at).getTime();
    const { data: accs } = await supabase.from("gmail_accounts").select("*").in("id", cap.account_ids);

    while (Date.now() < endTs && activeCaptures.has(captureId)) {
      await Promise.all((accs ?? []).map(async (acc) => {
        try {
          const c = await openImap(acc.email, acc.app_password);
          await scanFolder(c, "INBOX", "inbox", { ...cap.criteria, last_minutes: 1 }, userId, captureId, acc.id, acc.email).catch(() => {});
          await c.logout();
        } catch {}
      }));
      await new Promise((r) => setTimeout(r, 20_000));
    }
    activeCaptures.delete(captureId);
    await supabase.from("captures").update({ status: "completed" }).eq("id", captureId);
  } catch (e: any) { if (!res.headersSent) res.status(401).json({ error: e.message }); }
});

app.post("/api/capture/stop", async (req, res) => {
  try { await requireUser(req); activeCaptures.delete((req.body as any).captureId); res.json({ ok: true }); }
  catch (e: any) { res.status(401).json({ error: e.message }); }
});

app.get("/health", (_req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`IMAP worker listening on ${PORT}`));