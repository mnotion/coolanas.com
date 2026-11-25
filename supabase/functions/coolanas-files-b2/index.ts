import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "npm:@aws-sdk/client-s3@3.1164.0";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner@3.1164.0";

const cors = {
  "Access-Control-Allow-Origin": "https://coolanas.com",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};
const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || name.length > 180 || name === "." || name === ".." ||
      /[\/\\\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}
function cleanId(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}
function validUsername(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const length = [...value].length;
  if (length < 4 || length > 100 || /\s/u.test(value)) return false;
  if(/[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u20E3]/u.test(value)) return false;
  return true;
}
function copySource(bucket: string, key: string) {
  return "/" + bucket + "/" + key.split("/").map(encodeURIComponent).join("/");
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (origin && origin !== "https://coolanas.com") return json(403, { error: "Origin not allowed." });
  if (req.method !== "POST") return json(405, { error: "POST required." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const keyId = Deno.env.get("B2_KEY_ID") ?? "";
  const appKey = Deno.env.get("B2_APPLICATION_KEY") ?? "";
  const bucket = Deno.env.get("COOLANAS_FILES_B2_BUCKET") ?? "";
  const endpoint = Deno.env.get("B2_ENDPOINT") ?? "";
  if (![supabaseUrl, anonKey, keyId, appKey, bucket, endpoint].every(Boolean)) {
    return json(503, { error: "Files storage is not fully configured." });
  }
  let endpointUrl: URL;
  try { endpointUrl = new URL(endpoint); } catch { return json(503, { error: "B2 endpoint is invalid." }); }
  if (endpointUrl.protocol !== "https:" || endpointUrl.hostname !== "s3.eu-central-003.backblazeb2.com") {
    return json(503, { error: "B2 endpoint does not match the configured region." });
  }

  const authorization = req.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) return json(401, { error: "Sign-in required." });

  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: "Bearer " + token } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  const user = authData.user;
  if (authError || !user) return json(401, { error: "Your session is invalid. Sign in again." });
  const userId = user.id;

  const { data: profile, error: profileError } = await supabase.from("profiles").select("username").eq("id", userId).maybeSingle();
  if (profileError) return json(500, { error: "Could not load your account profile." });
  const username = profile?.username;
  if (!validUsername(username)) return json(409, { error: "Choose a valid username before using files." });
  const prefix = "userdata/" + encodeURIComponent(username) + "_" + user.id;
  const legacyMeta = user.user_metadata ?? {};
  const legacyCandidate = [legacyMeta.username, legacyMeta.user_name, legacyMeta.full_name, legacyMeta.name, typeof user.email === "string" ? user.email.split("@")[0] : ""]
    .find((value) => typeof value === "string" && value.trim()) as string | undefined;
  const legacySlug = (legacyCandidate ?? "user").normalize("NFKD").replace(/[\\u0300-\\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "user";
  const legacyNamedPrefix = "userdata/" + legacySlug + "_" + user.id;
  const s3 = new S3Client({
    region: "eu-central-003",
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: keyId, secretAccessKey: appKey },
  });
  const legacyUserPrefix = "userdata/" + user.id + "/";
  const belongsToUserPath = (key: unknown) =>
    typeof key === "string" && (key.startsWith(prefix + "/") || key.startsWith(legacyNamedPrefix + "/") || key.startsWith(legacyUserPrefix));

  let actionForLog = "request";
  try {
    const body = await req.json();
    const action = body?.action;
    actionForLog = typeof action === "string" ? action : "unknown";
    const profilePictureKey = prefix + "/assets/settings/profile-picture.png";

    const withAnalyticsWriteLock = async (
      work: () => Promise<Response>
    ): Promise<Response> => {
      const lockToken = crypto.randomUUID();
      let acquired = false;
      for (let attempt = 0; attempt < 25; attempt++) {
        const {data, error} = await supabase.rpc("coolanas_try_analytics_sync_lock", {
          p_token: lockToken, p_ttl_seconds: 30
        });
        if (error) throw error;
        if (data === true) {
          acquired = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 120));
      }
      if (!acquired) {
        return json(503, { error: "Analytics is syncing from another device. Please retry in a few seconds." });
      }
      try {
        return await work();
      } finally {
        const {error} = await supabase.rpc("coolanas_release_analytics_sync_lock", {
          p_token: lockToken
        });
        if (error) console.warn("Could not release analytics sync lock:", error.message);
      }
    };

    const isRecord = (value: unknown): value is Record<string, any> =>
      Boolean(value && typeof value === "object" && !Array.isArray(value));
    const isB2NotFound = (error: any) =>
      error?.$metadata?.httpStatusCode === 404 ||
      error?.name === "NoSuchKey" || error?.name === "NotFound";
    const isB2ReadCapExceeded = (error: any) => {
      const message = String(error?.message || error || "");
      return /download bandwidth|Class B.*cap exceeded|download_cap_exceeded/i.test(message);
    };
    const shouldRetryB2Import = (checkedAt: unknown) => {
      if (typeof checkedAt !== "string") return true;
      const checked = Date.parse(checkedAt);
      return !Number.isFinite(checked) || Date.now() - checked >= 5 * 60 * 1000;
    };
    const readB2Json = async (key: string) => {
      try {
        const object = await s3.send(new GetObjectCommand({Bucket:bucket,Key:key}));
        const raw = await object.Body?.transformToString();
        const parsed = raw ? JSON.parse(raw) : {};
        return {found:true,blocked:false,value:isRecord(parsed) ? parsed : {}};
      } catch (error) {
        if (isB2NotFound(error)) return {found:false,blocked:false,value:{}};
        if (isB2ReadCapExceeded(error)) return {found:false,blocked:true,value:{}};
        throw error;
      }
    };
    const writeB2Json = async (key: string, value: Record<string, unknown>) => {
      await s3.send(new PutObjectCommand({
        Bucket:bucket,Key:key,Body:JSON.stringify(value),
        ContentType:"application/json; charset=utf-8"
      }));
    };
    const readAccountSyncRow = async () => {
      const {data,error} = await supabase.from("coolanas_dashboard_data")
        .select("settings_json, settings_b2_migrated, settings_b2_checked_at, settings_b2_mirror_pending, analytics_json, analytics_b2_migrated, analytics_b2_checked_at, analytics_b2_mirror_pending")
        .eq("user_id",userId).maybeSingle();
      if (error) throw error;
      return data;
    };
    const saveSettingsState = async (
      settings: Record<string, unknown> | null, migrated: boolean, checkedAt: string,
      mirrorPending = false
    ) => {
      const {error} = await supabase.from("coolanas_dashboard_data").upsert({
        user_id:userId,settings_json:settings,settings_b2_migrated:migrated,
        settings_b2_checked_at:checkedAt,settings_b2_mirror_pending:mirrorPending,
        updated_at:new Date().toISOString()
      },{onConflict:"user_id"});
      if (error) throw error;
    };
    const emptyAnalyticsDoc = () => ({
      version:4,daily:{},dailySubjects:{},dailyHours:{},events:{}
    });
    const normaliseAnalyticsDoc = (value: unknown) => {
      const source = isRecord(value) ? value : {};
      return {
        version:4,
        daily:isRecord(source.daily) ? source.daily : {},
        dailySubjects:isRecord(source.dailySubjects) ? source.dailySubjects : {},
        dailyHours:isRecord(source.dailyHours) ? source.dailyHours : {},
        events:isRecord(source.events) ? source.events : {},
        ...(typeof source.updatedAt === "string" ? {updatedAt:source.updatedAt} : {})
      };
    };
    const mergeAnalyticsDocs = (currentValue: unknown, legacyValue: unknown) => {
      const current = normaliseAnalyticsDoc(currentValue);
      const legacy = normaliseAnalyticsDoc(legacyValue);
      for (const [date,value] of Object.entries(legacy.daily)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(date) && typeof value === "number" && Number.isFinite(value) && value >= 0)
          current.daily[date] = Math.max(0,Number(current.daily[date]) || 0,value);
      }
      for (const [date,subjects] of Object.entries(legacy.dailySubjects)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isRecord(subjects)) continue;
        if (!isRecord(current.dailySubjects[date])) current.dailySubjects[date] = {};
        for (const [subject,value] of Object.entries(subjects)) {
          if (subject.length <= 80 && typeof value === "number" && Number.isFinite(value) && value >= 0)
            current.dailySubjects[date][subject] = Math.max(0,Number(current.dailySubjects[date][subject]) || 0,value);
        }
      }
      for (const [date,hours] of Object.entries(legacy.dailyHours)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isRecord(hours)) continue;
        if (!isRecord(current.dailyHours[date])) current.dailyHours[date] = {};
        for (const [hour,value] of Object.entries(hours)) {
          if (/^(?:[0-9]|1[0-9]|2[0-3])$/.test(hour) && typeof value === "number" && Number.isFinite(value) && value >= 0)
            current.dailyHours[date][hour] = Math.max(0,Number(current.dailyHours[date][hour]) || 0,value);
        }
      }
      for (const [eventId,value] of Object.entries(legacy.events)) {
        if (value === true) current.events[eventId] = true;
      }
      return current;
    };
    const saveAnalyticsState = async (
      analytics: Record<string, unknown>, migrated: boolean, checkedAt: string,
      mirrorPending = false
    ) => {
      const {error} = await supabase.from("coolanas_dashboard_data").upsert({
        user_id:userId,analytics_json:analytics,analytics_b2_migrated:migrated,
        analytics_b2_checked_at:checkedAt,analytics_b2_mirror_pending:mirrorPending,
        updated_at:new Date().toISOString()
      },{onConflict:"user_id"});
      if (error) throw error;
    };
    const mergeLegacySnapshot = (
      current: ReturnType<typeof normaliseAnalyticsDoc>, snapshot: any,
      validDate: (value: unknown) => value is string
    ) => {
      if (!snapshot) return;
      const daily = snapshot.daily;
      const dailySubjects = snapshot.dailySubjects;
      const dailyHours = snapshot.dailyHours;
      for (const [date,value] of Object.entries(isRecord(daily) ? daily : {})) {
        if (validDate(date) && typeof value === "number" && Number.isFinite(value) && value >= 0)
          current.daily[date] = Math.max(0,Number(current.daily[date]) || 0,value);
      }
      for (const [date,subjects] of Object.entries(isRecord(dailySubjects) ? dailySubjects : {})) {
        if (!validDate(date) || !isRecord(subjects)) continue;
        if (!isRecord(current.dailySubjects[date])) current.dailySubjects[date] = {};
        for (const [subject,value] of Object.entries(subjects)) {
          if (subject && subject.length <= 80 && typeof value === "number" && Number.isFinite(value) && value >= 0)
            current.dailySubjects[date][subject] = Math.max(0,Number(current.dailySubjects[date][subject]) || 0,value);
        }
      }
      for (const [date,hours] of Object.entries(isRecord(dailyHours) ? dailyHours : {})) {
        if (!validDate(date) || !isRecord(hours)) continue;
        if (!isRecord(current.dailyHours[date])) current.dailyHours[date] = {};
        for (const [hour,value] of Object.entries(hours)) {
          if (/^(?:[0-9]|1[0-9]|2[0-3])$/.test(hour) && typeof value === "number" && Number.isFinite(value) && value >= 0)
            current.dailyHours[date][hour] = Math.max(0,Number(current.dailyHours[date][hour]) || 0,value);
        }
      }
    };

    if (action === "settings_get") {
      const key = prefix + "/stats/settings.json";
      const initial = await readAccountSyncRow();
      if (initial?.settings_b2_migrated === true && isRecord(initial.settings_json)) {
        let mirrorPending = initial.settings_b2_mirror_pending === true;
        if (mirrorPending && shouldRetryB2Import(initial.settings_b2_checked_at)) {
          const now = new Date().toISOString();
          try {
            await writeB2Json(key,initial.settings_json);
            mirrorPending = false;
          } catch (error) {
            console.warn("Could not retry the settings JSON mirror:",error);
          }
          await saveSettingsState(initial.settings_json,true,now,mirrorPending);
        }
        return json(200,{success:true,settings:initial.settings_json,created:false,legacyImportPending:false,mirrorPending});
      }
      if (!shouldRetryB2Import(initial?.settings_b2_checked_at)) {
        if (!isRecord(initial?.settings_json)) {
          return json(503,{error:"Account settings are queued for their first cloud import. Retry shortly."});
        }
        return json(200,{success:true,settings:initial.settings_json,created:false,legacyImportPending:true});
      }
      return await withAnalyticsWriteLock(async () => {
        const row = await readAccountSyncRow();
        if (row?.settings_b2_migrated === true && isRecord(row.settings_json)) {
          let mirrorPending = row.settings_b2_mirror_pending === true;
          if (mirrorPending && shouldRetryB2Import(row.settings_b2_checked_at)) {
            const now = new Date().toISOString();
            try {
              await writeB2Json(key,row.settings_json);
              mirrorPending = false;
            } catch (error) {
              console.warn("Could not retry the settings JSON mirror:",error);
            }
            await saveSettingsState(row.settings_json,true,now,mirrorPending);
          }
          return json(200,{success:true,settings:row.settings_json,created:false,legacyImportPending:false,mirrorPending});
        }
        if (!shouldRetryB2Import(row?.settings_b2_checked_at) && isRecord(row?.settings_json)) {
          return json(200,{success:true,settings:row.settings_json,created:false,legacyImportPending:true});
        }
        const legacy = await readB2Json(key);
        const now = new Date().toISOString();
        if (legacy.blocked) {
          await saveSettingsState(isRecord(row?.settings_json) ? row.settings_json : null,false,now,true);
          if (!isRecord(row?.settings_json)) {
            return json(503,{error:"Backblaze's daily download cap is reached. Account settings will retry automatically after it resets."});
          }
          return json(200,{success:true,settings:row.settings_json,created:false,legacyImportPending:true});
        }
        const existing = isRecord(row?.settings_json) ? row.settings_json : {};
        const settings = {...legacy.value,...existing};
        if (!settings.version) settings.version = 1;
        if (!settings.createdAt) settings.createdAt = now;
        settings.updatedAt = now;
        let mirrorPending = true;
        await saveSettingsState(settings,true,now,mirrorPending);
        try {
          await writeB2Json(key,settings);
          mirrorPending = false;
          await saveSettingsState(settings,true,new Date().toISOString(),false);
        } catch (error) {
          console.warn("Settings were saved to the account database; B2 JSON mirror will retry:",error);
          await saveSettingsState(settings,true,new Date().toISOString(),true);
        }
        return json(200,{
          success:true,settings,created:!legacy.found && !Object.keys(existing).length,
          legacyImportPending:false,mirrorPending
        });
      });
    }

    if (action === "settings_update") {
      const incoming = body?.settings;
      if (!isRecord(incoming) || JSON.stringify(incoming).length > 20000) {
        return json(400,{error:"Invalid settings payload."});
      }
      for (const [setting,value] of Object.entries(incoming)) {
        if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(setting))
          return json(400,{error:"Invalid setting name."});
        if (setting === "theme" && value !== "light" && value !== "dark")
          return json(400,{error:"Theme must be light or dark."});
      }
      return await withAnalyticsWriteLock(async () => {
        const key = prefix + "/stats/settings.json";
        const row = await readAccountSyncRow();
        let saved = isRecord(row?.settings_json) ? {...row.settings_json} : {};
        let migrated = row?.settings_b2_migrated === true;
        let checkedAt = typeof row?.settings_b2_checked_at === "string" ? row.settings_b2_checked_at : null;
        let mirrorPending = row?.settings_b2_mirror_pending === true || !migrated;
        if (!migrated && shouldRetryB2Import(checkedAt)) {
          const legacy = await readB2Json(key);
          checkedAt = new Date().toISOString();
          if (!legacy.blocked) {
            saved = {...legacy.value,...saved};
            migrated = true;
            mirrorPending = true;
          }
        }
        const now = new Date().toISOString();
        if (!saved.createdAt) saved.createdAt = now;
        for (const [setting,value] of Object.entries(incoming)) saved[setting] = value;
        saved.version = 1;
        saved.updatedAt = now;
        const saveCheckedAt = checkedAt || now;
        await saveSettingsState(saved,migrated,saveCheckedAt,mirrorPending);
        const shouldMirror = migrated &&
          (!row?.settings_b2_mirror_pending || shouldRetryB2Import(checkedAt));
        if (shouldMirror) {
          const mirrorAttemptAt = new Date().toISOString();
          try {
            await writeB2Json(key,saved);
            mirrorPending = false;
          } catch (error) {
            mirrorPending = true;
            console.warn("Settings are safe in the account database; B2 JSON mirror will retry:",error);
          }
          await saveSettingsState(saved,true,mirrorAttemptAt,mirrorPending);
        }
        return json(200,{success:true,settings:saved,legacyImportPending:!migrated,mirrorPending});
      });
    }

    if (action === "analytics_get") {
      const key = prefix + "/stats/analytics.json";
      const initial = await readAccountSyncRow();
      if (initial?.analytics_b2_migrated === true && isRecord(initial.analytics_json)) {
        let saved = normaliseAnalyticsDoc(initial.analytics_json);
        let mirrorPending = initial.analytics_b2_mirror_pending === true;
        if (mirrorPending && shouldRetryB2Import(initial.analytics_b2_checked_at)) {
          return await withAnalyticsWriteLock(async () => {
            const row = await readAccountSyncRow();
            saved = normaliseAnalyticsDoc(row?.analytics_json);
            mirrorPending = row?.analytics_b2_mirror_pending === true;
            if (mirrorPending && shouldRetryB2Import(row?.analytics_b2_checked_at)) {
              const mirrorAttemptAt = new Date().toISOString();
              try {
                await writeB2Json(key,saved);
                mirrorPending = false;
              } catch (error) {
                console.warn("Could not retry the analytics JSON mirror:",error);
              }
              await saveAnalyticsState(saved,true,mirrorAttemptAt,mirrorPending);
            }
            const totalMs = Object.values(saved.daily).reduce((sum:number,value:any)=>
              sum + (Number.isFinite(value) ? Math.max(0,Number(value)) : 0),0);
            return json(200,{
              success:true,daily:saved.daily,dailySubjects:saved.dailySubjects,
              dailyHours:saved.dailyHours,totalMs,legacyImportPending:false,mirrorPending
            });
          });
        }
        const totalMs = Object.values(saved.daily).reduce((sum:number,value:any)=>
          sum + (Number.isFinite(value) ? Math.max(0,Number(value)) : 0),0);
        return json(200,{
          success:true,daily:saved.daily,dailySubjects:saved.dailySubjects,
          dailyHours:saved.dailyHours,totalMs,legacyImportPending:false,mirrorPending
        });
      }
      if (!shouldRetryB2Import(initial?.analytics_b2_checked_at)) {
        const saved = normaliseAnalyticsDoc(initial?.analytics_json);
        const totalMs = Object.values(saved.daily).reduce((sum:number,value:any)=>
          sum + (Number.isFinite(value) ? Math.max(0,Number(value)) : 0),0);
        return json(200,{
          success:true,daily:saved.daily,dailySubjects:saved.dailySubjects,
          dailyHours:saved.dailyHours,totalMs,legacyImportPending:true
        });
      }
      return await withAnalyticsWriteLock(async () => {
        const row = await readAccountSyncRow();
        let saved = normaliseAnalyticsDoc(row?.analytics_json);
        let migrated = row?.analytics_b2_migrated === true;
        let checkedAt = typeof row?.analytics_b2_checked_at === "string" ? row.analytics_b2_checked_at : null;
        let mirrorPending = row?.analytics_b2_mirror_pending === true || !migrated;
        if (!migrated && shouldRetryB2Import(checkedAt)) {
          const legacy = await readB2Json(key);
          checkedAt = new Date().toISOString();
          if (legacy.blocked) {
            await saveAnalyticsState(saved,false,checkedAt,true);
            const totalMs = Object.values(saved.daily).reduce((sum:number,value:any)=>
              sum + (Number.isFinite(value) ? Math.max(0,Number(value)) : 0),0);
            return json(200,{
              success:true,daily:saved.daily,dailySubjects:saved.dailySubjects,
              dailyHours:saved.dailyHours,totalMs,legacyImportPending:true,
              readCapExceeded:true,mirrorPending:true
            });
          }
          if (legacy.found) saved = mergeAnalyticsDocs(saved,legacy.value);
          migrated = true;
          mirrorPending = true;
        }
        const now = new Date().toISOString();
        saved.updatedAt = now;
        await saveAnalyticsState(saved,migrated,checkedAt || now,mirrorPending);
        if (migrated && (!row?.analytics_b2_mirror_pending || shouldRetryB2Import(checkedAt))) {
          const mirrorAttemptAt = new Date().toISOString();
          try {
            await writeB2Json(key,saved);
            mirrorPending = false;
          } catch (error) {
            mirrorPending = true;
            console.warn("Analytics are safe in the account database; B2 JSON mirror will retry:",error);
          }
          await saveAnalyticsState(saved,true,mirrorAttemptAt,mirrorPending);
        }
        const totalMs = Object.values(saved.daily).reduce((sum:number,value:any)=>
          sum + (Number.isFinite(value) ? Math.max(0,Number(value)) : 0),0);
        return json(200,{
          success:true,daily:saved.daily,dailySubjects:saved.dailySubjects,
          dailyHours:saved.dailyHours,totalMs,legacyImportPending:!migrated,mirrorPending
        });
      });
    }

    const syncAnalyticsDocuments = async (records: any[], snapshot: any) => {
      const key = prefix + "/stats/analytics.json";
      const validDate = (value: unknown): value is string => {
        if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
        const parsed = new Date(value + "T00:00:00.000Z");
        return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0,10) === value;
      };
      return await withAnalyticsWriteLock(async () => {
        const row = await readAccountSyncRow();
        let saved = normaliseAnalyticsDoc(row?.analytics_json);
        let migrated = row?.analytics_b2_migrated === true;
        let checkedAt = typeof row?.analytics_b2_checked_at === "string" ? row.analytics_b2_checked_at : null;
        let mirrorPending = row?.analytics_b2_mirror_pending === true || !migrated;
        if (!migrated && shouldRetryB2Import(checkedAt)) {
          const legacy = await readB2Json(key);
          checkedAt = new Date().toISOString();
          if (!legacy.blocked) {
            if (legacy.found) saved = mergeAnalyticsDocs(saved,legacy.value);
            migrated = true;
            mirrorPending = true;
          } else {
            mirrorPending = true;
          }
        }

        let accepted = 0,duplicates = 0;
        const seen = new Set<string>();
        for (const record of records) {
          if (!record || !validDate(record.date) ||
              !Number.isSafeInteger(record.durationMs) || record.durationMs <= 0 ||
              record.durationMs > 604800000 ||
              typeof record.eventId !== "string" ||
              !/^[A-Za-z0-9_-]{8,120}$/.test(record.eventId) ||
              seen.has(record.eventId)) {
            return json(400,{error:"One or more analytics records are invalid."});
          }
          seen.add(record.eventId);
          if (saved.events[record.eventId] === true) {
            duplicates++;
            continue;
          }
          const subject = typeof record.subject === "string" && record.subject.trim()
            ? record.subject.trim().slice(0,80) : "Unassigned";
          saved.daily[record.date] = Math.max(0,Number(saved.daily[record.date]) || 0) + record.durationMs;
          if (!isRecord(saved.dailySubjects[record.date])) saved.dailySubjects[record.date] = {};
          saved.dailySubjects[record.date][subject] =
            Math.max(0,Number(saved.dailySubjects[record.date][subject]) || 0) + record.durationMs;
          if (isRecord(record.hourlyMs)) {
            if (!isRecord(saved.dailyHours[record.date])) saved.dailyHours[record.date] = {};
            for (const [hour,value] of Object.entries(record.hourlyMs)) {
              if (/^(?:[0-9]|1[0-9]|2[0-3])$/.test(hour) &&
                  typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
                saved.dailyHours[record.date][hour] =
                  Math.max(0,Number(saved.dailyHours[record.date][hour]) || 0) + value;
              }
            }
          }
          saved.events[record.eventId] = true;
          accepted++;
        }
        if (snapshot) mergeLegacySnapshot(saved,snapshot,validDate);
        const updatedAt = new Date().toISOString();
        saved.updatedAt = updatedAt;
        await saveAnalyticsState(saved,migrated,checkedAt || updatedAt,mirrorPending);
        if (migrated && (!row?.analytics_b2_mirror_pending || shouldRetryB2Import(checkedAt))) {
          const mirrorAttemptAt = new Date().toISOString();
          try {
            await writeB2Json(key,saved);
            mirrorPending = false;
          } catch (error) {
            mirrorPending = true;
            console.warn("Analytics sync saved to the account database; B2 JSON mirror will retry:",error);
          }
          await saveAnalyticsState(saved,true,mirrorAttemptAt,mirrorPending);
        }
        const totalMs = Object.values(saved.daily).reduce((sum:number,value:any)=>
          sum + (Number.isFinite(value) ? Math.max(0,Number(value)) : 0),0);
        return json(200,{
          success:true,accepted,duplicates,daily:saved.daily,
          dailySubjects:saved.dailySubjects,dailyHours:saved.dailyHours,
          totalMs,updatedAt,legacyImportPending:!migrated,mirrorPending
        });
      });
    };

    if (action === "analytics_record") {
      const date = body?.date;
      const durationMs = body?.durationMs;
      const eventId = body?.eventId;
      if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          !Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > 604800000 ||
          typeof eventId !== "string" || !/^[A-Za-z0-9_-]{8,120}$/.test(eventId)) {
        return json(400,{error:"Invalid study-time record."});
      }
      return await syncAnalyticsDocuments([{
        date,durationMs,eventId,subject:body?.subject,hourlyMs:body?.hourlyMs
      }],null);
    }

    if (action === "analytics_sync") {
      const records = body.records == null ? [] : body.records;
      const snapshot = body.snapshot == null ? null : body.snapshot;
      if (!Array.isArray(records) || records.length > 100 ||
          (snapshot !== null && (!isRecord(snapshot) || JSON.stringify(snapshot).length > 1500000))) {
        return json(400,{error:"Invalid analytics sync payload."});
      }
      return await syncAnalyticsDocuments(records,snapshot);
    }

    if (action === "profile_picture_get") {
      for (const key of [prefix + "/assets/settings/profile-picture.gif", profilePictureKey]) {
        try {
          await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
          const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 300 });
          return json(200, { exists: true, url, contentType: key.endsWith(".gif") ? "image/gif" : "image/png" });
        } catch { /* Try the next supported format. */ }
      }
      return json(200, { exists: false, url: null });
    }

    if (action === "profile_picture_directory") {
      const { data: directory, error: directoryError } = await supabase.rpc("coolanas_public_usernames");
      if (directoryError || !Array.isArray(directory)) return json(500, { error: "Could not load the user directory." });
      const users = await Promise.all(directory.map(async (entry: { user_id: string; username: string | null; google_avatar: string | null }) => {
        const userPrefix = "userdata/" + encodeURIComponent(entry.username || "user") + "_" + entry.user_id;
        let pictureUrl: string | null = null;
        for (const extension of ["gif", "png"]) {
          const key = userPrefix + "/assets/settings/profile-picture." + extension;
          try {
            await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
            pictureUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 900 });
            break;
          } catch { /* No custom picture in this format. */ }
        }
        return { username: entry.username, pictureUrl, googleAvatar: entry.google_avatar };
      }));
      return json(200, { users });
    }

    if (action === "profile_picture_upload") {
      const contentType = body?.contentType;
      const extension = contentType === "image/gif" ? "gif" : contentType === "image/png" ? "png" : null;
      if (!extension) return json(400, { error: "Profile pictures must be PNG or GIF files." });
      const key = prefix + "/assets/settings/profile-picture." + extension;
      const url = await getSignedUrl(s3, new PutObjectCommand({
        Bucket: bucket, Key: key, ContentType: contentType,
      }), { expiresIn: 300 });
      return json(200, { uploadUrl: url, contentType });
    }

    if (action === "profile_picture_delete") {
      await Promise.all(["png", "gif"].map(extension =>
        s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: prefix + "/assets/settings/profile-picture." + extension }))
      ));
      return json(200, { success: true, exists: false });
    }

    if (action === "username_update") {
      const newUsername = body?.username;
      if (!validUsername(newUsername)) {
        return json(400, { error: "Usernames must be 4–100 characters, with no spaces or emojis." });
      }
      if (newUsername === username) return json(200, { success: true, username });

      const newPrefix = "userdata/" + encodeURIComponent(newUsername) + "_" + userId;
      let oldObjects: string[] = [];
      let continuationToken: string | undefined;
      do {
        const page = await s3.send(new ListObjectsV2Command({
          Bucket: bucket, Prefix: prefix + "/", ContinuationToken: continuationToken, MaxKeys: 1000,
        }));
        oldObjects.push(...(page.Contents ?? []).map((item) => item.Key).filter((key): key is string => Boolean(key)));
        continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (continuationToken);

      const destinationCheck = await s3.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: newPrefix + "/", MaxKeys: 1,
      }));
      if ((destinationCheck.Contents ?? []).length) {
        return json(409, { error: "That username already has storage associated with it. Choose another username." });
      }

      const copiedKeys: string[] = [];
      let databaseUpdated = false;
      try {
        for (const oldKey of oldObjects) {
          const newKey = newPrefix + oldKey.slice(prefix.length);
          await s3.send(new CopyObjectCommand({
            Bucket: bucket, CopySource: copySource(bucket, oldKey), Key: newKey,
          }));
          copiedKeys.push(newKey);
        }

        const { error: usernameError } = await supabase.from("profiles")
          .update({ username: newUsername }).eq("id", userId);
        if (usernameError) throw usernameError;

        const { error: prefixError } = await supabase.rpc("coolanas_update_storage_prefix", {
          p_old_prefix: prefix, p_new_prefix: newPrefix,
        });
        if (prefixError) throw prefixError;
        databaseUpdated = true;
      } catch (error) {
        // Restore database paths and the original username before removing copied objects.
        if (databaseUpdated) {
          await supabase.rpc("coolanas_update_storage_prefix", {
            p_old_prefix: newPrefix, p_new_prefix: prefix,
          });
        }
        await supabase.from("profiles").update({ username }).eq("id", userId);
        for (let offset = 0; offset < copiedKeys.length; offset += 1000) {
          const batch = copiedKeys.slice(offset, offset + 1000);
          if (batch.length) await s3.send(new DeleteObjectsCommand({
            Bucket: bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }));
        }
        throw error;
      }

      // Database paths now point at the new prefix. Old-object cleanup is best-effort:
      // a cleanup failure must not roll back the new username or delete the new copies.
      try {
        for (let offset = 0; offset < oldObjects.length; offset += 1000) {
          const batch = oldObjects.slice(offset, offset + 1000);
          if (batch.length) await s3.send(new DeleteObjectsCommand({
            Bucket: bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }));
        }
      } catch (cleanupError) {
        console.error("Old username storage cleanup failed:", cleanupError);
      }
      return json(200, { success: true, username: newUsername });
    }

    if (action === "bucket_share_users") {
      const { data: directory, error } = await supabase.rpc("coolanas_public_usernames");
      if (error || !Array.isArray(directory)) throw new Error("Could not load Coolanas users.");
      const users = directory
        .filter((entry: any) => entry.user_id !== userId && validUsername(entry.username))
        .map((entry: any) => ({ userId: entry.user_id, username: entry.username }));
      return json(200, { users });
    }

    if (action === "bucket_share_invite") {
      const bucketId = cleanId(body.bucketId);
      const recipientId = cleanId(body.recipientId);
      if (!bucketId || !recipientId) return json(400, { error: "Choose a valid bucket and Coolanas user." });
      const { data, error } = await supabase.rpc("coolanas_create_bucket_invitation", {
        p_bucket_id: bucketId,
        p_recipient_id: recipientId,
      });
      if (error) return json(400, { error: error.message });
      return json(200, { success: true, invitationId: data });
    }

    if (action === "bucket_share_owner_list") {
      const bucketId = cleanId(body.bucketId);
      if (!bucketId) return json(400, { error: "Invalid bucket." });
      const [{ data: shares, error: shareError }, { data: invitations, error: invitationError }, { data: directory, error: directoryError }] = await Promise.all([
        supabase.from("bucket_shares").select("id,bucket_id,recipient_id,created_at,permission")
          .eq("owner_id", userId).eq("bucket_id", bucketId).is("revoked_at", null),
        supabase.from("bucket_share_invitations").select("id,bucket_id,recipient_id,status,created_at")
          .eq("owner_id", userId).eq("bucket_id", bucketId).eq("status", "pending"),
        supabase.rpc("coolanas_public_usernames"),
      ]);
      if (shareError || invitationError || directoryError || !Array.isArray(directory)) {
        throw new Error("Could not load this bucket's sharing settings.");
      }
      const usernames = new Map(directory.map((entry: any) => [entry.user_id, entry.username]));
      return json(200, {
        shares: (shares ?? []).map((share: any) => ({
          id: share.id, recipientId: share.recipient_id,
          username: usernames.get(share.recipient_id) || "Coolanas user",
          createdAt: share.created_at, status: "accepted", permission: share.permission || "view_download",
        })),
        invitations: (invitations ?? []).map((invitation: any) => ({
          id: invitation.id, recipientId: invitation.recipient_id,
          username: usernames.get(invitation.recipient_id) || "Coolanas user",
          createdAt: invitation.created_at, status: "pending",
        })),
      });
    }

    if (action === "bucket_share_revoke") {
      const bucketId = cleanId(body.bucketId);
      const recipientId = cleanId(body.recipientId);
      if (!bucketId || !recipientId) return json(400, { error: "Invalid share." });
      const { data, error } = await supabase.rpc("coolanas_revoke_bucket_share", {
        p_bucket_id: bucketId, p_recipient_id: recipientId,
      });
      if (error) return json(400, { error: error.message });
      return json(200, { success: data === true });
    }

    if (action === "bucket_share_permission_update") {
      const bucketId = cleanId(body.bucketId);
      const recipientId = cleanId(body.recipientId);
      const permission = body.permission;
      if (!bucketId || !recipientId || (permission !== "view" && permission !== "view_download")) {
        return json(400, { error: "Choose a valid bucket permission." });
      }
      const { data, error } = await supabase.rpc("coolanas_update_bucket_share_permission", {
        p_bucket_id: bucketId, p_recipient_id: recipientId, p_permission: permission,
      });
      if (error) return json(400, { error: error.message });
      return json(200, { success: data === true });
    }

    if (action === "shared_buckets_list") {
      const [
        { data: receivedShares, error: receivedError },
        { data: ownedShares, error: ownedError },
        { data: directory, error: directoryError },
      ] = await Promise.all([
        supabase.from("bucket_shares").select("id,bucket_id,owner_id,created_at,permission")
          .eq("recipient_id", userId).is("revoked_at", null).order("created_at", { ascending: false }),
        supabase.from("bucket_shares").select("id,bucket_id,owner_id,recipient_id,created_at,permission")
          .eq("owner_id", userId).is("revoked_at", null).order("created_at", { ascending: false }),
        supabase.rpc("coolanas_public_usernames"),
      ]);
      if (receivedError || ownedError || directoryError || !Array.isArray(directory)) {
        throw new Error("Could not load shared buckets.");
      }
      const usernames = new Map(directory.map((entry: any) => [entry.user_id, entry.username]));
      const buckets = [];
      for (const share of receivedShares ?? []) {
        const { data: bucketRow, error: bucketError } = await supabase.from("coolanas_files")
          .select("id,name,folder_color,created_at,storage_path")
          .eq("id", share.bucket_id).eq("owner_id", share.owner_id).eq("item_type", "folder").maybeSingle();
        if (bucketError) throw bucketError;
        if (!bucketRow || !bucketRow.storage_path) continue;
        buckets.push({
          id: bucketRow.id, name: bucketRow.name, folder_color: bucketRow.folder_color,
          ownerId: share.owner_id, ownerUsername: usernames.get(share.owner_id) || "Coolanas user",
          permission: share.permission || "view_download", sharedAt: share.created_at,
        });
      }

      const grouped = new Map<string, any>();
      for (const share of ownedShares ?? []) {
        let bucket = grouped.get(share.bucket_id);
        if (!bucket) {
          bucket = {
            id: share.bucket_id, ownerId: share.owner_id, name: "",
            folder_color: null, recipients: [],
          };
          grouped.set(share.bucket_id, bucket);
        }
        bucket.recipients.push({
          recipientId: share.recipient_id,
          username: usernames.get(share.recipient_id) || "Coolanas user",
          permission: share.permission || "view_download",
          status: "accepted",
          sharedAt: share.created_at,
        });
      }

      const sharedByYou = [];
      for (const bucket of grouped.values()) {
        const { data: bucketRow, error: bucketError } = await supabase.from("coolanas_files")
          .select("id,name,folder_color,storage_path")
          .eq("id", bucket.id).eq("owner_id", userId).eq("item_type", "folder").maybeSingle();
        if (bucketError) throw bucketError;
        if (!bucketRow || !bucketRow.storage_path) continue;
        sharedByYou.push({
          id: bucketRow.id, name: bucketRow.name, folder_color: bucketRow.folder_color,
          ownerId: userId, recipients: bucket.recipients,
        });
      }

      return json(200, { buckets, sharedByYou });
    }

    if (action === "shared_bucket_open") {
      const bucketId = cleanId(body.bucketId);
      if (!bucketId) return json(400, { error: "Invalid shared bucket." });
      const { data: share, error: shareError } = await supabase.from("bucket_shares")
        .select("bucket_id,owner_id,bucket_path,permission")
        .eq("bucket_id", bucketId).eq("recipient_id", userId).is("revoked_at", null).maybeSingle();
      if (shareError || !share) return json(404, { error: "This bucket is no longer shared with you." });
      const { data: rows, error } = await supabase.from("coolanas_files")
        .select("id,owner_id,parent_id,name,item_type,folder_color,tag,sort_order,created_at,updated_at,storage_path")
        .eq("owner_id", share.owner_id).order("item_type").order("sort_order").order("name");
      if (error) throw error;
      const items = (rows ?? [])
        .filter((row: any) => typeof row.storage_path === "string" && row.storage_path.startsWith(share.bucket_path))
        .map((row: any) => ({ ...row, shared_read_only: true, shared_permission: share.permission || "view_download" }));
      if (!items.some((row: any) => row.id === bucketId)) {
        return json(404, { error: "The shared bucket could not be found." });
      }
      return json(200, { items, bucketId, readOnly: true, permission: share.permission || "view_download" });
    }

    if (action === "bucket_invitation_respond") {
      const invitationId = cleanId(body.invitationId);
      const response = body.response;
      if (!invitationId || (response !== "accept" && response !== "decline")) {
        return json(400, { error: "Invalid invitation response." });
      }
      const { data, error } = await supabase.rpc("coolanas_respond_bucket_invitation", {
        p_invitation_id: invitationId, p_response: response,
      });
      if (error) return json(400, { error: error.message });
      return json(200, { success: true, status: data });
    }

    if (action === "mail_list") {
      const { data, error } = await supabase.from("mail_notifications")
        .select("id,type,title,message,created_at,read_at,bucket_id,invitation_id,payload,sender_id")
        .eq("recipient_id", userId).order("created_at", { ascending: false }).limit(50);
      if (error) throw error;
      return json(200, { notifications: data ?? [] });
    }

    if (action === "mail_clear") {
      const { data: deletedCount, error } = await supabase.rpc("coolanas_clear_mail_notifications");
      if (error) {
        console.error("mail_clear failed:", error);
        return json(500, { error: "Could not clear mail notifications.", details: error.message });
      }
      return json(200, { success: true, deletedCount: deletedCount ?? 0 });
    }

    if (action === "mail_mark_read") {
      const notificationId = cleanId(body.notificationId);
      if (!notificationId) return json(400, { error: "Invalid notification." });
      const { error } = await supabase.from("mail_notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("id", notificationId).eq("recipient_id", userId);
      if (error) throw error;
      return json(200, { success: true });
    }

    const parentId = body?.parentId == null ? null : cleanId(body.parentId);
    if (body?.parentId != null && !parentId) return json(400, { error: "Invalid folder." });

    async function assertParent(id: string | null) {
      if (!id) return null;
      const { data, error } = await supabase.from("coolanas_files")
        .select("id, owner_id, parent_id, name, item_type, storage_path")
        .eq("id", id).eq("owner_id", userId).eq("item_type", "folder").single();
      if (error || !data) throw new Error("Folder not found or not owned by this account.");
      return data;
    }
    async function buildFolderPath(id: string | null): Promise<string> {
      const names: string[] = [];
      let current = id;
      let depth = 0;
      while (current) {
        if (++depth > 40) throw new Error("Folder nesting is too deep.");
        const { data, error } = await supabase.from("coolanas_files")
          .select("id, parent_id, name, item_type, owner_id")
          .eq("id", current).eq("owner_id", userId).eq("item_type", "folder").single();
        if (error || !data) throw new Error("Folder path could not be verified.");
        names.unshift(data.name);
        current = data.parent_id;
      }
      return names.join("/");
    }
    async function ownedItems() {
      const { data, error } = await supabase.from("coolanas_files")
        .select("*").eq("owner_id", userId);
      if (error) throw error;
      return data ?? [];
    }

    if (action === "migrate_prefix") {
      const oldPrefix = "userdata/" + user.id + "/";
      const rows = await ownedItems();
      let migrated = 0;
      for (const row of rows) {
        if (typeof row.storage_path !== "string" || !row.storage_path.startsWith(oldPrefix)) continue;
        const oldKey = row.storage_path;
        const newKey = prefix + "/" + oldKey.slice(oldPrefix.length);
        try {
          await s3.send(new CopyObjectCommand({
            Bucket: bucket,
            CopySource: copySource(bucket, oldKey),
            Key: newKey,
          }));
        } catch (error) {
          if (row.item_type !== "folder") throw error;
          await s3.send(new PutObjectCommand({
            Bucket: bucket, Key: newKey, Body: new Uint8Array(0), ContentType: "application/x-directory",
          }));
        }
        const { error: updateError } = await supabase.from("coolanas_files")
          .update({ storage_path: newKey }).eq("id", row.id).eq("owner_id", user.id);
        if (updateError) throw updateError;
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: oldKey }));
        migrated++;
      }
      return json(200, { success: true, migrated, userFolder: prefix });
    }


    if (action === "ensure_structure") {
      const rows = await ownedItems();
      let exhibitions = rows.find((row: any) => row.item_type === "folder" && row.parent_id === null && row.name === "exhibitions");
      if (!exhibitions) {
        const id = crypto.randomUUID();
        const key = prefix + "/exhibitions/";
        const { data, error } = await supabase.from("coolanas_files")
          .insert({ id, owner_id: user.id, parent_id: null, name: "exhibitions", item_type: "folder", storage_path: key })
          .select("*").single();
        if (error) throw error;
        exhibitions = data;
      }
      const exhibitionsKey = prefix + "/exhibitions/";
      await s3.send(new PutObjectCommand({Bucket:bucket,Key:exhibitionsKey,Body:new Uint8Array(0),ContentType:"application/x-directory"}));
      const statsKey = prefix + "/stats/";
      await s3.send(new PutObjectCommand({Bucket:bucket,Key:statsKey,Body:new Uint8Array(0),ContentType:"application/x-directory"}));

      const byId = new Map(rows.map((row: any) => [row.id, row]));
      const descendants = rows.filter((row: any) => row.id !== exhibitions.id);
      const relativePath = (row: any): string => {
        const parts = [row.name];
        let parent = row.parent_id;
        let depth = 0;
        while (parent && parent !== exhibitions.id) {
          if (++depth > 40) throw new Error("Folder nesting is too deep.");
          const ancestor: any = byId.get(parent);
          if (!ancestor) throw new Error("A file's parent folder could not be found.");
          parts.unshift(ancestor.name);
          parent = ancestor.parent_id;
        }
        return parts.join("/");
      };
      for (const row of descendants) {
        const relative = relativePath(row);
        const newKey = row.item_type === "folder"
          ? exhibitionsKey + relative + "/"
          : exhibitionsKey + relative.split("/").slice(0,-1).concat(row.id + "-" + row.name).join("/");
        if (row.storage_path !== newKey) {
          if (row.storage_path && belongsToUserPath(row.storage_path)) {
            try {
              await s3.send(new CopyObjectCommand({Bucket:bucket,CopySource:copySource(bucket,row.storage_path),Key:newKey}));
            } catch (error) {
              if (row.item_type !== "folder") throw error;
            }
          }
          const { error } = await supabase.from("coolanas_files").update({
            parent_id: row.parent_id === null ? exhibitions.id : row.parent_id,
            storage_path: newKey,
          }).eq("id",row.id).eq("owner_id",user.id);
          if (error) throw error;
          if (row.storage_path && row.storage_path !== newKey && belongsToUserPath(row.storage_path)) {
            await s3.send(new DeleteObjectCommand({Bucket:bucket,Key:row.storage_path}));
          }
        } else if (row.parent_id === null) {
          const { error } = await supabase.from("coolanas_files").update({parent_id:exhibitions.id})
            .eq("id",row.id).eq("owner_id",user.id);
          if (error) throw error;
        }
      }
      return json(200,{success:true,exhibitionsId:exhibitions.id,userFolder:prefix});
    }

    if (action === "exhibitions_list") {
      const { data: root, error: rootError } = await supabase.from("coolanas_files")
        .select("id").eq("owner_id", user.id).eq("item_type", "folder")
        .eq("name", "exhibitions").is("parent_id", null).maybeSingle();
      if (rootError) throw rootError;
      if (!root) return json(200, { exhibitions: [], totalBytes: 0, count: 0 });
      const { data: rows, error } = await supabase.from("coolanas_files")
        .select("id, owner_id, parent_id, name, item_type, folder_color, created_at")
        .eq("owner_id", user.id).eq("parent_id", root.id).eq("item_type", "folder")
        .order("created_at");
      if (error) throw error;
      let totalBytes = 0;
      const exhibitions = [];
      for (const row of rows ?? []) {
        const folderPrefix = prefix + "/exhibitions/" + row.name + "/";
        let sizeBytes = 0, continuationToken: string | undefined;
        do {
          const page = await s3.send(new ListObjectsV2Command({
            Bucket: bucket, Prefix: folderPrefix, ContinuationToken: continuationToken,
          }));
          for (const object of page.Contents ?? []) sizeBytes += Number(object.Size ?? 0);
          continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
        } while (continuationToken);
        totalBytes += sizeBytes;
        exhibitions.push({ ...row, sizeBytes });
      }
      return json(200, { exhibitions, totalBytes, count: exhibitions.length, maxExhibitions: 3 });
    }

    if (action === "create_exhibition") {
      const name = cleanName(body.name);
      if (!name) return json(400, { error: "Exhibition name is invalid." });
      const { data: root, error: rootError } = await supabase.from("coolanas_files")
        .select("id").eq("owner_id", user.id).eq("item_type", "folder")
        .eq("name", "exhibitions").is("parent_id", null).single();
      if (rootError || !root) return json(409, { error: "Your exhibitions area is not ready. Refresh and try again." });
      const { data: existing, error: countError } = await supabase.from("coolanas_files")
        .select("id, name").eq("owner_id", user.id).eq("parent_id", root.id).eq("item_type", "folder");
      if (countError) throw countError;
      if ((existing ?? []).length >= 3) return json(409, { error: "You can create a maximum of 3 buckets." });
      if ((existing ?? []).some((item: any) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        return json(409, { error: "An exhibition with that name already exists." });
      }
      const id = crypto.randomUUID();
      const key = prefix + "/exhibitions/" + name + "/";
      const { data, error } = await supabase.from("coolanas_files").insert({
        id, owner_id: user.id, parent_id: root.id, name, item_type: "folder", storage_path: key,
      }).select("*").single();
      if (error) throw error;
      try {
        await s3.send(new PutObjectCommand({
          Bucket: bucket, Key: key, Body: new Uint8Array(0), ContentType: "application/x-directory",
        }));
      } catch (error) {
        await supabase.from("coolanas_files").delete().eq("id", id).eq("owner_id", user.id);
        throw error;
      }
      return json(200, { item: data });
    }

    if (action === "subjects_get") {
      const { data, error } = await supabase.from("coolanas_dashboard_data")
        .select("subjects").eq("user_id", userId).maybeSingle();
      if (error) throw error;
      return json(200, { subjects: data?.subjects ?? null });
    }

    if (action === "subjects_save") {
      if (!Array.isArray(body.subjects) || body.subjects.length > 40) {
        return json(400, { error: "Subjects must be a list of at most 40 items." });
      }
      const names = new Set<string>();
      const subjects = [];
      for (const subject of body.subjects) {
        if (!subject || typeof subject.name !== "string" || !subject.name.trim() ||
            subject.name.length > 32 || !Number.isInteger(subject.color) ||
            subject.color < 0 || subject.color > 6 ||
            names.has(subject.name.trim().toLowerCase())) {
          return json(400, { error: "One or more subjects are invalid." });
        }
        names.add(subject.name.trim().toLowerCase());
        subjects.push({ name: subject.name.trim(), color: subject.color });
      }
      const { error } = await supabase.from("coolanas_dashboard_data").upsert(
        { user_id: userId, subjects, updated_at: new Date().toISOString() },
        { onConflict: "user_id" }
      );
      if (error) throw error;
      return json(200, { success: true, count: subjects.length });
    }

    if (action === "tasks_get") {
      const { data, error } = await supabase.from("coolanas_dashboard_data")
        .select("tasks, task_days").eq("user_id", userId).maybeSingle();
      if (error) throw error;
      return json(200, {
        tasks: Array.isArray(data?.tasks) ? data.tasks : [],
        taskDays: Array.isArray(data?.task_days) ? data.task_days : []
      });
    }

    if (action === "tasks_save") {
      if (!Array.isArray(body.tasks) || body.tasks.length > 100) {
        return json(400, { error: "Tasks must be a list of at most 100 items." });
      }
      const seen = new Set<string>();
      const tasks = [];
      for (const task of body.tasks) {
        if (!task || typeof task.id !== "string" || !/^[0-9a-f-]{36}$/i.test(task.id) ||
            typeof task.text !== "string" || !task.text.trim() ||
            task.text.length > 180 || seen.has(task.id)) {
          return json(400, { error: "One or more tasks are invalid." });
        }
        seen.add(task.id);
        tasks.push({
          id: task.id, text: task.text.trim(), completed: task.completed === true,
          ...(typeof task.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(task.dueDate) ?
            { dueDate: task.dueDate } : {}),
          ...(typeof task.completedAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(task.completedAt) ?
            { completedAt: task.completedAt } : {}),
        });
      }
      const { error } = await supabase.from("coolanas_dashboard_data").upsert(
        { user_id: userId, tasks, updated_at: new Date().toISOString() },
        { onConflict: "user_id" }
      );
      if (error) throw error;
      return json(200, { success: true, count: tasks.length });
    }

    if (action === "tasks_day_save") {
      const date = typeof body.date === "string" ? body.date : "";
      const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(date + "T00:00:00.000Z") : null;
      if (!parsedDate || Number.isNaN(parsedDate.getTime()) ||
          parsedDate.toISOString().slice(0, 10) !== date ||
          !Array.isArray(body.tasks) || body.tasks.length > 100) {
        return json(400, { error: "A valid date and a list of at most 100 tasks are required." });
      }
      const seen = new Set<string>();
      const dayTasks = [];
      for (const task of body.tasks) {
        if (!task || typeof task.id !== "string" || !/^[0-9a-f-]{36}$/i.test(task.id) ||
            typeof task.text !== "string" || !task.text.trim() ||
            task.text.length > 180 || seen.has(task.id)) {
          return json(400, { error: "One or more day tasks are invalid." });
        }
        seen.add(task.id);
        dayTasks.push({
          id: task.id,
          text: task.text.trim(),
          completed: task.completed === true
        });
      }
      const { data: existing, error: readError } = await supabase
        .from("coolanas_dashboard_data").select("task_days")
        .eq("user_id", userId).maybeSingle();
      if (readError) throw readError;
      const taskDays = Array.isArray(existing?.task_days) ? existing.task_days : [];
      const snapshot = {
        date,
        locked: body.locked === true,
        updatedAt: new Date().toISOString(),
        tasks: dayTasks
      };
      const index = taskDays.findIndex((day: any) => day?.date === date);
      if (index >= 0) taskDays[index] = snapshot;
      else taskDays.push(snapshot);
      taskDays.sort((left: any, right: any) => String(left.date).localeCompare(String(right.date)));
      const { error } = await supabase.from("coolanas_dashboard_data").upsert(
        { user_id: userId, task_days: taskDays, updated_at: new Date().toISOString() },
        { onConflict: "user_id" }
      );
      if (error) throw error;
      return json(200, { success: true, snapshot });
    }

    if (action === "list") {
      const { data, error } = await supabase.from("coolanas_files")
        .select("id, owner_id, parent_id, name, item_type, folder_color, tag, sort_order, created_at, updated_at")
        .eq("owner_id", user.id).order("item_type").order("sort_order").order("name");
      if (error) return json(400, { error: error.message });
      return json(200, { items: data ?? [], userFolder: prefix });
    }

    if (action === "create_folder") {
      const name = cleanName(body.name);
      if (!name) return json(400, { error: "Folder name is invalid." });
      await assertParent(parentId);
      const parentPath = await buildFolderPath(parentId);
      let existingQuery = supabase.from("coolanas_files").select("*")
        .eq("owner_id", user.id).eq("item_type", "folder").eq("name", name);
      existingQuery = parentId ? existingQuery.eq("parent_id", parentId) : existingQuery.is("parent_id", null);
      const { data: existing, error: existingError } = await existingQuery.limit(1).maybeSingle();
      if (existingError) return json(400, { error: existingError.message });
      const key = prefix + "/" + (parentPath ? parentPath + "/" : "") + name + "/";
      if (existing) {
        if (existing.storage_path !== key) {
          const { error: updateError } = await supabase.from("coolanas_files")
            .update({ storage_path: key }).eq("id", existing.id).eq("owner_id", user.id);
          if (updateError) return json(400, { error: updateError.message });
        }
        await s3.send(new PutObjectCommand({
          Bucket: bucket, Key: key, Body: new Uint8Array(0), ContentType: "application/x-directory",
        }));
        return json(200, { item: { ...existing, storage_path: key }, existing: true });
      }
      const id = crypto.randomUUID();
      const { data, error } = await supabase.from("coolanas_files")
        .insert({ id, owner_id: user.id, parent_id: parentId, name, item_type: "folder", storage_path: key })
        .select("*").single();
      if (error) return json(400, { error: error.message });
      try {
        await s3.send(new PutObjectCommand({
          Bucket: bucket, Key: key, Body: new Uint8Array(0), ContentType: "application/x-directory",
        }));
      } catch (e) {
        await supabase.from("coolanas_files").delete().eq("id", id).eq("owner_id", user.id);
        throw e;
      }
      return json(200, { item: data, existing: false });
    }

    if (action === "create_upload") {
      const name = cleanName(body.name);
      if (!name) return json(400, { error: "File name is invalid." });
      await assertParent(parentId);
      const parentPath = await buildFolderPath(parentId);
      const id = crypto.randomUUID();
      const key = prefix + "/" + (parentPath ? parentPath + "/" : "") + id + "-" + name;
      const contentType = typeof body.contentType === "string" && body.contentType.length < 160
        ? body.contentType : "application/octet-stream";
      const { data, error } = await supabase.from("coolanas_files")
        .insert({ id, owner_id: user.id, parent_id: parentId, name, item_type: "file", storage_path: key })
        .select("*").single();
      if (error) return json(400, { error: error.message });
      const url = await getSignedUrl(s3, new PutObjectCommand({
        Bucket: bucket, Key: key, ContentType: contentType,
      }), { expiresIn: 300 });
      return json(200, { item: data, uploadUrl: url, contentType });
    }

    if (action === "finish_upload") {
      const id = cleanId(body.id);
      if (!id) return json(400, { error: "Invalid file." });
      const { data, error } = await supabase.from("coolanas_files")
        .select("id, storage_path").eq("id", id).eq("owner_id", user.id).eq("item_type", "file").single();
      if (error || !data) return json(404, { error: "File record not found." });
      if (!belongsToUserPath(data.storage_path)) return json(403, { error: "File path does not belong to this account." });
      try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: data.storage_path }));
      } catch (headError) {
        // Backblaze can intermittently return an unhelpful S3 UnknownError for HEAD.
        // Confirm the exact object with LIST before deciding that the upload failed.
        const listed = await s3.send(new ListObjectsV2Command({
          Bucket: bucket, Prefix: data.storage_path, MaxKeys: 1,
        }));
        const exists = (listed.Contents ?? []).some((object) => object.Key === data.storage_path);
        if (!exists) throw headError;
      }
      return json(200, { success: true });
    }

    if (action === "download_archive_manifest") {
      const id = cleanId(body.id);
      if (!id) return json(400, { error: "Invalid folder." });
      const { data: selected, error: selectedError } = await supabase.from("coolanas_files")
        .select("id,owner_id,name,item_type,storage_path")
        .eq("id", id).eq("item_type", "folder").maybeSingle();
      if (selectedError || !selected || !selected.storage_path) {
        return json(404, { error: "Folder not found or access denied." });
      }
      let permitted = selected.owner_id === userId;
      if (permitted) {
        if (!belongsToUserPath(selected.storage_path)) {
          return json(403, { error: "Folder path does not belong to this account." });
        }
      } else {
        const { data: shares, error: shareError } = await supabase.from("bucket_shares")
          .select("bucket_path,permission")
          .eq("owner_id", selected.owner_id).eq("recipient_id", userId).is("revoked_at", null);
        if (shareError) throw shareError;
        const matching = (shares ?? []).filter((share: any) =>
          typeof share.bucket_path === "string" && selected.storage_path.startsWith(share.bucket_path)
        );
        if (!matching.length || !matching.some((share: any) => share.permission === "view_download")) {
          return json(403, { error: "The owner has disabled downloads for this shared bucket." });
        }
        permitted = true;
      }
      if (!permitted) return json(403, { error: "You do not have permission to download this folder." });
      const { data: rows, error: rowsError } = await supabase.from("coolanas_files")
        .select("id,name,item_type,storage_path")
        .eq("owner_id", selected.owner_id).eq("item_type", "file");
      if (rowsError) throw rowsError;
      const folderPrefix = selected.storage_path.endsWith("/") ? selected.storage_path : selected.storage_path + "/";
      const files = (rows ?? []).filter((row: any) =>
        typeof row.storage_path === "string" && row.storage_path.startsWith(folderPrefix)
      );
      if (files.length > 2000) return json(413, { error: "This folder contains too many files to zip in one download. Download a smaller folder." });
      const manifest = [];
      for (const file of files) {
        const relativePath = file.storage_path.slice(folderPrefix.length);
        if (!relativePath || relativePath.split("/").some((part: string) => !part || part === "." || part === "..")) continue;
        const command = new GetObjectCommand({
          Bucket: bucket,
          Key: file.storage_path,
          ResponseContentDisposition: "attachment; filename*=UTF-8''" + encodeURIComponent(file.name),
        });
        manifest.push({
          name: relativePath,
          downloadUrl: await getSignedUrl(s3, command, { expiresIn: 600 }),
        });
      }
      return json(200, { files: manifest, count: manifest.length });
    }

    if (action === "download" || action === "file_preview") {
      const previewOnly = action === "file_preview";
      const id = cleanId(body.id);
      if (!id) return json(400, { error: "Invalid file." });
      const { data, error } = await supabase.from("coolanas_files")
        .select("id, owner_id, storage_path, item_type").eq("id", id)
        .eq("item_type", "file").single();
      if (error || !data) return json(404, { error: "File not found or access denied." });

      if (data.owner_id === userId) {
        if (!belongsToUserPath(data.storage_path)) return json(403, { error: "File path does not belong to this account." });
      } else {
        const { data: shares, error: shareError } = await supabase.from("bucket_shares")
          .select("bucket_path,permission")
          .eq("owner_id", data.owner_id).eq("recipient_id", userId).is("revoked_at", null);
        const matchingShares = (shares ?? []).filter((entry: any) =>
          typeof data.storage_path === "string" && data.storage_path.startsWith(entry.bucket_path)
        );
        if (shareError || !matchingShares.length) {
          return json(403, { error: "This file is not in a bucket currently shared with you." });
        }
        if (!previewOnly && !matchingShares.some((entry: any) => entry.permission === "view_download")) {
          return json(403, { error: "The owner has disabled downloads for this shared bucket." });
        }
      }

      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: data.storage_path,
        ...(previewOnly ? { ResponseContentDisposition: "inline" } : {}),
      });
      const url = await getSignedUrl(s3, command, { expiresIn: 180 });
      return json(200, { downloadUrl: url });
    }

    if (action === "rename") {
      const id = cleanId(body.id);
      const name = cleanName(body.name);
      if (!id || !name) return json(400, { error: "A valid item name is required." });
      const { data: item, error: itemError } = await supabase.from("coolanas_files")
        .select("id, owner_id, parent_id, item_type")
        .eq("id", id).eq("owner_id", user.id).single();
      if (itemError || !item) return json(404, { error: "Item not found." });
      let duplicateQuery = supabase.from("coolanas_files").select("id")
        .eq("owner_id", user.id).eq("name", name).neq("id", id);
      duplicateQuery = item.parent_id
        ? duplicateQuery.eq("parent_id", item.parent_id)
        : duplicateQuery.is("parent_id", null);
      const { data: duplicate, error: duplicateError } = await duplicateQuery.limit(1).maybeSingle();
      if (duplicateError) return json(400, { error: duplicateError.message });
      if (duplicate) return json(409, { error: "An item with that name already exists in this folder." });
      const { data, error } = await supabase.from("coolanas_files").update({ name })
        .eq("id", id).eq("owner_id", user.id).select("*").single();
      if (error || !data) return json(400, { error: error?.message ?? "Could not rename item." });
      return json(200, { item: data });
    }

    if (action === "update_metadata") {
      const id = cleanId(body.id);
      if (!id) return json(400, { error: "Invalid item." });
      const patch: Record<string, unknown> = {};
      if (Object.prototype.hasOwnProperty.call(body, "folder_color")) {
        const color = body.folder_color;
        const allowed = ["#e6b325", "#3b82f6", "#22a06b", "#a855f7", "#ef4444", "#6b7280"];
        if (color !== null && !allowed.includes(color)) return json(400, { error: "Invalid folder colour." });
        patch.folder_color = color;
      }
      if (Object.prototype.hasOwnProperty.call(body, "tag")) {
        if (body.tag !== null && (typeof body.tag !== "string" || body.tag.length > 32)) {
          return json(400, { error: "Tag must be 32 characters or fewer." });
        }
        patch.tag = typeof body.tag === "string" ? body.tag.trim() || null : null;
      }
      if (!Object.keys(patch).length) return json(400, { error: "No metadata changes supplied." });
      const { data, error } = await supabase.from("coolanas_files").update(patch)
        .eq("id", id).eq("owner_id", user.id).select("*").single();
      if (error || !data) return json(404, { error: error?.message ?? "Item not found." });
      return json(200, { item: data });
    }

    if (action === "reorder") {
      const ids = Array.isArray(body.ids) ? body.ids.map(cleanId) : [];
      if (!ids.length || ids.some((id: string | null) => !id) || ids.length > 200) return json(400, { error: "Invalid reorder list." });
      const uniqueIds = [...new Set(ids as string[])];
      const targetParent = body.targetParentId == null ? null : cleanId(body.targetParentId);
      if (body.targetParentId != null && !targetParent) return json(400, { error: "Invalid destination folder." });
      await assertParent(targetParent);
      const rows = await ownedItems();
      const selected = uniqueIds.map((id) => rows.find((row: { id: string }) => row.id === id));
      if (selected.some((row) => !row) || selected.some((row: { parent_id: string | null }) => row.parent_id !== targetParent)) {
        return json(400, { error: "Items must be in the same folder to reorder." });
      }
      const { error: reorderError } = await supabase.rpc("coolanas_reorder_files", {
        p_ids: uniqueIds,
        p_parent_id: targetParent,
      });
      if (reorderError) throw reorderError;
      return json(200, { success: true });
    }

    if (action === "move") {
      const ids = Array.isArray(body.ids) ? body.ids.map(cleanId) : [];
      if (!ids.length || ids.some((id: string | null) => !id) || ids.length > 100) return json(400, { error: "Select one or more valid items." });
      const uniqueIds = [...new Set(ids as string[])];
      const targetParent = body.targetParentId == null ? null : cleanId(body.targetParentId);
      if (body.targetParentId != null && !targetParent) return json(400, { error: "Invalid destination folder." });
      const rows = await ownedItems();
      const byId = new Map(rows.map((row: { id: string }) => [row.id, row]));
      const destinationFolder = targetParent ? byId.get(targetParent) as { item_type: string } | undefined : null;
      if (targetParent && (!destinationFolder || destinationFolder.item_type !== "folder")) {
        return json(404, { error: "Folder not found or not owned by this account." });
      }
      const selected = uniqueIds.map((id) => byId.get(id));
      if (selected.some((row) => !row)) return json(404, { error: "One or more selected items no longer exist." });
      const selectedRows = selected as Array<{id:string;name:string;item_type:string;parent_id:string|null;storage_path:string|null}>;
      const selectedSet = new Set(uniqueIds);
      let destinationAncestor = targetParent;
      while (destinationAncestor) {
        if (selectedSet.has(destinationAncestor)) {
          return json(400, { error: "A folder cannot be moved inside itself or one of its descendants." });
        }
        const ancestorRow = byId.get(destinationAncestor) as { parent_id: string | null } | undefined;
        destinationAncestor = ancestorRow?.parent_id ?? null;
      }
      const exhibitionsRoot = rows.find((row: any) =>
        row.item_type === "folder" && row.name === "exhibitions" && row.parent_id === null
      );
      if (exhibitionsRoot && selectedRows.some((item) => item.parent_id === exhibitionsRoot.id)) {
        return json(400, { error: "Exhibitions cannot be moved out of the exhibitions area." });
      }
      const roots = selectedRows.filter((item) => {
        let parent = item.parent_id;
        while (parent) {
          if (selectedSet.has(parent)) return false;
          const p = byId.get(parent) as { parent_id: string | null } | undefined;
          parent = p?.parent_id ?? null;
        }
        return item.parent_id !== targetParent;
      });
      if (!roots.length) return json(200, { success: true, moved: 0 });
      const targetPathParts: string[] = [];
      let pathCursor = targetParent;
      let pathDepth = 0;
      while (pathCursor) {
        if (++pathDepth > 40) throw new Error("Folder nesting is too deep.");
        const parent = byId.get(pathCursor) as { name: string; parent_id: string | null; item_type: string } | undefined;
        if (!parent || parent.item_type !== "folder") throw new Error("Folder path could not be verified.");
        targetPathParts.unshift(parent.name);
        pathCursor = parent.parent_id;
      }
      const targetPath = targetPathParts.join("/");
      const destinationNames = new Set(rows.filter((row: {parent_id:string|null}) => row.parent_id === targetParent).map((row: {name:string}) => row.name));
      for (const root of roots) {
        if (destinationNames.has(root.name)) return json(409, { error: "A file or folder named \"" + root.name + "\" already exists in that folder." });
        destinationNames.add(root.name);
      }

      const movedIds: string[] = [];
      const movingSet = new Set<string>();
      const childrenByParent = new Map<string, any[]>();
      for (const row of rows) {
        if (!row.parent_id) continue;
        const siblings = childrenByParent.get(row.parent_id) ?? [];
        siblings.push(row);
        childrenByParent.set(row.parent_id, siblings);
      }
      const queue: Array<{item:any; newParentId:string|null; parentRel:string}> =
        roots.map((item) => ({ item, newParentId: targetParent, parentRel: targetPath }));
      const changes: Array<{id:string;newParentId:string|null;oldKey:string|null;newKey:string}> = [];
      while (queue.length) {
        const current = queue.shift()!;
        const item = current.item;
        if (movingSet.has(item.id)) continue;
        movingSet.add(item.id);
        const baseRel = current.parentRel ? current.parentRel + "/" : "";
        const newKey = item.item_type === "folder"
          ? prefix + "/" + baseRel + item.name + "/"
          : prefix + "/" + baseRel + item.id + "-" + item.name;
        changes.push({ id: item.id, newParentId: current.newParentId, oldKey: item.storage_path, newKey });
        if (item.item_type === "folder") {
          const childRel = baseRel + item.name;
          for (const child of childrenByParent.get(item.id) ?? []) {
            queue.push({ item: child, newParentId: item.id, parentRel: childRel });
          }
        }
      }
      if (changes.length > 1000) {
        return json(413, { error: "This move contains too many nested items. Move a smaller group." });
      }
      let recoveredObjectKeysPromise: Promise<Set<string>> | null = null;
      const findRecoveredFileKey = async (item: { id: string; name: string }): Promise<string | null> => {
        if (!recoveredObjectKeysPromise) {
          recoveredObjectKeysPromise = (async () => {
            const keys = new Set<string>();
            for (const objectPrefix of [prefix + "/", legacyNamedPrefix + "/", legacyUserPrefix]) {
              let continuationToken: string | undefined;
              do {
                const page = await s3.send(new ListObjectsV2Command({
                  Bucket: bucket, Prefix: objectPrefix, ContinuationToken: continuationToken,
                  MaxKeys: 1000,
                }));
                for (const object of page.Contents ?? []) if (object.Key) keys.add(object.Key);
                continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
              } while (continuationToken);
            }
            return keys;
          })();
        }
        const recoveredObjectKeys = await recoveredObjectKeysPromise;
        const expectedName = item.id + "-" + item.name;
        for (const key of recoveredObjectKeys) {
          if (key.endsWith("/" + expectedName) && belongsToUserPath(key)) return key;
        }
        return null;
      };

      const copyChanges = changes.filter((change) => change.oldKey && change.oldKey !== change.newKey);
      for (const change of changes) {
        if (change.oldKey && !belongsToUserPath(change.oldKey)) {
          return json(403, { error: "A selected item has a storage path outside this account." });
        }
      }
      const copiedDestinationKeys: string[] = [];
      const oldKeyById = new Map<string, string>();
      let nextCopyIndex = 0;
      let copyFailure: unknown = null;
      const copyWorker = async () => {
        while (!copyFailure) {
          const index = nextCopyIndex++;
          if (index >= copyChanges.length) return;
          const change = copyChanges[index];
          try {
          const movingItem = byId.get(change.id) as { id: string; name: string; item_type: string } | undefined;
          let sourceKey = change.oldKey!;
          try {
            await s3.send(new CopyObjectCommand({
              Bucket: bucket, CopySource: copySource(bucket, sourceKey), Key: change.newKey,
            }));
          } catch (error) {
            const errorName = (error as any)?.name ?? "";
            const errorMessage = (error as any)?.message ?? String(error);
            const missingSource = errorName === "NoSuchKey" ||
              /specified key does not exist|no such key/i.test(errorMessage);
            if (movingItem?.item_type === "folder" && missingSource) {
              await s3.send(new PutObjectCommand({
                Bucket: bucket, Key: change.newKey, Body: new Uint8Array(0),
                ContentType: "application/x-directory",
              }));
            } else if (movingItem?.item_type === "file" && missingSource) {
              const recoveredKey = await findRecoveredFileKey(movingItem);
              if (!recoveredKey) {
                throw new Error('Cannot move "' + movingItem.name + '": its stored file object could not be found. No source files were deleted.');
              }
              sourceKey = recoveredKey;
              await s3.send(new CopyObjectCommand({
                Bucket: bucket, CopySource: copySource(bucket, sourceKey), Key: change.newKey,
              }));
            } else {
              throw error;
            }
          }
          copiedDestinationKeys.push(change.newKey);
          oldKeyById.set(change.id, sourceKey);
          } catch (error) {
            copyFailure = error;
            return;
          }
        }
      };
      const copyWorkers = Array.from(
        { length: Math.min(5, copyChanges.length) },
        () => copyWorker()
      );
      await Promise.all(copyWorkers);
      if (copyFailure) {
        await Promise.all(copiedDestinationKeys.map((key) =>
          s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => undefined)
        ));
        throw copyFailure;
      }
      const { error: moveError } = await supabase.rpc("coolanas_move_files", {
        p_changes: changes.map((change) => ({
          id: change.id,
          parent_id: change.newParentId,
          storage_path: change.newKey,
        })),
      });
      if (moveError) {
        await Promise.all(copiedDestinationKeys.map((key) =>
          s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => undefined)
        ));
        throw moveError;
      }
      movedIds.push(...changes.map((change) => change.id));
      const oldKeys = [...oldKeyById.values()];
      let nextDeleteIndex = 0;
      const deleteWorker = async () => {
        while (true) {
          const index = nextDeleteIndex++;
          if (index >= oldKeys.length) return;
          try {
            await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: oldKeys[index] }));
          } catch (error) {
            console.warn("Could not remove old moved-file object:", oldKeys[index], error);
          }
        }
      };
      await Promise.all(Array.from({length:Math.min(8,oldKeys.length)},()=>deleteWorker()));
      return json(200, { success: true, moved: movedIds.length });
    }

    if (action === "delete") {
      const id = cleanId(body.id);
      if (!id) return json(400, { error: "Invalid item." });
      const { data: item, error } = await supabase.from("coolanas_files")
        .select("id, item_type, storage_path").eq("id", id).eq("owner_id", user.id).single();
      if (error || !item) return json(404, { error: "Item not found." });
      const ids = [id];
      const keys: string[] = item.storage_path ? [item.storage_path] : [];
      if (item.item_type === "folder") {
        let frontier = [id];
        while (frontier.length) {
          const { data, error: listError } = await supabase.from("coolanas_files")
            .select("id, item_type, storage_path").eq("owner_id", user.id).in("parent_id", frontier);
          if (listError) throw listError;
          ids.push(...(data ?? []).map((x: {id:string}) => x.id));
          keys.push(...(data ?? []).map((x: {storage_path:string|null}) => x.storage_path).filter(Boolean) as string[]);
          frontier = (data ?? []).filter((x: {item_type:string}) => x.item_type === "folder").map((x: {id:string}) => x.id);
        }
      }
      if (keys.some((key) => !belongsToUserPath(key))) {
        return json(403, { error: "A selected item has a storage path outside this account." });
      }
      for (const key of keys) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      const { error: deleteError } = await supabase.from("coolanas_files")
        .delete().eq("owner_id", user.id).in("id", ids);
      if (deleteError) throw deleteError;
      return json(200, { success: true, deleted: ids.length });
    }

    if (action === "batch") {
      const operations = Array.isArray(body.operations) ? body.operations : [];
      if (!operations.length || operations.length > 100) {
        return json(400, { error: "A batch must contain between 1 and 100 operations." });
      }

      const metadataGroups = new Map<string, { patch: Record<string, unknown>; ids: string[] }>();
      const deleteIds: string[] = [];
      const allowedColors = ["#e6b325", "#3b82f6", "#22a06b", "#a855f7", "#ef4444", "#6b7280"];

      for (const operation of operations) {
        if (!operation || typeof operation !== "object") {
          return json(400, { error: "Invalid batch operation." });
        }
        const id = cleanId(operation.id);
        if (!id) return json(400, { error: "Invalid item in batch." });

        if (operation.type === "delete") {
          deleteIds.push(id);
          continue;
        }
        if (operation.type !== "metadata") {
          return json(400, { error: "Unsupported batch operation." });
        }

        const patch: Record<string, unknown> = {};
        const changes = operation.changes;
        if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
          return json(400, { error: "Invalid metadata changes." });
        }
        if (Object.prototype.hasOwnProperty.call(changes, "folder_color")) {
          const color = changes.folder_color;
          if (color !== null && !allowedColors.includes(color)) {
            return json(400, { error: "Invalid folder colour." });
          }
          patch.folder_color = color;
        }
        if (Object.prototype.hasOwnProperty.call(changes, "tag")) {
          if (changes.tag !== null && (typeof changes.tag !== "string" || changes.tag.length > 32)) {
            return json(400, { error: "Tag must be 32 characters or fewer." });
          }
          patch.tag = typeof changes.tag === "string" ? changes.tag.trim() || null : null;
        }
        if (!Object.keys(patch).length) {
          return json(400, { error: "No metadata changes supplied." });
        }
        const key = JSON.stringify(patch);
        const group = metadataGroups.get(key) ?? { patch, ids: [] };
        group.ids.push(id);
        metadataGroups.set(key, group);
      }

      const uniqueDeleteIds = [...new Set(deleteIds)];
      const uniqueMetadataIds = new Set<string>();
      for (const group of metadataGroups.values()) {
        group.ids = [...new Set(group.ids)];
        for (const id of group.ids) {
          if (uniqueMetadataIds.has(id) || uniqueDeleteIds.includes(id)) {
            return json(400, { error: "An item may only appear once in a batch." });
          }
          uniqueMetadataIds.add(id);
        }
      }

      const validatedMetadataGroups: Array<{ patch: Record<string, unknown>; ids: string[] }> = [];
      for (const group of metadataGroups.values()) {
        const { data: owned, error: ownedError } = await supabase.from("coolanas_files")
          .select("id, item_type").eq("owner_id", userId).in("id", group.ids);
        if (ownedError) throw ownedError;
        const existingIds = (owned ?? []).map((row: { id: string }) => row.id);
        if (!existingIds.length) continue;
        if (Object.prototype.hasOwnProperty.call(group.patch, "folder_color") &&
            (owned ?? []).some((row: { item_type: string }) => row.item_type !== "folder")) {
          return json(400, { error: "Folder colours can only be changed on folders." });
        }
        validatedMetadataGroups.push({ patch: group.patch, ids: existingIds });
      }

      let deleted = 0;
      if (uniqueDeleteIds.length) {
        const rows = await ownedItems();
        const byId = new Map<string, { id: string; item_type: string; storage_path: string | null; parent_id: string | null }>(
          rows.map((row: any): [string, { id: string; item_type: string; storage_path: string | null; parent_id: string | null }] => [row.id, row]),
        );
        const allIds = new Set<string>();
        const frontier = uniqueDeleteIds.filter((id) => byId.has(id));
        const keys: string[] = [];
        while (frontier.length) {
          const id = frontier.pop()!;
          if (allIds.has(id)) continue;
          allIds.add(id);
          const row = byId.get(id) as { item_type: string; storage_path: string | null };
          if (row.storage_path) keys.push(row.storage_path);
          if (row.item_type === "folder") {
            for (const child of rows) {
              if (child.parent_id === id && !allIds.has(child.id)) frontier.push(child.id);
            }
          }
          if (allIds.size > 1000) {
            return json(413, { error: "This selection contains too many nested items. Delete a smaller group." });
          }
        }
        if (keys.some((key) => !belongsToUserPath(key))) {
          return json(403, { error: "A selected item has a storage path outside this account." });
        }
        if (keys.length) {
          const result = await s3.send(new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
          }));
          if (result.Errors?.length) {
            throw new Error("Backblaze could not delete every selected object.");
          }
        }
        if (allIds.size) {
          const { error: deleteError } = await supabase.from("coolanas_files")
            .delete().eq("owner_id", userId).in("id", [...allIds]);
          if (deleteError) throw deleteError;
        }
        deleted = allIds.size;
      }

      const updatedItems: unknown[] = [];
      for (const group of validatedMetadataGroups) {
        const { data, error } = await supabase.from("coolanas_files")
          .update(group.patch).eq("owner_id", userId).in("id", group.ids).select("*");
        if (error) throw error;
        updatedItems.push(...(data ?? []));
      }

      return json(200, { success: true, deleted, updatedItems });
    }

    return json(400, { error: "Unknown action." });
  } catch (error) {
    const detail = error as any;
    const message = error instanceof Error && error.message ? error.message : String(detail?.name || "Files operation failed.");
    console.error("Coolanas B2 files error:", JSON.stringify({
      action: actionForLog,
      name: detail?.name ?? null,
      message,
      code: detail?.Code ?? detail?.code ?? null,
      httpStatusCode: detail?.$metadata?.httpStatusCode ?? null,
      requestId: detail?.$metadata?.requestId ?? detail?.$metadata?.extendedRequestId ?? null,
      cause: detail?.cause?.message ?? null,
    }));
    return json(500, { error: message });
  }
});