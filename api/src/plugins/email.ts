import fp from "fastify-plugin";
import { EmailService } from "../modules/email/email.service.js";

/**
 * Email delivery through Resend, configured by the owner in Settings. The
 * dispatcher only runs when the API server calls `app.email.start()`, so job
 * runs and tests never send in the background.
 */
export default fp(
  async (app) => {
    const email = new EmailService(app.db, app.settings, app.config, app.log.child({ module: "email" }));
    app.decorate("email", email);
    app.addHook("onClose", async () => {
      await email.stop();
    });
  },
  { name: "email", dependencies: ["database", "payments"] },
);
