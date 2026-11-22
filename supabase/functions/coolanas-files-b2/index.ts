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

  try {
    const body = await req.json();
    const action = body?.action;
    const profilePictureKey = prefix + "/assets/settings/profile-picture.png";

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
      return json(200, { exhibitions, totalBytes, count: exhibitions.length, maxExhibitions: 2 });
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
      if ((existing ?? []).length >= 2) return json(409, { error: "You can create a maximum of 2 exhibitions." });
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
      const key = prefix + "/stats/subjects.json";
      try {
        const object = await s3.send(new GetObjectCommand({Bucket:bucket,Key:key}));
        const raw = await object.Body?.transformToString();
        const parsed = JSON.parse(raw || "[]");
        const subjects = Array.isArray(parsed) ? parsed.filter((subject:any) =>
          subject && typeof subject.name === "string" && subject.name.trim() &&
          Number.isInteger(subject.color) && subject.color >= 0 && subject.color <= 6
        ).slice(0,40) : [];
        return json(200,{subjects});
      } catch (error) {
        if ((error as any)?.$metadata?.httpStatusCode !== 404 && (error as any)?.name !== "NoSuchKey") throw error;
        return json(200,{subjects:null});
      }
    }

    if (action === "subjects_save") {
      if (!Array.isArray(body.subjects) || body.subjects.length > 40) return json(400,{error:"Subjects must be a list of at most 40 items."});
      const names = new Set<string>();
      const subjects = [];
      for (const subject of body.subjects) {
        if (!subject || typeof subject.name !== "string" || !subject.name.trim() ||
            subject.name.length > 32 || !Number.isInteger(subject.color) || subject.color < 0 || subject.color > 6 ||
            names.has(subject.name.trim().toLowerCase())) {
          return json(400,{error:"One or more subjects are invalid."});
        }
        names.add(subject.name.trim().toLowerCase());
        subjects.push({name:subject.name.trim(),color:subject.color});
      }
      const key = prefix + "/stats/subjects.json";
      await s3.send(new PutObjectCommand({
        Bucket:bucket,Key:key,Body:JSON.stringify(subjects,null,2),
        ContentType:"application/json; charset=utf-8",
      }));
      return json(200,{success:true,count:subjects.length});
    }

    if (action === "tasks_get") {
      const key = prefix + "/stats/tasks.json";
      try {
        const object = await s3.send(new GetObjectCommand({Bucket:bucket,Key:key}));
        const raw = await object.Body?.transformToString();
        const parsed = JSON.parse(raw || "[]");
        const tasks = Array.isArray(parsed) ? parsed.filter((task:any) =>
          task && typeof task.id === "string" && typeof task.text === "string"
        ).slice(0,100) : [];
        return json(200,{tasks});
      } catch (error) {
        if ((error as any)?.$metadata?.httpStatusCode !== 404 && (error as any)?.name !== "NoSuchKey") throw error;
        await s3.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:"[]",ContentType:"application/json; charset=utf-8"}));
        return json(200,{tasks:[]});
      }
    }

    if (action === "tasks_save") {
      if (!Array.isArray(body.tasks) || body.tasks.length > 100) return json(400,{error:"Tasks must be a list of at most 100 items."});
      const seen = new Set<string>();
      const tasks = [];
      for (const task of body.tasks) {
        if (!task || typeof task.id !== "string" || !/^[0-9a-f-]{36}$/i.test(task.id) ||
            typeof task.text !== "string" || !task.text.trim() || task.text.length > 180 || seen.has(task.id)) {
          return json(400,{error:"One or more tasks are invalid."});
        }
        seen.add(task.id);
        tasks.push({id:task.id,text:task.text.trim(),completed:task.completed===true});
      }
      const key = prefix + "/stats/tasks.json";
      await s3.send(new PutObjectCommand({
        Bucket:bucket,Key:key,Body:JSON.stringify(tasks,null,2),
        ContentType:"application/json; charset=utf-8",
      }));
      return json(200,{success:true,count:tasks.length});
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
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: data.storage_path }));
      return json(200, { success: true });
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
      await assertParent(targetParent);
      const rows = await ownedItems();
      const byId = new Map(rows.map((row: { id: string }) => [row.id, row]));
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
      const { data: exhibitionsRoot } = await supabase.from("coolanas_files")
        .select("id").eq("owner_id", user.id).eq("item_type", "folder")
        .eq("name", "exhibitions").is("parent_id", null).maybeSingle();
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
      const targetPath = await buildFolderPath(targetParent);
      const destinationNames = new Set(rows.filter((row: {parent_id:string|null}) => row.parent_id === targetParent).map((row: {name:string}) => row.name));
      for (const root of roots) {
        if (destinationNames.has(root.name)) return json(409, { error: "A file or folder named \"" + root.name + "\" already exists in that folder." });
        destinationNames.add(root.name);
      }

      const movedIds: string[] = [];
      const oldKeys: string[] = [];
      const newKeys: string[] = [];
      const parentPaths = new Map<string, string>();
      const movingSet = new Set<string>();
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
          for (const child of rows.filter((row: {parent_id:string|null}) => row.parent_id === item.id)) {
            queue.push({ item: child, newParentId: item.id, parentRel: childRel });
          }
        }
      }
      if (changes.length > 1000) {
        return json(413, { error: "This move contains too many nested items. Move a smaller group." });
      }
      for (const change of changes) {
        if (change.oldKey && !belongsToUserPath(change.oldKey)) {
          return json(403, { error: "A selected item has a storage path outside this account." });
        }
        if (change.oldKey && change.oldKey !== change.newKey) {
          await s3.send(new CopyObjectCommand({
            Bucket: bucket, CopySource: copySource(bucket, change.oldKey), Key: change.newKey,
          }));
          oldKeys.push(change.oldKey);
        }
        newKeys.push(change.newKey);
      }
      const { error: moveError } = await supabase.rpc("coolanas_move_files", {
        p_changes: changes.map((change) => ({
          id: change.id,
          parent_id: change.newParentId,
          storage_path: change.newKey,
        })),
      });
      if (moveError) throw moveError;
      movedIds.push(...changes.map((change) => change.id));
      for (const oldKey of oldKeys) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: oldKey }));
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
    const message = error instanceof Error ? error.message : "Files operation failed.";
    console.error("Coolanas B2 files error:", message);
    return json(500, { error: message });
  }
});