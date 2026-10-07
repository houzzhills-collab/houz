import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Errors } from "../../lib/errors.js";
import { normalizeReference, startGuestCheckout } from "./booking.service.js";
import { CODE_TTL_MINUTES, endSession, findGuestBooking, listGuestBookings, requestAccessCode, sessionEmail, verifyAccessCode } from "./guest-bookings.service.js";
import { AccessCodeSchema, EndGuestSessionSchema, GuestBookingsSchema, GuestCheckoutSchema, GuestSessionSchema, LookupBookingSchema } from "./public.schemas.js";

const normalizedEmail = (email: string) => email.trim().toLowerCase();

function reference(input: string): string {
  const normalized = normalizeReference(input);
  if (!normalized) throw Errors.notFound("We couldn't find a booking with that reference and email", "BOOKING_NOT_FOUND");
  return normalized;
}

/**
 * "My bookings" for guests, with no account: a booking opens with its reference
 * and email, and all of an email's bookings open with a one-time code emailed
 * to it. Emails travel in POST bodies so they stay out of URLs and logs.
 */
const guestBookingRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.addHook("onSend", async (_request, reply) => {
    reply.header("cache-control", "no-store");
  });

  app.post("/lookup", { schema: LookupBookingSchema, config: { rateLimit: { max: 10, timeWindow: 60_000 } } }, async (request) => ({
    booking: await findGuestBooking(app, reference(request.body.reference), normalizedEmail(request.body.email)),
  }));

  app.post("/checkout", { schema: GuestCheckoutSchema, config: { rateLimit: { max: 10, timeWindow: 60_000 } } }, async (request) =>
    startGuestCheckout(app, { reference: reference(request.body.reference), email: normalizedEmail(request.body.email) }),
  );

  app.post("/access-code", { schema: AccessCodeSchema, config: { rateLimit: { max: 5, timeWindow: 60_000 } } }, async (request, reply) => {
    await requestAccessCode(app, normalizedEmail(request.body.email));
    return reply.status(202).send({ expiresMinutes: CODE_TTL_MINUTES });
  });

  app.post("/session", { schema: GuestSessionSchema, config: { rateLimit: { max: 10, timeWindow: 60_000 } } }, async (request) => {
    const email = normalizedEmail(request.body.email);
    return { ...(await verifyAccessCode(app, email, request.body.code)), email };
  });

  app.get("/", { schema: GuestBookingsSchema, config: { rateLimit: { max: 60, timeWindow: 60_000 } } }, async (request) => {
    const email = await sessionEmail(app, request.headers["x-guest-session"]);
    return { email, bookings: await listGuestBookings(app, email) };
  });

  app.delete("/session", { schema: EndGuestSessionSchema, config: { rateLimit: { max: 30, timeWindow: 60_000 } } }, async (request, reply) => {
    await endSession(app, request.headers["x-guest-session"]);
    return reply.status(204).send(null);
  });
};

export default guestBookingRoutes;
