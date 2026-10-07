import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config/env.js";

const base = {
  DATABASE_URL: "postgresql://user@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  JWT_ACCESS_SECRET: "a-very-long-random-secret-value-0123456789",
  SETTINGS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
};

function issuesOf(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return [...error.issues];
    throw error;
  }
  return [];
}

describe("loadConfig", () => {
  it("applies defaults and coerces types", () => {
    const config = loadConfig({ ...base, PORT: "8080", DATABASE_SSL: "true", CORS_ORIGINS: "http://localhost:3000, https://app.example.com" });
    expect(config.port).toBe(8080);
    expect(config.database.ssl).toBe(true);
    expect(config.apiPrefix).toBe("/api/v1");
    expect(config.corsOrigins).toEqual(["http://localhost:3000", "https://app.example.com"]);
    expect(config.docsEnabled).toBe(true);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("treats blank values as unset", () => {
    expect(loadConfig({ ...base, PORT: "  ", LOG_LEVEL: "" }).port).toBe(4000);
  });

  it("reports every missing or invalid variable at once", () => {
    const issues = issuesOf({ PORT: "abc", JWT_ACCESS_SECRET: "short" });
    expect(issues.join("\n")).toMatch(/DATABASE_URL|required/);
    expect(issues.length).toBeGreaterThan(1);
  });

  it("rejects CORS entries that are not exact origins", () => {
    expect(issuesOf({ ...base, CORS_ORIGINS: "https://app.example.com/path" })[0]).toMatch(/exact origin/);
  });

  it("enforces production safety rules", () => {
    const issues = issuesOf({ ...base, NODE_ENV: "production", JWT_ACCESS_SECRET: "replace-with-a-long-random-value-please", COOKIE_SECURE: "false" });
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/JWT_ACCESS_SECRET/),
        expect.stringMatching(/COOKIE_SECURE/),
        expect.stringMatching(/CORS_ORIGINS/),
      ]),
    );
  });

  it("requires a 32-byte settings encryption key and https URLs in production", () => {
    expect(issuesOf({ ...base, SETTINGS_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64").padEnd(40, "A") })).toEqual(
      expect.arrayContaining([expect.stringMatching(/SETTINGS_ENCRYPTION_KEY must be 32 bytes/)]),
    );
    const config = loadConfig({ ...base, PUBLIC_WEB_URL: "https://app.example.com/" });
    expect(config.payments).toMatchObject({ publicWebUrl: "https://app.example.com", paystackBaseUrl: "https://api.paystack.co" });
    expect(config.settingsEncryptionKey).toHaveLength(32);
    expect(issuesOf({ ...base, NODE_ENV: "production", CORS_ORIGINS: "https://app.example.com", PUBLIC_WEB_URL: "http://app.example.com" })[0]).toMatch(/PUBLIC_WEB_URL must use https/);
  });

  it("disables docs by default in production", () => {
    const config = loadConfig({ ...base, NODE_ENV: "production", CORS_ORIGINS: "https://app.example.com" });
    expect(config.docsEnabled).toBe(false);
    expect(config.isProduction).toBe(true);
  });
});

describe("R2 storage configuration", () => {
  const r2 = { R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", R2_ACCESS_KEY_ID: "0123456789abcdef01", R2_SECRET_ACCESS_KEY: "s".repeat(40), R2_BUCKET: "houzzhills-media" };

  it("is off unless configured, so photos stay in PostgreSQL", () => {
    expect(loadConfig(base).storage.r2).toBeNull();
  });

  it("derives the endpoint from the account id and normalises the public URL", () => {
    const config = loadConfig({ ...base, ...r2, R2_PUBLIC_URL: "https://media.houzzhills.com/" });
    expect(config.storage.r2).toMatchObject({
      endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
      bucket: "houzzhills-media",
      publicUrl: "https://media.houzzhills.com",
    });
  });

  it("rejects a partial or unsafe configuration", () => {
    expect(issuesOf({ ...base, R2_BUCKET: "houzzhills-media" }).join()).toContain("R2 needs");
    expect(issuesOf({ ...base, ...r2, R2_BUCKET: "Bad_Bucket" }).join()).toContain("R2_BUCKET");
    const production = { ...base, ...r2, NODE_ENV: "production", CORS_ORIGINS: "https://app.example.com", R2_PUBLIC_URL: "http://media.example.com" };
    expect(issuesOf(production).join()).toContain("R2_PUBLIC_URL must use https in production");
  });
});

