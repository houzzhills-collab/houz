"use client";

import { useState } from "react";
import { Archive, ArrowDownRight, Pencil, Plus, RotateCcw } from "lucide-react";
import { api, errorMessage, type InventoryItem, type StockMovementInput } from "@/lib/api";
import { dateTimeLabel, humanize, money, text, toKobo } from "../format";
import { DetailList, Drawer, Empty, Field, InlineError, Modal, useAction, useConfirm, useResource, type SectionProps } from "../ui";

const quantity = (value: string | number, unit: string) => `${Number(value)} ${unit}`;

function MovementHistory({ item, refreshKey }: { item: InventoryItem; refreshKey: number }) {
  const movements = useResource(() => api.inventory.movements(item.id), `${item.id}:${refreshKey}`);
  return (
    <section className="detail-section">
      <h3>Stock ledger</h3>
      <InlineError message={movements.error} />
      {movements.data?.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>WHEN</th>
                <th>MOVEMENT</th>
                <th>CHANGE</th>
                <th>REASON</th>
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
          <h2>Stock control</h2>
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
                <th>ITEM</th>
                <th>SKU</th>
                <th>ON HAND</th>
                <th>REORDER AT</th>
                <th>UNIT COST</th>
                <th>STATUS</th>
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
              ["On hand", quantity(open.quantity, open.unit)],
              ["Reorder at", quantity(open.reorder_level, open.unit)],
              ["Unit cost", money(open.cost_kobo)],
              ["Stock value", money(Number(open.cost_kobo) * Number(open.quantity))],
            ]}
          />
          <MovementHistory item={open} refreshKey={refreshKey} />
        </Drawer>
      )}

      {dialog?.kind === "item" && (
        <Modal
          title={dialog.item ? `Edit ${dialog.item.name}` : "Add inventory item"}
          description={dialog.item ? "To change the quantity on hand, record a movement so the ledger stays complete." : undefined}
          submitLabel={dialog.item ? "Save changes" : "Add item"}
          busy={action.busy}
          error={action.error}
          onClose={close}
          onSubmit={(values) =>
            action.run(async () => {
              const fields = { name: text(values.get("name")), unit: text(values.get("unit")), reorderLevel: Number(values.get("reorderLevel")), costKobo: toKobo(values.get("cost")) };
              if (dialog.item) {
                await api.inventory.updateItem(dialog.item.id, { ...fields, sku: text(values.get("sku")) || null });
                await done(`${fields.name} updated`);
              } else {
                await api.inventory.createItem({ ...fields, sku: text(values.get("sku")), quantity: Number(values.get("quantity")) });
                await done("Inventory item added");
              }
            })
          }
        >
          <div className="form-row">
            <Field label="Item name">
              <input name="name" required maxLength={120} defaultValue={dialog.item?.name} />
            </Field>
            <Field label="SKU (optional)">
              <input name="sku" maxLength={60} defaultValue={dialog.item?.sku ?? ""} />
            </Field>
          </div>
          <div className="form-row">
            <Field label="Unit">
              <input name="unit" defaultValue={dialog.item?.unit ?? "unit"} required maxLength={20} placeholder="bottle, kg, piece" />
            </Field>
            {!dialog.item && (
              <Field label="Opening quantity">
                <input name="quantity" type="number" min="0" step="0.001" defaultValue="0" required />
              </Field>
            )}
          </div>
          <div className="form-row">
            <Field label="Reorder at">
              <input name="reorderLevel" type="number" min="0" step="0.001" defaultValue={dialog.item ? Number(dialog.item.reorder_level) : 0} required />
            </Field>
            <Field label="Unit cost (₦)">
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
          <Field label="Inventory item">
            <select name="itemId" required defaultValue={dialog.itemId}>
              {active.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {quantity(item.quantity, item.unit)}
                </option>
              ))}
            </select>
          </Field>
          <div className="form-row">
            <Field label="Movement">
              <select name="action">
                {reference.stockMovements.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Quantity" hint="For a count correction, use a negative number to reduce stock.">
              <input name="quantity" type="number" step="0.001" required />
            </Field>
          </div>
          <Field label="Reason / supplier reference">
            <input name="reason" required maxLength={300} />
          </Field>
        </Modal>
      )}
      {confirmDialog}
    </section>
  );
}
