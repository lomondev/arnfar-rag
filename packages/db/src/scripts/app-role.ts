/**
 * Create (or update) the unprivileged role the application connects as.
 *
 *   bun run db:app-role
 *
 * Why this is not a migration: PostgreSQL exempts SUPERUSER and BYPASSRLS roles from row
 * security unconditionally — `FORCE ROW LEVEL SECURITY` only subjects the table *owner*.
 * So the policies in migration 0003 are inert while the app connects as the cluster
 * superuser, which is exactly what a default `docker compose` setup gives you. The fix is
 * a second role, and a role needs a password, which must not live in a committed
 * migration. It reads APP_DB_PASSWORD from the environment instead.
 *
 * Roles are cluster-wide rather than database-scoped, so this is idempotent by design:
 * re-running it re-applies grants (including on tables created since) and resets the
 * password to whatever the environment currently says.
 *
 * Run it as a superuser (the DATABASE_URL you already have), then point the application's
 * DATABASE_URL at the new role.
 */
import postgres from "postgres";

const APP_ROLE = process.env.APP_DB_ROLE ?? "arnfar_app";
const PASSWORD = process.env.APP_DB_PASSWORD;
const ADMIN_URL = process.env.DATABASE_URL;

if (!ADMIN_URL) {
  console.error("DATABASE_URL is required (must be a superuser / role-creating connection)");
  process.exit(1);
}
if (!PASSWORD) {
  console.error(
    "APP_DB_PASSWORD is required.\n" +
      "Set it in .env, then point DATABASE_URL at the app role once this has run:\n" +
      `  APP_DB_PASSWORD=<a long random string>\n` +
      `  DATABASE_URL=postgres://${APP_ROLE}:<same>@localhost:5432/<db>`,
  );
  process.exit(1);
}
if (!/^[a-z_][a-z0-9_]*$/.test(APP_ROLE)) {
  // Interpolated into DDL below, where identifiers cannot be bound as parameters.
  console.error(`APP_DB_ROLE must be a plain lowercase identifier, got: ${APP_ROLE}`);
  process.exit(1);
}

const sql = postgres(ADMIN_URL, { max: 1 });

try {
  const dbRows = await sql<{ current_database: string }[]>`SELECT current_database()`;
  const dbName = dbRows[0]?.current_database;
  if (!dbName) throw new Error("could not resolve current_database()");

  // CREATE/ALTER ROLE cannot take bind parameters, so the password becomes a literal.
  // Escaped the way Postgres escapes literals — double every quote — after rejecting the
  // one byte that cannot appear in one at all.
  if (PASSWORD.includes("\0")) {
    console.error("APP_DB_PASSWORD must not contain a null byte");
    process.exit(1);
  }
  const passwordLiteral = `'${PASSWORD.replace(/'/g, "''")}'`;
  const roleRows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${APP_ROLE}) AS exists
  `;
  const roleExists = roleRows[0]?.exists === true;

  // NOSUPERUSER / NOBYPASSRLS are the entire point — stated explicitly rather than left
  // to the defaults, because a future ALTER that grants either one silently disables
  // every tenant policy in the database.
  const attributes = `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${passwordLiteral}`;
  await sql.unsafe(
    roleExists
      ? `ALTER ROLE ${APP_ROLE} WITH ${attributes}`
      : `CREATE ROLE ${APP_ROLE} WITH ${attributes}`,
  );

  await sql.unsafe(`GRANT CONNECT ON DATABASE "${dbName}" TO ${APP_ROLE}`);
  await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
  await sql.unsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`,
  );
  await sql.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`);
  // Tables created by future migrations, which run as the owner rather than this role.
  await sql.unsafe(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE}`,
  );
  await sql.unsafe(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${APP_ROLE}`,
  );

  // The bundled demo ERP lives in its own schema and is read-only to the app.
  const [erp] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'erp') AS exists
  `;
  if (erp?.exists) {
    await sql.unsafe(`GRANT USAGE ON SCHEMA erp TO ${APP_ROLE}`);
    await sql.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA erp TO ${APP_ROLE}`);
    await sql.unsafe(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA erp GRANT SELECT ON TABLES TO ${APP_ROLE}`,
    );
  }

  const [check] = await sql<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
    SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${APP_ROLE}
  `;
  if (check?.rolsuper || check?.rolbypassrls) {
    console.error(`✗ ${APP_ROLE} still bypasses RLS — refusing to report success`);
    process.exit(1);
  }

  console.log(`✓ role ${APP_ROLE} ready on database "${dbName}" (NOSUPERUSER, NOBYPASSRLS)`);
  console.log(
    `  Point the app at it:  DATABASE_URL=postgres://${APP_ROLE}:***@host:5432/${dbName}`,
  );
  console.log(`  Keep the superuser URL for migrations (ADMIN_DATABASE_URL).`);
} finally {
  await sql.end();
}
