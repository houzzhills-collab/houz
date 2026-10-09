"use client";

import { useState } from "react";
import { Archive, ArrowDownRight, Pencil, Plus, RotateCcw } from "lucide-react";
import { api, errorMessage, type InventoryItem, type StockMovementInput } from "@/lib/api";
import { dateTimeLabel, humanize, money, text, toKobo } from "../format";
import { DetailList, Drawer, Empty, Field, InlineError, Modal, Tip, useAction, useConfirm, useResource, type SectionProps } from "../ui";

const quantity = (value: string | number, unit: string) => `${Number(value)} ${unit}`;

function MovementHistory({ item, refreshKey }: { item: InventoryItem; refreshKey: number }) {
  const movements = useResource(() => api.inventory.movements(item.id), `${item.id}:${refreshKey}`);
  return (
    <section className="detail-section">
      <h3>
        Stock ledger
        <Tip text="Every change to this item's stock, newest first: deliveries, wastage, count corrections and restaurant sales. Stock only changes through these entries, so the history always adds up to the quantity on hand." />
      </h3>
      <InlineError message={movements.error} />
      {movements.data?.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th data-tip="Date and time the movement was recorded.">WHEN</th>
                <th data-tip="What kind of change it was: a purchase (stock received), wastage (written off), an adjustment (count correction) or a sale (deducted by a restaurant order through its recipe).">MOVEMENT</th>
                <th data-tip="How much the quantity on hand went up (+) or down (−), in the item's unit.">CHANGE</th>
                <th data-tip="The reason or supplier reference given, and the staff member who recorded it.">REASON</th>
              </tr>
            </thead>
            <tbody>
              {movements.data.map((movement) => (
                <tr key={movement.id}>
                  <td>{dateTimeLabel(movement.created_at)}</td>
                  <td>{humanize(movement.type)}</td>
                  <td className="booking-amount">
                    {Number(movement.quantity_delta) > 0 ? "+" : ""}
                    {Number(movement.quantity_delta)}
                  </td>
                  <td>
                    {movement.reason ?? "—"}
                    {movement.reference ? ` · ${movement.reference}` : ""}
                    {movement.recorded_by ? <small className="field-hint"> {movement.recorded_by}</small> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !movements.loading && <Empty text="No movements recorded yet." />
      )}
    </section>
  );
}

export function InventorySection({ notify, refreshKey, can, reference, focus }: SectionProps) {
  const [showArchived, setShowArchived] = useState(Boolean(focus?.id));
  const items = useResource(() => api.inventory.list({ includeArchived: true }), String(refreshKey));
  const [dialog, setDialog] = useState<{ kind: "item"; item: InventoryItem | null } | { kind: "movement"; itemId?: string } | null>(
    focus?.intent === "create" ? { kind: "item", item: null } : focus?.intent === "movement" ? { kind: "movement" } : null,
  );
  const [openId, setOpenId] = useState<string | null>(focus?.id ?? null);
  const action = useAction();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const all = items.data ?? [];
  const active = all.filter((item) => item.active !== false);
  const list = showArchived ? all : active;
  const archived = all.length - active.length;
  const open = all.find((item) => item.id === openId) ?? null;
  const writer = can("inventory:write");

  const close = () => {
    action.clearError();
    setDialog(null);
  };
  const done = async (message: string) => {
    notify(message);
    close();
    await items.reload();
  };

  const setActive = async (item: InventoryItem, next: boolean) => {
    const accepted = await confirm(
      next
        ? { title: `Restore ${item.name}?`, message: "It returns to the stock list and can be used in recipes again.", confirmLabel: "Restore item" }
        : { title: `Archive ${item.name}?`, message: "It leaves the stock list and can't be used in recipes. Its ledger is kept and you can restore it later.", confirmLabel: "Archive item", danger: true },
    );
    if (accepted === null) return;
    try {
      await api.inventory.updateItem(item.id, { active: next });
      notify(`${item.name} ${next ? "restored" : "archived"}`);
      await items.reload();
    } catch (error) {
      notify(errorMessage(error, "Unable to update the item"));
    }
  };

  return (
    <section className="panel bookings-panel full-panel">
      <div className="panel-heading bookings-heading">
        <div>
          <h2>
            Stock control
            <Tip text="The store's stock items. Each row shows how much is on hand now, when to reorder, and what one unit costs. Select an item to see its full movement history." />
          </h2>
          <p>Every change to stock is a movement with its reason and staff member. Restaurant sales deduct stock through menu recipes.</p>
        </div>
        <div className="heading-actions">
          {archived > 0 && (
            <label className="table-filter" data-tip="Archived items are hidden from stock lists and recipes" data-tip-pos="bottom">
              <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> Show archived ({archived})
            </label>
          )}
          <span className="booking-count" data-tip="Items at or below their reorder level" data-tip-pos="bottom">
            {active.filter((item) => item.low_stock).length} low stock
          </span>
          {writer && (
            <>
              <button className="button-secondary" onClick={() => setDialog({ kind: "movement" })} disabled={active.length === 0} data-tip="Receive a delivery, write off wastage or correct a count" data-tip-pos="bottom">
                <ArrowDownRight size={15} /> Record movement
              </button>
              <button className="button-primary" onClick={() => setDialog({ kind: "item", item: null })}>
                <Plus size={16} /> Add item
              </button>
            </>
          )}
        </div>
      </div>
      <InlineError message={items.error} />
      {list.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th data-tip="The stock item's name.">ITEM</th>
                <th data-tip="Stock keeping unit: your own short code for the item, e.g. a shelf or supplier code. Optional.">SKU</th>
                <th data-tip="How much is in the store right now, in the item's unit (bottle, kg, piece…). It goes up with deliveries and down with sales, wastage and count corrections.">ON HAND</th>
                <th data-tip="The reorder level. When the quantity on hand falls to this figure or below, the item is flagged “Reorder needed” and managers are alerted.">REORDER AT</th>
                <th data-tip="What one unit of the item costs to buy. Used to value the stock.">UNIT COST</th>
                <th data-tip="In stock: above the reorder level. Reorder needed: at or below it. Archived: retired from the stock list and recipes.">STATUS</th>
              </tr>
            </thead>
            <tbody>
              {list.map((item) => (
                <tr key={item.id} className={`row-link ${item.active === false ? "row-muted" : ""}`} onClick={() => setOpenId(item.id)}>
                  <td className="booking-amount">{item.name}</td>
                  <td>{item.sku ?? "—"}</td>
                  <td>{quantity(item.quantity, item.unit)}</td>
                  <td>{quantity(item.reorder_level, item.unit)}</td>
                  <td>{money(item.cost_kobo)}</td>
                  <td>
                    <span className={`status ${item.active === false || item.low_stock ? "status-red" : "status-green"}`}>
                      <i />
                      {item.active === false ? "Archived" : item.low_stock ? "Reorder needed" : "In stock"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !items.loading && <Empty text="No stock items yet. Add store items, then link them to menu items so sales deduct stock." />
      )}

      {open && (
        <Drawer
          title={open.name}
          subtitle={open.sku ? `SKU ${open.sku}` : undefined}
          badge={
            <span className={`status ${open.active === false || open.low_stock ? "status-red" : "status-green"}`}>
              <i />
              {open.active === false ? "Archived" : open.low_stock ? "Reorder needed" : "In stock"}
            </span>
          }
          onClose={() => setOpenId(null)}
          actions={
            writer && (
              <>
                {open.active === false ? (
                  <button className="button-secondary" onClick={() => void setActive(open, true)}>
                    <RotateCcw size={15} /> Restore
                  </button>
                ) : (
                  <button className="button-ghost-danger" onClick={() => void setActive(open, false)} data-tip="Hides it from stock lists. The ledger is kept and you can restore it.">
                    <Archive size={15} /> Archive
                  </button>
                )}
                <span className="spacer" />
                {open.active !== false && (
                  <button className="button-secondary" onClick={() => setDialog({ kind: "movement", itemId: open.id })}>
                    <ArrowDownRight size={15} /> Record movement
                  </button>
                )}
                <button className="button-primary" onClick={() => setDialog({ kind: "item", item: open })}>
                  <Pencil size={15} /> Edit item
                </button>
              </>
            )
          }
        >
          <DetailList
            title="Stock"
            rows={[
              ["On hand", quantity(open.quantity, open.unit), "How much is in the store right now."],
              ["Reorder at", quantity(open.reorder_level, open.unit), "When stock falls to this level or below, the item is flagged for reordering."],
              ["Unit cost", money(open.cost_kobo), "What one unit costs to buy."],
              ["Stock value", money(Number(open.cost_kobo) * Number(open.quantity)), "On hand × unit cost: what the stock currently in the store is worth."],
            ]}
          />
          <MovementHistory item={open} refreshKey={refreshKey} />
        </Drawer>
      )}

      {dialog?.kind === "item" && (
        <Modal
          title={dialog.item ? `Edit ${dialog.item.name}` : "Add inventory item"}
          description={dialog.item ? "Changing the quantity on hand records a stock count adjustment in the ledger, with your reason." : undefined}
          submitLabel={dialog.item ? "Save changes" : "Add item"}
          busy={action.busy}
          error={action.error}
          onClose={close}
          onSubmit={(values) =>
            action.run(async () => {
              const fields = { name: text(values.get("name")), unit: text(values.get("unit")), reorderLevel: Number(values.get("reorderLevel")), costKobo: toKobo(values.get("cost")) };
              if (dialog.item) {
                const onHand = Number(values.get("quantity"));
                const counted = dialog.item.active !== false && onHand !== Number(dialog.item.quantity);
                const quantityReason = text(values.get("quantityReason"));
                if (counted && !quantityReason) throw new Error("Give a reason for changing the quantity on hand");
                await api.inventory.updateItem(dialog.item.id, { ...fields, sku: text(values.get("sku")) || null, ...(counted ? { quantity: onHand, quantityReason } : {}) });
                await done(`${fields.name} updated`);
              } else {
                await api.inventory.createItem({ ...fields, sku: text(values.get("sku")), quantity: Number(values.get("quantity")) });
                await done("Inventory item added");
              }
            })
          }
        >
          <div className="form-row">
            <Field label="Item name" tip="What the item is called on stock lists and in menu recipes, e.g. “Eggs” or “Coca-Cola 50cl”.">
              <input name="name" required maxLength={120} defaultValue={dialog.item?.name} />
            </Field>
            <Field label="SKU (optional)" tip="Stock keeping unit: a short code of your own (shelf, supplier or barcode number) to tell similar items apart. Must be unique.">
              <input name="sku" maxLength={60} defaultValue={dialog.item?.sku ?? ""} />
            </Field>
          </div>
          <div className="form-row">
            <Field label="Unit" tip="How the item is counted: bottle, kg, litre, piece, crate… Quantities, reorder levels and recipes all use this unit.">
              <input name="unit" defaultValue={dialog.item?.unit ?? "unit"} required maxLength={20} placeholder="bottle, kg, piece" />
            </Field>
            <Field
              label={dialog.item ? "On hand" : "Opening quantity"}
              tip={
                dialog.item
                  ? "The quantity actually in the store now, e.g. after a physical count. If it differs from the recorded figure, the difference is saved in the ledger as a count adjustment."
                  : "How much you have in the store when you add the item. It's recorded in the ledger as opening stock."
              }
              hint={dialog.item?.active === false ? "Restore the item to change its stock." : undefined}>
              <input name="quantity" type="number" min="0" step="0.001" defaultValue={dialog.item ? Number(dialog.item.quantity) : 0} disabled={dialog.item?.active === false} required />
            </Field>
          </div>
          {dialog.item && dialog.item.active !== false && (
            <Field label="Reason for changing the quantity" tip="Why the quantity on hand is being corrected. It's saved in the stock ledger with your name." hint="Needed only if you change the quantity on hand, e.g. “Monthly stock count”.">
              <input name="quantityReason" maxLength={300} />
            </Field>
          )}
          <div className="form-row">
            <Field label="Reorder at" tip="The reorder level. When stock on hand falls to this figure or below, the item shows “Reorder needed” and managers get a low-stock alert. Use 0 to turn this off.">
              <input name="reorderLevel" type="number" min="0" step="0.001" defaultValue={dialog.item ? Number(dialog.item.reorder_level) : 0} required />
            </Field>
            <Field label="Unit cost (₦)" tip="What you pay for one unit, in naira. Used to value stock on hand.">
              <input name="cost" type="number" min="0" step="1" defaultValue={dialog.item ? Number(dialog.item.cost_kobo) / 100 : 0} required />
            </Field>
          </div>
        </Modal>
      )}

      {dialog?.kind === "movement" && (
        <Modal
          title="Record stock movement"
          description="Receive deliveries, write off wastage, or correct a count. Stock can never go below zero."
          busy={action.busy}
          error={action.error}
          onClose={close}
          onSubmit={(values) =>
            action.run(async () => {
              await api.inventory.recordMovement({
                action: text(values.get("action")) as StockMovementInput["action"],
                itemId: text(values.get("itemId")),
                quantity: Number(values.get("quantity")),
                reason: text(values.get("reason")),
              });
              await done("Stock movement recorded");
            })
          }
        >
          <Field label="Inventory item" tip="The stock item this movement applies to. The figure after the name is the quantity on hand now.">
            <select name="itemId" required defaultValue={dialog.itemId}>
              {active.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {quantity(item.quantity, item.unit)}
                </option>
              ))}
            </select>
          </Field>
          <div className="form-row">
            <Field label="Movement" tip="Receive stock: a delivery or purchase, adds stock. Record wastage: spoiled, broken or expired items, removes stock. Count adjustment: corrects the figure after a physical count (+ adds, − removes).">
              <select name="action">
                {reference.stockMovements.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Quantity" tip="How much stock moved, in the item's unit. Up to 3 decimal places, e.g. 2.5 kg." hint="For a count correction, use a negative number to reduce stock.">
              <input name="quantity" type="number" step="0.001" required />
            </Field>
          </div>
          <Field label="Reason / supplier reference" tip="Why stock changed, or the supplier's invoice or delivery number. Saved in the ledger with your name.">
            <input name="reason" required maxLength={300} />
          </Field>
        </Modal>
      )}
      {confirmDialog}
    </section>
  );
}
