/**
 * Development/test seeder: one sign-in account for every role, so each portal
 * view can be tried locally.
 *   npm run db:seed                     # create missing accounts
 *   npm run db:seed -- --reset-passwords  # also give existing seed accounts a new password
 *
 * Refuses to run with NODE_ENV=production. Passwords are random per account
 * unless SEED_PASSWORD is set (12+ characters). The credentials are printed
 * and appended to seed-accounts.log (mode 0600, git-ignored); existing
 * accounts keep their password unless --reset-passwords is given.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigError, loadConfig } from "../config/env.js";
import { createDataSource } from "../db/data-source.js";
import { withTransaction, type Sql } from "../db/sql.js";
import { recordEvent } from "../lib/events.js";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, hashPassword } from "../lib/password.js";
import { ROLES, ROLE_LABELS, permissionsOf, type Role } from "../lib/permissions.js";

const EMAIL_DOMAIN = "houzzhills.test";
const LOG_FILE = resolve(process.cwd(), "seed-accounts.log");

type SeedAccount = { role: Role; fullName: string; employeeNumber: string; department: string; jobTitle: string };

/** Every role in ROLES must appear here exactly once (checked at start-up). */
const ACCOUNTS: readonly SeedAccount[] = [
  { role: "owner", fullName: "Amina Bello", employeeNumber: "HH-001", department: "Management", jobTitle: "Owner" },
  { role: "manager", fullName: "Tunde Okafor", employeeNumber: "HH-002", department: "Management", jobTitle: "General Manager" },
  { role: "front_desk", fullName: "Hauwa Musa", employeeNumber: "HH-014", department: "Front desk", jobTitle: "Front Desk Officer" },
  { role: "housekeeping", fullName: "Grace Danjuma", employeeNumber: "HH-022", department: "Housekeeping", jobTitle: "Room Attendant" },
  { role: "restaurant_cashier", fullName: "Ibrahim Sani", employeeNumber: "HH-031", department: "Restaurant", jobTitle: "Cashier" },
  { role: "restaurant_manager", fullName: "Ngozi Eze", employeeNumber: "HH-030", department: "Restaurant", jobTitle: "Restaurant Manager" },
  { role: "storekeeper", fullName: "Yakubu Ali", employeeNumber: "HH-041", department: "Stores", jobTitle: "Storekeeper" },
  { role: "finance", fullName: "Funke Adeyemi", employeeNumber: "HH-051", department: "Finance", jobTitle: "Accountant" },
  { role: "auditor", fullName: "Chidi Nwosu", employeeNumber: "HH-061", department: "Finance", jobTitle: "Internal Auditor" },
];

type Outcome = "created" | "password reset" | "exists (password unchanged)";
type LogRow = { role: Role; email: string; password: string | null; outcome: Outcome };

const emailFor = (role: Role) => `${role.replace(/_/g, "-")}@${EMAIL_DOMAIN}`;

function passwordFor(): string {
  const fixed = process.env.SEED_PASSWORD;
  if (fixed === undefined || fixed === "") return randomBytes(18).toString("base64url");
  if (fixed.length < PASSWORD_MIN_LENGTH || fixed.length > PASSWORD_MAX_LENGTH) {
    throw new ConfigError([`SEED_PASSWORD must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters`]);
  }
  return fixed;
}

function assertEveryRoleSeeded(): void {
  const seeded = ACCOUNTS.map((account) => account.role);
  const missing = ROLES.filter((role) => !seeded.includes(role));
  if (missing.length > 0 || new Set(seeded).size !== seeded.length) throw new Error(`Seed accounts must cover each role once; missing: ${missing.join(", ") || "none"}`);
}

/** The property everything belongs to: the existing one, or a new one on an empty database. */
async function propertyId(tx: Sql): Promise<string> {
  const existing = await tx.maybeOne<{ id: string }>(`SELECT id FROM properties ORDER BY created_at LIMIT 1`);
  if (existing) return existing.id;
  return (await tx.one<{ id: string }>(`INSERT INTO properties(name) VALUES ('Houzz Hills Kaduna') RETURNING id`)).id;
}

