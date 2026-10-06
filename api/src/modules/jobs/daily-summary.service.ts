import type { FastifyInstance } from "fastify";
import { withTransaction } from "../../db/sql.js";
import { BUSINESS_TIMEZONE, addDays, businessToday } from "../../lib/dates.js";
import { queueAlert } from "../email/queue.js";
import type { DailySummary } from "../email/templates.js";

type SummaryRow = Omit<DailySummary, "date" | "occupancyPercent" | "settledYesterdayKobo"> & { sellableRooms: number; occupiedTonight: number };

const LOCAL_DATE = (column: string) => `(${column} AT TIME ZONE '${BUSINESS_TIMEZONE}')::date`;

/**
 * Morning summary for owners and managers: today's arrivals, departures and
 * occupancy, yesterday's money, and anything waiting on a person. Run once a
 * day (e.g. 07:00 Africa/Lagos); re-running the same day queues nothing new.
 */
export async function queueDailySummaries(app: FastifyInstance, now: Date = new Date()): Promise<{ date: string; queued: number }> {
  const date = businessToday(now);
  const yesterday = addDays(date, -1);
  const queued = await withTransaction(app.db, async (tx) => {
    const properties = await tx.rows<{ id: string }>(`SELECT id FROM properties ORDER BY created_at, id`);
    let total = 0;
    for (const property of properties) {
      const row = await tx.one<SummaryRow>(
        `SELECT
           (SELECT count(*)::int FROM reservations WHERE property_id = $1 AND check_in = $2::date AND status IN ('confirmed', 'checked_in')) AS arrivals,
           (SELECT count(*)::int FROM reservations WHERE property_id = $1 AND check_out = $2::date AND status IN ('checked_in', 'checked_out')) AS departures,
           (SELECT count(*)::int FROM reservations WHERE property_id = $1 AND status = 'checked_in') AS "inHouse",
           (SELECT count(*)::int FROM reservations
             WHERE property_id = $1 AND status IN ('confirmed', 'checked_in') AND check_in <= $2::date AND check_out > $2::date) AS "occupiedTonight",
           (SELECT count(*)::int FROM rooms WHERE property_id = $1 AND active AND status NOT IN ('maintenance', 'out_of_order')) AS "sellableRooms",
           (SELECT count(*)::int FROM rooms WHERE property_id = $1 AND active AND status IN ('maintenance', 'out_of_order')) AS "roomsOutOfService",
           (SELECT count(*)::int FROM reservations
             WHERE property_id = $1 AND ${LOCAL_DATE("created_at")} = $3::date AND status <> 'expired') AS "newBookings",
           (SELECT coalesce(sum(amount_kobo), 0)::text FROM payments
             WHERE property_id = $1 AND status = 'settled' AND ${LOCAL_DATE("coalesce(settled_at, created_at)")} = $3::date) AS "accommodationYesterdayKobo",
           (SELECT coalesce(sum(total_kobo), 0)::text FROM pos_orders
             WHERE property_id = $1 AND status <> 'voided' AND payment_status = 'settled'
               AND ${LOCAL_DATE("coalesce(payment_confirmed_at, created_at)")} = $3::date) AS "restaurantYesterdayKobo",
           (SELECT count(*)::int FROM (
              SELECT id FROM payments WHERE property_id = $1 AND method = 'bank_transfer' AND status = 'pending'
              UNION ALL
              SELECT id FROM pos_orders WHERE property_id = $1 AND payment_method = 'bank_transfer' AND payment_status = 'pending' AND status <> 'voided') t) AS "pendingTransfers",
           (SELECT coalesce(sum(amount), 0)::text FROM (
              SELECT amount_kobo AS amount FROM payments WHERE property_id = $1 AND method = 'bank_transfer' AND status = 'pending'
              UNION ALL
              SELECT total_kobo FROM pos_orders WHERE property_id = $1 AND payment_method = 'bank_transfer' AND payment_status = 'pending' AND status <> 'voided') t) AS "pendingTransfersKobo",
           (SELECT count(*)::int FROM payment_exceptions WHERE property_id = $1 AND status = 'open') AS "openExceptions",
           (SELECT count(*)::int FROM inventory_items WHERE property_id = $1 AND active AND quantity <= reorder_level) AS "lowStockItems"`,
        [property.id, date, yesterday],
      );
      const { sellableRooms, occupiedTonight, ...counts } = row;
      const summary: DailySummary = {
        ...counts,
        date,
        occupancyPercent: sellableRooms > 0 ? Math.min(100, Math.round((occupiedTonight / sellableRooms) * 100)) : null,
        settledYesterdayKobo: (BigInt(row.accommodationYesterdayKobo) + BigInt(row.restaurantYesterdayKobo)).toString(),
      };
      total += await queueAlert(tx, {
        propertyId: property.id,
        template: "alert.daily_summary",
        data: summary,
        roles: ["owner", "manager"],
        dedupeKey: `alert.daily_summary:${date}`,
      });
    }
    return total;
  });
  return { date, queued };
}
