import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { withConnection, withTransaction } from "../../db/sql.js";
import { Errors } from "../../lib/errors.js";
import { recordEvent } from "../../lib/events.js";
import { NextCursor, PageQuery, decodeCursor, toPage } from "../../lib/pagination.js";
import { IdParams, KoboInput, KoboString, Nullable, Quantity, QuantityString, StringEnum, Text, Timestamp, Uuid, errorResponses, toQuantityText } from "../../lib/schemas.js";
import { optionalText } from "../../lib/text.js";
import { requirePrincipal } from "../auth/principal.js";
import { alertLowStock } from "../email/notifications.js";

const security = [{ bearerAuth: [] }];
type InventoryRow = {
  id: string;
  name: string;
  sku: string | null;
  unit: string;
  quantity: string;
  reorder_level: string;
  cost_kobo: string;
  low_stock: boolean;
  active: boolean;
};

const MOVEMENT_TYPES = { receive: "purchase", adjust: "adjustment", wastage: "wastage" } as const;

function quantityText(value: number, field: string): string {
  const text = toQuantityText(value);
  if (text === null) throw Errors.unprocessable(`${field} can have at most 3 decimal places`, "VALIDATION_FAILED");
  return text;
}

/**
 * Stock is a movement ledger: every change to an item's quantity writes a
 * stock_movements row with its reason and staff member (PRD §3).
 */
const inventoryRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    "/",
    {
      preHandler: app.authorize("inventory:read"),
      schema: {
        tags: ["inventory"],
        summary: "Inventory items with low-stock indicators",
        description: "Archived items are left out unless `includeArchived` is true.",
        security,
        querystring: Type.Object({ ...PageQuery, includeArchived: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
        response: {
          200: Type.Object({
            items: Type.Array(
              Type.Object({
                id: Uuid,
                name: Type.String(),
                sku: Nullable(Type.String()),
                unit: Type.String(),
                quantity: QuantityString,
                reorder_level: QuantityString,
                cost_kobo: KoboString,
                low_stock: Type.Boolean(),
                active: Type.Boolean(),
              }),
            ),
            nextCursor: NextCursor,
          }),
          ...errorResponses(401, 403, 422),
        },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      const limit = request.query.limit ?? 50;
      const cursor = decodeCursor(request.query.cursor, 2);
      const rows = await withConnection(app.db, (sql) =>
        sql.rows<InventoryRow>(
          `SELECT id, name, sku, unit, quantity::text, reorder_level::text, cost_kobo::text, (active AND quantity <= reorder_level) AS low_stock, active
             FROM inventory_items
            WHERE property_id = $1 AND (active OR $5) AND ($2::text IS NULL OR (name, id) > ($2::text, $3::uuid))
            ORDER BY name, id
            LIMIT $4`,
          [principal.propertyId, cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1, request.query.includeArchived ?? false],
        ),
      );
      const page = toPage(rows, limit, (row) => [row.name, row.id]);
      return { items: page.items, nextCursor: page.nextCursor };
    },
  );

  app.post(
    "/items",
    {
      preHandler: app.authorize("inventory:write"),
      schema: {
        tags: ["inventory"],
        summary: "Create an inventory item",
        description: "Opening stock, if any, is recorded as a purchase movement.",
        security,
        body: Type.Object(
          {
            name: Text(120),
            sku: Type.Optional(Type.String({ maxLength: 60 })),
            unit: Type.Optional(Text(20)),
            quantity: Type.Optional(Quantity({ minimum: 0 })),
            reorderLevel: Type.Optional(Quantity({ minimum: 0 })),
            costKobo: Type.Optional(KoboInput),
          },
          { additionalProperties: false },
        ),
        response: { 201: Type.Object({ item: Type.Object({ id: Uuid }) }), ...errorResponses(401, 403, 409, 422) },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const body = request.body;
      const name = body.name.trim();
      if (!name) throw Errors.unprocessable("Enter the item name", "VALIDATION_FAILED");
      const quantity = quantityText(body.quantity ?? 0, "quantity");
      const reorderLevel = quantityText(body.reorderLevel ?? 0, "reorderLevel");
      const item = await withTransaction(app.db, async (tx) => {
        const created = await tx.one<{ id: string }>(
          `INSERT INTO inventory_items(property_id, name, sku, unit, quantity, reorder_level, cost_kobo)
           VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, $7) RETURNING id`,
          [principal.propertyId, name, optionalText(body.sku), optionalText(body.unit) ?? "unit", quantity, reorderLevel, body.costKobo ?? 0],
        );
        if (Number(quantity) > 0) {
          await tx.exec(
            `INSERT INTO stock_movements(property_id, item_id, movement_type, quantity_delta, reason, recorded_by)
             VALUES ($1, $2, 'purchase', $3::numeric, 'Opening stock', $4)`,
            [principal.propertyId, created.id, quantity, principal.userId],
          );
        }
        await recordEvent(tx, {
          propertyId: principal.propertyId,
          actorId: principal.userId,
          action: "inventory.item_created",
          entityType: "inventory_item",
          entityId: created.id,
          details: { name, quantity },
          outbox: { reference: name },
        });
        return created;
      });
      return reply.status(201).send({ item });
    },
  );

  app.patch(
    "/items/:id",
    {
      preHandler: app.authorize("inventory:write"),
      schema: {
        tags: ["inventory"],
        summary: "Edit, archive or restore an inventory item",
        description:
          "Quantity changes only through movements, so the ledger stays complete. `active: false` archives the item (refused while an active menu item's recipe uses it); its movement history is kept.",
        security,
        params: IdParams,
        body: Type.Object(
          {
            name: Type.Optional(Text(120)),
            sku: Type.Optional(Nullable(Type.String({ maxLength: 60 }))),
            unit: Type.Optional(Text(20)),
            reorderLevel: Type.Optional(Quantity({ minimum: 0 })),
            costKobo: Type.Optional(KoboInput),
            active: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false, minProperties: 1 },
        ),
        response: { 200: Type.Object({ id: Uuid }), ...errorResponses(401, 403, 404, 409, 422) },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      const body = request.body;
      const name = body.name?.trim();
      const unit = body.unit?.trim();
      if (name === "" || unit === "") throw Errors.unprocessable("Name and unit cannot be blank", "VALIDATION_FAILED");
      const reorderLevel = body.reorderLevel === undefined ? null : quantityText(body.reorderLevel, "reorderLevel");
      return withTransaction(app.db, async (tx) => {
        const item = await tx.maybeOne<{ name: string; active: boolean }>(
          `SELECT name, active FROM inventory_items WHERE id = $1 AND property_id = $2 FOR UPDATE`,
          [request.params.id, principal.propertyId],
        );
        if (!item) throw Errors.notFound("Inventory item not found");
        if (body.active === false && item.active) {
          const used = await tx.rows<{ name: string }>(
            `SELECT m.name FROM menu_recipes mr JOIN menu_items m ON m.id = mr.menu_item_id WHERE mr.inventory_item_id = $1 AND m.active ORDER BY m.name`,
            [request.params.id],
          );
          if (used.length > 0) throw Errors.conflict(`Used in the recipe for ${used.map((row) => row.name).join(", ")}. Change those menu items first.`, "ITEM_IN_RECIPE");
        }
        if (body.sku?.trim()) {
          const taken = await tx.maybeOne(`SELECT 1 FROM inventory_items WHERE property_id = $1 AND sku = $2 AND id <> $3`, [principal.propertyId, body.sku.trim(), request.params.id]);
          if (taken) throw Errors.conflict("Another item already uses this SKU", "SKU_TAKEN");
        }
        await tx.exec(
          `UPDATE inventory_items SET name = coalesce($2, name), sku = CASE WHEN $3 THEN $4 ELSE sku END, unit = coalesce($5, unit),
                                      reorder_level = coalesce($6::numeric, reorder_level), cost_kobo = coalesce($7, cost_kobo), active = coalesce($8, active)
            WHERE id = $1`,
          [request.params.id, name ?? null, body.sku !== undefined, optionalText(body.sku ?? undefined), unit ?? null, reorderLevel, body.costKobo ?? null, body.active ?? null],
        );
        await recordEvent(tx, {
          propertyId: principal.propertyId,
          actorId: principal.userId,
          action: body.active === false ? "inventory.item_archived" : body.active === true && !item.active ? "inventory.item_restored" : "inventory.item_updated",
          entityType: "inventory_item",
          entityId: request.params.id,
          details: { name, sku: body.sku, unit, reorderLevel, costKobo: body.costKobo, active: body.active },
          outbox: { type: "inventory.stock_changed", reference: name ?? item.name },
        });
        return { id: request.params.id };
      });
    },
  );

  app.get(
    "/items/:id/movements",
    {
      preHandler: app.authorize("inventory:read"),
      schema: {
        tags: ["inventory"],
        summary: "An item's stock movements, newest first (latest 200)",
        security,
        params: IdParams,
        response: {
          200: Type.Object({
            movements: Type.Array(
              Type.Object({
                id: Uuid,
                type: Type.String(),
                quantity_delta: QuantityString,
                reason: Nullable(Type.String()),
                reference: Nullable(Type.String()),
                recorded_by: Nullable(Type.String()),
                created_at: Timestamp,
              }),
            ),
          }),
          ...errorResponses(401, 403, 404),
        },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      return withConnection(app.db, async (sql) => {
        const exists = await sql.maybeOne(`SELECT 1 FROM inventory_items WHERE id = $1 AND property_id = $2`, [request.params.id, principal.propertyId]);
        if (!exists) throw Errors.notFound("Inventory item not found");
        const movements = await sql.rows<{ id: string; type: string; quantity_delta: string; reason: string | null; reference: string | null; recorded_by: string | null; created_at: Date }>(
          `SELECT sm.id, sm.movement_type AS type, sm.quantity_delta::text, sm.reason, sm.reference, u.full_name AS recorded_by, sm.created_at
             FROM stock_movements sm LEFT JOIN users u ON u.id = sm.recorded_by
            WHERE sm.item_id = $1 ORDER BY sm.created_at DESC, sm.id DESC LIMIT 200`,
          [request.params.id],
        );
        return { movements };
      });
    },
  );

  app.post(
    "/movements",
    {
      preHandler: app.authorize("inventory:write"),
      schema: {
        tags: ["inventory"],
        summary: "Record a stock movement",
        description: "`receive` adds stock, `wastage` removes it, `adjust` applies a signed count correction. Stock can never go negative.",
        security,
        body: Type.Object(
          {
            action: StringEnum(["receive", "adjust", "wastage"] as const),
            itemId: Uuid,
            quantity: Quantity(),
            reason: Text(300),
            reference: Type.Optional(Type.String({ maxLength: 120 })),
          },
          { additionalProperties: false },
        ),
        response: { 200: Type.Object({ stock: Type.Object({ itemId: Uuid, quantity: QuantityString }) }), ...errorResponses(401, 403, 404, 409, 422) },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      const { action, itemId, reason } = request.body;
      const magnitude = quantityText(Math.abs(request.body.quantity), "quantity");
      if (Number(magnitude) === 0) throw Errors.unprocessable("Enter a non-zero quantity", "VALIDATION_FAILED");
      if (action !== "adjust" && request.body.quantity < 0) throw Errors.unprocessable("Enter a positive quantity", "VALIDATION_FAILED");
      const delta = action === "wastage" || (action === "adjust" && request.body.quantity < 0) ? `-${magnitude}` : magnitude;
      if (!reason.trim()) throw Errors.unprocessable("Give a reason for the movement", "VALIDATION_FAILED");

      return withTransaction(app.db, async (tx) => {
        const updated = await tx.maybeOne<{ quantity: string; name: string; unit: string; reorder_level: string; crossed_low: boolean }>(
          `UPDATE inventory_items SET quantity = quantity + $3::numeric
            WHERE id = $1 AND property_id = $2 AND active AND quantity + $3::numeric >= 0
            RETURNING quantity::text, name, unit, reorder_level::text,
                      (quantity <= reorder_level AND quantity - $3::numeric > reorder_level) AS crossed_low`,
          [itemId, principal.propertyId, delta],
        );
        if (!updated) {
          const exists = await tx.maybeOne(`SELECT 1 FROM inventory_items WHERE id = $1 AND property_id = $2 AND active`, [itemId, principal.propertyId]);
          if (!exists) throw Errors.notFound("Inventory item not found");
          throw Errors.conflict("Not enough stock for this movement", "INSUFFICIENT_STOCK");
        }
        await tx.exec(
          `INSERT INTO stock_movements(property_id, item_id, movement_type, quantity_delta, reason, reference, recorded_by)
           VALUES ($1, $2, $3, $4::numeric, $5, $6, $7)`,
          [principal.propertyId, itemId, MOVEMENT_TYPES[action], delta, reason.trim(), optionalText(request.body.reference), principal.userId],
        );
        await recordEvent(tx, {
          propertyId: principal.propertyId,
          actorId: principal.userId,
          action: `inventory.${action}`,
          entityType: "inventory_item",
          entityId: itemId,
          details: { quantityDelta: delta, reason: reason.trim() },
          outbox: { type: "inventory.stock_changed", reference: updated.name },
        });
        if (updated.crossed_low) {
          const cause = action === "wastage" ? "recorded wastage" : "a stock count adjustment";
          await alertLowStock(tx, principal.propertyId, [{ name: updated.name, unit: updated.unit, quantity: updated.quantity, reorderLevel: updated.reorder_level }], cause);
        }
        return { stock: { itemId, quantity: updated.quantity } };
      });
    },
  );
};

export default inventoryRoutes;
