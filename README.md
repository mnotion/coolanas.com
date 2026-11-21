# Coolanas

Coolanas is a static web application with Supabase authentication and a Backblaze B2-backed file workspace.

## Current repository layout

- `index.html`, `dashboard.html`, `files.html`, and `auth-callback.html` are the current root-level application pages.
- `js/` contains shared browser scripts.
- `css/` contains page styles.
- `assets/` contains branding and icons.
- `supabase/functions/coolanas-files-b2/` contains the source for the authenticated B2 file API.

## File workspace synchronisation

The files page keeps metadata changes in a user-scoped IndexedDB queue and attempts to synchronise them every five seconds. It also attempts a flush when the page is backgrounded or closed. Browser shutdown events are best-effort only; the persisted queue is retained and retried when the user returns.

File bytes continue to upload directly to Backblaze using short-lived signed URLs. They are not held in the metadata queue.

The `coolanas-files-b2` Edge Function supports a `batch` action for metadata changes and recursive deletion. Batch operations are scoped to the authenticated owner and are safe to retry after an interrupted response.

## Local development

1. Install the Supabase CLI and Deno.
2. Start a local Supabase stack with `supabase start`.
3. Configure the required local environment values for Supabase and Backblaze B2 outside version control.
4. Apply the SQL migration in `supabase/migrations/` to an isolated staging database before enabling the new move/reorder RPC calls.
5. Serve the function locally with `supabase functions serve coolanas-files-b2 --env-file .env.local`.
6. Test create, upload, download, move, reorder, bulk delete, tag, colour, interrupted sync, and sign-out/reload flows.

Do not commit `.env.local`, Supabase access tokens, Backblaze application keys, or service-role keys. Do not deploy this function to the currently active Supabase project as part of development-branch work. Validate it against an isolated staging Supabase project and a non-production B2 bucket first.

## Deployment warning

GitHub Pages is currently building and deploying from pushes to `development`. Treat this branch as publicly deployed, not as an isolated preview branch. The B2 Edge Function source in this repository is not automatically deployed to Supabase; the client temporarily falls back to the existing action endpoints until the batch function is deployed to an isolated staging project.
