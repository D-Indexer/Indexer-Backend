-- database/roles.sql
--
-- Least-privilege Postgres roles for issue #214.
--
-- Roles:
--   folder_owner    - migration/owner role. Owns schema objects and runs migrations.
--                     Has DDL rights. Should NOT be used by the API or indexer at runtime.
--   folder_indexer  - DML on indexer-owned tables (cursor, raw/indexer state). No DDL at runtime.
--   folder_api      - SELECT on read-model tables, DML only on API-owned tables
--                     (e.g. idempotency keys). No DDL at runtime.
--
-- This file is idempotent and safe to re-apply. It is intended to be applied by
-- migrations under the owner role (folder_owner), e.g.:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/roles.sql
--
-- The application processes then connect with the restricted roles via
-- API_DATABASE_URL / INDEXER_DATABASE_URL (falling back to DATABASE_URL).

BEGIN;

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------

-- Owner / migration role. NOLOGIN by default: it is used by migrations run by
-- an operator or CI, not by long-running application processes. If you need to
-- log in as the owner, set a password out of band (ALTER ROLE ... PASSWORD ...).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'folder_owner') THEN
        CREATE ROLE folder_owner NOLOGIN;
    END IF;
END
$$;

-- Indexer role: DML on indexer tables, no DDL at runtime.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'folder_indexer') THEN
        CREATE ROLE folder_indexer NOLOGIN;
    END IF;
END
$$;

-- API role: SELECT on read-model tables, DML only on API-owned tables.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'folder_api') THEN
        CREATE ROLE folder_api NOLOGIN;
    END IF;
END
$$;

-- Harden the restricted roles: they must never create objects or bypass RLS.
ALTER ROLE folder_indexer NOSUPERUSER NOCREATEDB NOCREATEROLE NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE folder_api     NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

-- The owner role may create objects (needed for migrations).
ALTER ROLE folder_owner NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION;

-- ---------------------------------------------------------------------------
-- Schema ownership and baseline privileges
-- ---------------------------------------------------------------------------

-- The owner role owns the public schema so migrations can create/alter objects.
-- (Adjust the schema name if the project uses a dedicated schema.)
ALTER SCHEMA public OWNER TO folder_owner;

-- Revoke the default PUBLIC privileges so the restricted roles start from a
-- clean slate and only get what is granted explicitly below.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

-- Both application roles need to resolve names in the schema.
GRANT USAGE ON SCHEMA public TO folder_indexer;
GRANT USAGE ON SCHEMA public TO folder_api;

-- ---------------------------------------------------------------------------
-- Read-model tables (SELECT-only for the API)
-- ---------------------------------------------------------------------------
--
-- The API reads the read model but must never write to it. The indexer owns
-- writes to these tables. Add new read-model tables to this list (or rely on
-- the default privileges below, which grant SELECT to folder_api on any table
-- created by folder_owner).
--
-- `folders` is the canonical read-model table referenced by the acceptance
-- criteria: INSERT INTO folders AS folder_api must fail with a permission error.

GRANT SELECT ON TABLE folders TO folder_api;

-- ---------------------------------------------------------------------------
-- Indexer-owned tables (DML for the indexer)
-- ---------------------------------------------------------------------------
--
-- The indexer writes cursor/state and the read model. It gets DML but no DDL
-- at runtime; schema changes go through migrations under folder_owner.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE folders TO folder_indexer;

-- Cursor / indexer state table. Guarded so this file can be applied before or
-- after the table exists.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'indexer_cursor'
    ) THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE indexer_cursor TO folder_indexer';
        EXECUTE 'GRANT SELECT ON TABLE indexer_cursor TO folder_api';
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- API-owned tables (DML for the API)
-- ---------------------------------------------------------------------------
--
-- The API needs to write to a small number of tables it owns, such as
-- idempotency keys. These are granted explicitly and are NOT part of the
-- read model.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'idempotency_keys'
    ) THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE idempotency_keys TO folder_api';
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Sequences
-- ---------------------------------------------------------------------------
--
-- Serial/identity columns need USAGE on their sequences for INSERTs.

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO folder_indexer;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO folder_api;

-- ---------------------------------------------------------------------------
-- Default privileges for future objects created by the owner role
-- ---------------------------------------------------------------------------
--
-- Migrations run as folder_owner. These defaults ensure that tables created
-- later automatically get the right grants without re-editing this file.

-- Read model: API gets SELECT on everything the owner creates.
ALTER DEFAULT PRIVILEGES FOR ROLE folder_owner IN SCHEMA public
    GRANT SELECT ON TABLES TO folder_api;

-- Indexer gets DML on everything the owner creates.
ALTER DEFAULT PRIVILEGES FOR ROLE folder_owner IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO folder_indexer;

-- Sequences for both roles.
ALTER DEFAULT PRIVILEGES FOR ROLE folder_owner IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO folder_indexer;
ALTER DEFAULT PRIVILEGES FOR ROLE folder_owner IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO folder_api;

-- Functions: allow execution by both application roles by default.
ALTER DEFAULT PRIVILEGES FOR ROLE folder_owner IN SCHEMA public
    GRANT EXECUTE ON FUNCTIONS TO folder_indexer;
ALTER DEFAULT PRIVILEGES FOR ROLE folder_owner IN SCHEMA public
    GRANT EXECUTE ON FUNCTIONS TO folder_api;

COMMIT;