async function seedAccount(tx: Sql, property: string, ownerId: string | null, account: SeedAccount, resetPasswords: boolean): Promise<{ row: LogRow; userId: string }> {
  const email = emailFor(account.role);
  const existing = await tx.maybeOne<{ id: string; role: string; property_id: string }>(`SELECT id, role, property_id FROM users WHERE email = $1 FOR UPDATE`, [email]);
  if (existing) {
    if (existing.role !== account.role || existing.property_id !== property) throw new Error(`${email} exists with a different role or property; refusing to change it`);
    if (!resetPasswords) return { userId: existing.id, row: { role: account.role, email, password: null, outcome: "exists (password unchanged)" } };
    const password = passwordFor();
    await tx.exec(`UPDATE users SET password_hash = $2, must_change_password = false, active = true WHERE id = $1`, [existing.id, await hashPassword(password)]);
    // Refresh tokens stop working at once; an access token already issued lapses within its TTL.
    await tx.exec(`UPDATE api_sessions SET revoked_at = now(), revoked_reason = 'seed_password_reset' WHERE user_id = $1 AND revoked_at IS NULL`, [existing.id]);
    await recordEvent(tx, { propertyId: property, actorId: null, action: "seed.password_reset", entityType: "user", entityId: existing.id, details: { role: account.role }, outbox: false });
    return { userId: existing.id, row: { role: account.role, email, password, outcome: "password reset" } };
  }

  const password = passwordFor();
  // Seed accounts sign straight in; staff onboarded through the API must still change their password first.
  const user = await tx.one<{ id: string }>(
    `INSERT INTO users(property_id, email, full_name, password_hash, role, must_change_password) VALUES ($1, $2, $3, $4, $5, false) RETURNING id`,
    [property, email, account.fullName, await hashPassword(password), account.role],
  );
  // The owner has no staff profile (setup creates none); everyone else appears under Team & attendance.
  if (account.role !== "owner") {
    await tx.exec(
      `INSERT INTO staff_profiles(property_id, user_id, employee_number, department, job_title, start_date)
       VALUES ($1, $2, $3, $4, $5, CURRENT_DATE)`,
      [property, user.id, account.employeeNumber, account.department, account.jobTitle],
    );
  }
  await recordEvent(tx, {
    propertyId: property,
    actorId: ownerId ?? user.id,
    action: "seed.account_created",
    entityType: "user",
    entityId: user.id,
    details: { role: account.role, employeeNumber: account.role === "owner" ? null : account.employeeNumber },
    outbox: false,
  });
  return { userId: user.id, row: { role: account.role, email, password, outcome: "created" } };
}

function report(rows: readonly LogRow[], databaseUrl: string): string {
  const database = new URL(databaseUrl);
  const lines = [
    `Houzz Hills seed accounts · ${new Date().toISOString()} · database ${database.host}${database.pathname}`,
    `Sign in at /management. These accounts skip the first-sign-in password change.`,
    "",
  ];
  for (const row of rows) {
    lines.push(`[${row.outcome}] ${ROLE_LABELS[row.role]} (${row.role})`);
    lines.push(`  email:       ${row.email}`);
    lines.push(`  password:    ${row.password ?? "(unchanged; run with --reset-passwords to set a new one)"}`);
    lines.push(`  permissions: ${permissionsOf(row.role).join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const unknown = process.argv.slice(2).filter((argument) => argument !== "--reset-passwords");
  if (unknown.length > 0) throw new Error(`Unknown argument(s): ${unknown.join(" ")}. Usage: seed [--reset-passwords]`);
  const resetPasswords = process.argv.includes("--reset-passwords");
  assertEveryRoleSeeded();

  const config = loadConfig();
  if (config.env === "production") throw new Error("Refusing to seed accounts with NODE_ENV=production");

  const dataSource = createDataSource(config);
  await dataSource.initialize();
  try {
    if (await dataSource.showMigrations()) throw new Error("Run the migrations first: npm run db:migrate");
    const rows = await withTransaction(dataSource, async (tx) => {
      const property = await propertyId(tx);
      const owner = await tx.maybeOne<{ id: string }>(`SELECT id FROM users WHERE property_id = $1 AND role = 'owner' ORDER BY created_at LIMIT 1`, [property]);
      let ownerId = owner?.id ?? null;
      const results: LogRow[] = [];
      for (const account of ACCOUNTS) {
        const { row, userId } = await seedAccount(tx, property, ownerId, account, resetPasswords);
        if (account.role === "owner") ownerId ??= userId;
        results.push(row);
      }
      return results;
    });

    const text = report(rows, config.database.url);
    console.log(text);
    // Appended, so passwords from earlier runs stay readable after a run that changed nothing.
    appendFileSync(LOG_FILE, `${text}\n`, { mode: 0o600 });
    chmodSync(LOG_FILE, 0o600);
    console.log(`Seeded ${rows.filter((row) => row.outcome !== "exists (password unchanged)").length} of ${rows.length} accounts. Log appended to ${LOG_FILE}`);
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error instanceof Error ? error.message : error);
  process.exit(1);
});
