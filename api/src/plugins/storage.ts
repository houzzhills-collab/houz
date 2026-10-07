import fp from "fastify-plugin";
import { R2Storage } from "../lib/object-storage.js";

/**
 * Object storage for uploads: Cloudflare R2 when configured, otherwise null
 * and uploads are kept in PostgreSQL (convenient for development and tests).
 */
export default fp(
  async (app) => {
    const { r2, timeoutMs } = app.config.storage;
    app.decorate("storage", r2 ? new R2Storage(r2, timeoutMs) : null);
    if (r2) app.log.info({ bucket: r2.bucket, publicUrl: r2.publicUrl }, "uploads stored in Cloudflare R2");
    else if (app.config.isProduction) app.log.warn("R2 is not configured: apartment photos are stored in PostgreSQL");
  },
  { name: "storage" },
);
