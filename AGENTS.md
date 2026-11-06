# Mandatory: Supabase-only backend target

For all **new and migrated persistent storage, authentication, cloud file storage, and realtime backend functions**, use ONLY the existing Supabase PostgreSQL project `tbrqqjrzknhdnwcpkqro` and this repository's dedicated schema `app_calypso`. Do **not** introduce Firebase Auth, Firestore, Firebase Storage, or other Firebase services in new work. When existing code still uses Firebase, treat it as **legacy requiring migration**, not an acceptable permanent backend. Never silently fall back to Firebase on Supabase errors. The app schema is private: build and verify appropriate scoped authorization/API/RLS before use; do not expose privileged credentials or make broad public grants. Preserve existing live behavior and source data until a verified non-destructive import, identity mapping and tested Supabase cutover are complete. The `database-contract.json` file is the machine-readable target. This rule does not claim the live migration is already complete.

# Database routing for ChatGPT and coding agents

**Repository:** `marcusdhaynes/Calypso`
**Online PostgreSQL:** Existing Supabase project `tbrqqjrzknhdnwcpkqro` (Somniel Holdings LLC)
**Only this app's schema:** `app_calypso`
**App-scoped database role:** `app_calypso_executor` (NOLOGIN until an authenticated backend gateway is configured).

When the user says "add this to the database", "update the database", or similar while working on this repository, interpret it as a request for `app_calypso`, never another app's schema or `public`. Verify the registry row before any SQL:
```sql
SELECT repository, schema_name, project_ref
FROM app_directory.app_routes
WHERE repository = 'Calypso';
```
Use the connected Supabase tool for database edits and schema-qualified SQL such as `app_calypso.new_table`. If the app identity cannot be established reliably, clarify instead of guessing.

Security: new application schemas are private and not Data API-exposed; do not grant `anon`, `authenticated`, or `service_role` broad access simply to make a call succeed. For app features, design proper identity, RLS and a least-privileged backend before exposing data. Keep app data logically separate; all apps share the same PostgreSQL project and resources.

Database schema provisioning is NOT the same as migrating existing Firebase, SQLite, JSON, remote service, or local app data. Do not delete existing data or switch production until backed up, imported, verified, and tested. Never commit credentials. Do not create another paid Supabase project.

Canonical route directory: private `marcusdhaynes/somniel-holdings` repository, `database-routing.json`, and PostgreSQL table `app_directory.app_routes`.
