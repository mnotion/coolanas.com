import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
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

    if (action === "download") {
      const id = cleanId(body.id);
      if (!id) return json(400, { error: "Invalid file." });
      const { data, error } = await supabase.from("coolanas_files")
        .select("id, owner_id, storage_path, item_type").eq("id", id)
        .eq("owner_id", user.id).eq("item_type", "file").single();
      if (error || !data) return json(404, { error: "File not found or access denied." });
      if (!belongsToUserPath(data.storage_path)) return json(403, { error: "File path does not belong to this account." });
      const url = await getSignedUrl(s3, new GetObjectCommand({
        Bucket: bucket, Key: data.storage_path,
      }), { expiresIn: 180 });
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