"use client";

import { useRef, useState } from "react";
import { Archive, Banknote, Check, Clock3, CreditCard, Landmark, LogOut, Minus, Pencil, Plus, RotateCcw, Search, ShoppingBag, Trash2, X, type LucideIcon } from "lucide-react";
import { api, errorMessage, type InventoryItem, type MenuItem, type PaymentMethod, type Receipt } from "@/lib/api";
import { dateTimeLabel, money, optionLabel, text, timeLabel, toKobo } from "../format";
import { Empty, Field, InlineError, Modal, Tip, useAction, useConfirm, useResource, type SectionProps } from "../ui";

const METHOD_ICONS: Record<string, LucideIcon> = { cash: Banknote, pos: CreditCard, bank_transfer: Landmark };
const METHOD_TIPS: Record<string, string> = {
  cash: "Paid in cash. Settled at once and a receipt is issued.",
  pos: "Paid by card on the POS terminal. Settled at once and a receipt is issued.",
  bank_transfer: "Paid by bank transfer. Recorded as pending; the receipt is issued once an owner or manager confirms the money arrived.",
};

/** Exact amount, then the next round notes a customer is likely to hand over (in naira). */
function quickCashAmounts(totalKobo: bigint): number[] {
  const exact = Number(totalKobo) / 100;
  if (exact <= 0) return [];
  const rounded = [1_000, 5_000, 10_000].map((step) => Math.ceil(exact / step) * step);
  return [...new Set([exact, ...rounded])].filter((amount) => amount >= exact).slice(0, 4);
}

type Dialog = { kind: "shift-open" } | { kind: "shift-close" } | { kind: "menu-new" } | { kind: "menu-edit"; item: MenuItem };

function ReceiptModal({ receipt, methodLabel, onClose }: { receipt: Receipt; methodLabel: string; onClose: () => void }) {
  return (
    <Modal title="Restaurant receipt" description={receipt.receipt_number} onClose={onClose}>
      <div className="receipt-paper">
        <h3>{receipt.property_name}</h3>
        <p>RECEIPT · {receipt.receipt_number}</p>
        {receipt.items.map((item, index) => (
          <div className="receipt-line" key={index}>
            <span>
              {item.quantity} × {item.item_name}
            </span>
            <b>{money(item.line_total_kobo)}</b>
          </div>
        ))}
        <div className="receipt-total">
          <span>TOTAL · {methodLabel.toUpperCase()}</span>
          <strong>{money(receipt.total_kobo)}</strong>
        </div>
        <small>
          {dateTimeLabel(receipt.created_at)} · Served by {receipt.cashier}
        </small>
        <small>Thank you for dining with us.</small>
      </div>
      <button type="button" className="button-primary" onClick={() => window.print()}>
        Print receipt
      </button>
    </Modal>
  );
}

function RecipeEditor({ stock, lines, onChange }: { stock: InventoryItem[]; lines: { itemId: string; quantity: string }[]; onChange: (lines: { itemId: string; quantity: string }[]) => void }) {
  return (
    <div className="recipe-editor">
      <div className="recipe-editor-heading">
        <strong>
          Recipe stock usage
          <Tip text="The stock items one serving uses. Each sale deducts these quantities from Inventory automatically, so stock stays accurate without manual entries." />
        </strong>
        <button type="button" className="text-link" onClick={() => onChange([...lines, { itemId: "", quantity: "1" }])}>
          <Plus size={13} /> Add ingredient
        </button>
      </div>
      {lines.map((line, index) => (
        <div className="form-row recipe-row" key={index}>
          <Field label="Inventory item" tip="A stock item this menu item uses, e.g. Eggs for an omelette. The unit after the name is how it's counted.">
            <select value={line.itemId} onChange={(event) => onChange(lines.map((entry, i) => (i === index ? { ...entry, itemId: event.target.value } : entry)))}>
              <option value="">Choose a stock item</option>
              {stock.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.unit}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Quantity per order" tip="How much of the stock item one serving uses, in its unit, e.g. 3 (eggs) or 0.25 (kg). Up to 3 decimal places.">
            <input type="number" min="0.001" step="0.001" value={line.quantity} onChange={(event) => onChange(lines.map((entry, i) => (i === index ? { ...entry, quantity: event.target.value } : entry)))} />
          </Field>
          {lines.length > 1 && (
            <button type="button" className="recipe-remove" aria-label="Remove ingredient" onClick={() => onChange(lines.filter((_, i) => i !== index))}>
              <X size={15} />
            </button>
          )}
        </div>
      ))}
      <p className="modal-help">
        {lines.some((line) => line.itemId)
          ? "These quantities are deducted from stock every time this item is sold."
          : "Not linked to stock: selling this item won't change inventory. For a drink or packaged item, pick its stock item with quantity 1."}
      </p>
    </div>
  );
}

/** How many of this item the stock on hand allows; null when it isn't linked to stock. */
function portionsLeft(item: MenuItem): number | null {
  if (item.recipe.length === 0 || item.recipe.some((line) => line.onHand === undefined)) return null;
  return Math.max(0, Math.min(...item.recipe.map((line) => Math.floor((line.onHand ?? 0) / line.quantity))));
}

const recipeLines = (item: MenuItem | null) =>
  item?.recipe.length ? item.recipe.map((line) => ({ itemId: line.itemId, quantity: String(line.quantity) })) : [{ itemId: "", quantity: "1" }];

function recipeFrom(lines: { itemId: string; quantity: string }[]) {
  const merged = new Map<string, number>();
  for (const line of lines.filter((entry) => entry.itemId)) merged.set(line.itemId, (merged.get(line.itemId) ?? 0) + Number(line.quantity));
  return [...merged].map(([itemId, quantity]) => ({ itemId, quantity }));
}

export function PosSection({ notify, refreshKey, can, reference }: SectionProps) {
  const overview = useResource(() => api.pos.overview(), String(refreshKey));
  const menu = useResource(() => api.menu.list({ includeArchived: can("menu:write") }), String(refreshKey));
  const stock = useResource(() => (can("inventory:read") ? api.inventory.list() : Promise.resolve([])), String(refreshKey));
  const [cart, setCart] = useState<Record<string, number>>({});
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [transferReference, setTransferReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [recipe, setRecipe] = useState([{ itemId: "", quantity: "1" }]);
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [cashReceived, setCashReceived] = useState("");
  const checkoutKey = useRef<string | null>(null);
  const action = useAction();
  const { confirm, dialog: confirmDialog } = useConfirm();

  const shift = overview.data?.shift ?? null;
  const orders = overview.data?.orders ?? [];
  const allItems = menu.data ?? [];
  const items = allItems.filter((item) => item.active !== false);
  const archivedItems = allItems.filter((item) => item.active === false);
  const lines = Object.entries(cart).filter(([, quantity]) => quantity > 0);
  const total = items.reduce((sum, item) => sum + BigInt(item.price_kobo) * BigInt(cart[item.id] ?? 0), 0n);
  const itemCount = lines.reduce((sum, [, quantity]) => sum + quantity, 0);
  const categories = [...new Set(items.map((item) => item.category))].sort((a, b) => a.localeCompare(b));
  const activeCategory = categories.includes(category) ? category : "All";
  const search = query.trim().toLowerCase();
  const visible = items.filter((item) => (activeCategory === "All" || item.category === activeCategory) && (!search || `${item.name} ${item.category}`.toLowerCase().includes(search)));
  const received = method === "cash" && cashReceived.trim() !== "" ? Math.round(Number(cashReceived) * 100) : null;
  const short = received !== null && received < Number(total);
  const quickCash = quickCashAmounts(total);
  const reloadAll = async () => {
    await Promise.all([overview.reload(), menu.reload(), stock.reload()]);
  };

  const showReceipt = async (orderId: string) => {
    try {
      setReceipt(await api.pos.receipt(orderId));
    } catch (error) {
      notify(errorMessage(error, "Receipt unavailable"));
    }
  };

  const checkout = async () => {
    if (!lines.length) return;
    setBusy(true);
    try {
      // The same key is reused if this sale is retried after a network failure.
      checkoutKey.current ??= crypto.randomUUID();
      const order = await api.pos.createOrder({
        items: lines.map(([menuItemId, quantity]) => ({ menuItemId, quantity })),
        paymentMethod: method,
        paymentReference: transferReference.trim(),
        idempotencyKey: checkoutKey.current,
      });
      checkoutKey.current = null;
      setCart({});
      setTransferReference("");
      setCashReceived("");
      await reloadAll();
      if (order.payment_status === "pending") notify(`Transfer submitted for confirmation · ${order.receipt_number}`);
      else {
        notify(`Receipt ${order.receipt_number} issued`);
        await showReceipt(order.id);
      }
    } catch (error) {
      notify(errorMessage(error, "Sale failed"));
    } finally {
      setBusy(false);
    }
  };

  const setActive = async (item: MenuItem, active: boolean) => {
    const accepted = await confirm(
      active
        ? { title: `Restore ${item.name}?`, message: "It returns to the till at its current price.", confirmLabel: "Restore item" }
        : { title: `Archive ${item.name}?`, message: "It disappears from the till. Past receipts are unchanged and you can restore it later.", confirmLabel: "Archive item", danger: true },
    );
    if (accepted === null) return;
    try {
      await api.menu.update(item.id, { active });
      notify(`${item.name} ${active ? "restored" : "archived"}`);
      await menu.reload();
    } catch (error) {
      notify(errorMessage(error, "Unable to update the item"));
    }
  };

  /** Sets an order line's quantity, within what the stock allows; 0 removes the line. */
  const setQuantity = (item: MenuItem, quantity: number) => {
    const left = portionsLeft(item);
    if (left !== null && quantity > left) {
      notify(`Only ${left} ${item.name} left in stock`);
      return;
    }
    setCart((current) => ({ ...current, [item.id]: Math.max(0, quantity) }));
  };

  const addToCart = (item: MenuItem) => setQuantity(item, (cart[item.id] ?? 0) + 1);

  const clearOrder = async () => {
    const accepted = await confirm({ title: "Clear this order?", message: "All items are removed from the current order. Nothing has been charged.", confirmLabel: "Clear order", danger: true });
    if (accepted === null) return;
    setCart({});
    setCashReceived("");
  };

  const closeDialog = () => {
    action.clearError();
    setDialog(null);
  };

  return (
    <>
      <InlineError message={overview.error || menu.error} />
      <div className={`pos-shift-bar ${shift ? "is-open" : ""}`}>
        <div className="pos-shift-status">
          <span className="pos-shift-dot" aria-hidden />
          <div>
            <strong data-tip="Sales are recorded against your open cashier shift" data-tip-pos="bottom">{shift ? `Shift open since ${timeLabel(shift.opened_at)}` : "No active shift"}</strong>
            <small>{shift ? `Opening float ${money(shift.opening_float_kobo)}` : can("pos:write") ? "Open a shift to start selling." : "Only cashiers can open a shift."}</small>
          </div>
        </div>
        <div className="heading-actions">
          {can("menu:write") && archivedItems.length > 0 && (
            <label className="table-filter">
              <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> Archived ({archivedItems.length})
            </label>
          )}
          {can("menu:write") && (
            <button
              className="button-secondary"
              data-tip="Add a dish or drink to the menu"
              data-tip-pos="bottom"
              onClick={() => {
                setRecipe(recipeLines(null));
                setDialog({ kind: "menu-new" });
              }}
            >
              <Plus size={15} /> Menu item
            </button>
          )}
          {shift ? (
            <button className="button-secondary" data-tip="Count the cash in the till and end your shift" data-tip-pos="bottom" onClick={() => setDialog({ kind: "shift-close" })}>
              <LogOut size={15} /> Close cashier shift
            </button>
          ) : (
            can("pos:write") && (
              <button className="button-primary" onClick={() => setDialog({ kind: "shift-open" })}>
                <Clock3 size={15} /> Open shift
              </button>
            )
          )}
        </div>
      </div>

      <div className="pos-layout">
        <section className="panel pos-menu-panel">
          <div className="panel-heading">
            <div>
              <h2>
                Menu
                <Tip text="The items the restaurant sells. Tap an item to add one to the order; tap again to add more. Each tile shows its price, how many are in the order, and how many portions the stock on hand allows. Items are greyed out when there's no open shift or not enough stock." />
              </h2>
              <p>Tap an item to add it to the order.</p>
            </div>
            <div className="table-search pos-search">
              <Search size={15} />
              <input placeholder="Search the menu" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search the menu" />
              {query && (
                <button type="button" aria-label="Clear search" onClick={() => setQuery("")}>
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
          {categories.length > 1 && (
            <div className="pos-categories" role="tablist" aria-label="Menu categories">
              {["All", ...categories].map((name) => (
                <button key={name} role="tab" aria-selected={category === name} className={category === name ? "active" : ""} onClick={() => setCategory(name)}>
                  {name}
                  <small>{name === "All" ? items.length : items.filter((item) => item.category === name).length}</small>
                </button>
              ))}
            </div>
          )}
          {visible.length ? (
            <div className="pos-menu-grid">
              {visible.map((item) => {
                const left = portionsLeft(item);
                const inOrder = cart[item.id] ?? 0;
                return (
                  <div className={`pos-menu-tile ${inOrder ? "in-order" : ""}`} key={item.id}>
                    <button className="pos-menu-item" disabled={!shift || !can("pos:write") || left === 0} onClick={() => addToCart(item)} aria-label={`Add ${item.name}, ${money(item.price_kobo)}`}>
                      <span>{item.category}</span>
                      <strong>{item.name}</strong>
                      <b>{money(item.price_kobo)}</b>
                      <small
                        className={`stock-hint ${left === null ? "none" : left === 0 ? "low" : left <= 5 ? "low" : "ok"}`}
                        data-tip={left === null ? "Selling this won't change inventory. Edit it to link a stock item." : "Portions the stock on hand allows; it goes down with every sale"}
                      >
                        {left === null ? "Not linked to stock" : left === 0 ? "Out of stock" : `${left} left in stock`}
                      </small>
                      {inOrder > 0 && (
                        <em className="pos-tile-count" aria-label={`${inOrder} in the order`}>
                          {inOrder}
                        </em>
                      )}
                    </button>
                    {can("menu:write") && (
                      <div className="pos-menu-tools">
                        <button
                          aria-label={`Edit ${item.name}`}
                          data-tip="Edit price, category or stock link"
                          onClick={() => {
                            setRecipe(recipeLines(item));
                            setDialog({ kind: "menu-edit", item });
                          }}
                        >
                          <Pencil size={13} />
                        </button>
                        <button aria-label={`Archive ${item.name}`} data-tip="Remove from the till (can be restored)" onClick={() => void setActive(item, false)}>
                          <Archive size={13} />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            !menu.loading && <Empty text={items.length ? "No menu items match your search." : "The menu is empty. A manager can add items once stock is configured."} />
          )}
          {showArchived && archivedItems.length > 0 && (
            <div className="archived-menu">
              <p className="form-section-title">Archived items</p>
              {archivedItems.map((item) => (
                <div className="pos-cart-line" key={item.id}>
                  <div>
                    <strong>{item.name}</strong>
                    <small>
                      {item.category} · {money(item.price_kobo)}
                    </small>
                  </div>
                  <button className="button-secondary" onClick={() => void setActive(item, true)}>
                    <RotateCcw size={14} /> Restore
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="panel pos-cart-panel" id="pos-order" aria-label="Current order">
          <div className="pos-cart-heading">
            <h2>
              <ShoppingBag size={17} /> Current order
              <Tip text="What the customer is buying. Use + and − to change quantities, or the bin to remove a line. Taking payment records the sale, deducts recipe stock and issues a receipt." />
            </h2>
            {lines.length > 0 && (
              <button className="text-link" onClick={() => void clearOrder()}>
                Clear
              </button>
            )}
          </div>
          <div className="pos-cart-lines">
            {lines.map(([id, quantity]) => {
              const item = items.find((entry) => entry.id === id);
              if (!item) return null;
              const left = portionsLeft(item);
              return (
                <div className="pos-cart-line" key={id}>
                  <div className="pos-line-name">
                    <strong>{item.name}</strong>
                    <small>{money(item.price_kobo)} each</small>
                  </div>
                  <div className="pos-stepper" role="group" aria-label={`Quantity of ${item.name}`}>
                    <button type="button" aria-label={`Remove one ${item.name}`} onClick={() => setQuantity(item, quantity - 1)}>
                      <Minus size={15} />
                    </button>
                    <output aria-live="polite">{quantity}</output>
                    <button type="button" aria-label={`Add one ${item.name}`} disabled={left !== null && quantity >= left} onClick={() => setQuantity(item, quantity + 1)}>
                      <Plus size={15} />
                    </button>
                  </div>
                  <b>{money(BigInt(item.price_kobo) * BigInt(quantity))}</b>
                  <button type="button" className="pos-line-remove" aria-label={`Remove ${item.name} from the order`} onClick={() => setQuantity(item, 0)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
            {lines.length === 0 && (
              <div className="pos-cart-empty">
                <ShoppingBag size={26} />
                <strong>No items yet</strong>
                <span>{shift ? "Tap items on the menu to add them." : "Open a shift, then tap items on the menu."}</span>
              </div>
            )}
          </div>
          <div className="pos-checkout">
            <div className="pos-summary">
              <span>Items</span>
              <span>{itemCount}</span>
            </div>
            <div className="pos-total">
              <span className="metric-label" data-tip="Sum of the items in this order at their current menu prices.">
                Total due
              </span>
              <strong>{money(total)}</strong>
            </div>
            <div className="pos-methods" role="radiogroup" aria-label="Payment method">
              {reference.posPaymentMethods.map((option) => {
                const Icon = METHOD_ICONS[option.value] ?? Banknote;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={method === option.value}
                    className={method === option.value ? "active" : ""}
                    data-tip={METHOD_TIPS[option.value]}
                    onClick={() => {
                      setMethod(option.value as PaymentMethod);
                      setTransferReference("");
                      setCashReceived("");
                    }}
                  >
                    <Icon size={18} />
                    {option.label}
                  </button>
                );
              })}
            </div>
            {method === "cash" && lines.length > 0 && (
              <div className="pos-cash">
                <Field label="Cash received (₦)" tip="Optional. Enter the cash the customer handed over to see the change to give back. It isn't saved.">
                  <input type="number" min="0" step="1" inputMode="numeric" value={cashReceived} onChange={(event) => setCashReceived(event.target.value)} placeholder={String(Number(total) / 100)} />
                </Field>
                <div className="pos-quick-cash">
                  {quickCash.map((amount) => (
                    <button key={amount} type="button" onClick={() => setCashReceived(String(amount))}>
                      {amount * 100 === Number(total) ? "Exact" : money(String(amount * 100))}
                    </button>
                  ))}
                </div>
                {received !== null && (
                  <p className={`pos-change ${short ? "short" : ""}`}>
                    {short ? `₦${((Number(total) - received) / 100).toLocaleString("en-NG")} short` : `Change to give: ${money(String(received - Number(total)))}`}
                  </p>
                )}
              </div>
            )}
            {method === "bank_transfer" && (
              <Field label="Transfer reference or sender name" tip="The bank transaction reference or the sender's account name, so the transfer can be matched to the bank statement and confirmed.">
                <input value={transferReference} onChange={(event) => setTransferReference(event.target.value)} maxLength={120} required />
              </Field>
            )}
            <button className="button-primary pos-charge" disabled={busy || !shift || !lines.length || short || (method === "bank_transfer" && !transferReference.trim())} onClick={() => void checkout()}>
              <Check size={17} />
              {busy ? "Saving…" : method === "bank_transfer" ? "Record transfer for confirmation" : "Take payment & issue receipt"}
            </button>
            {!shift && can("pos:write") && <p className="pos-charge-hint">Open a shift to take payments.</p>}
          </div>
        </section>
      </div>

      {lines.length > 0 && (
        <a className="pos-order-jump" href="#pos-order">
          <ShoppingBag size={16} /> View order · {itemCount} item{itemCount === 1 ? "" : "s"} · {money(total)}
        </a>
      )}

      <div className="pos-layout">
        <section className="panel bookings-panel pos-orders">
          <div className="panel-heading">
            <div>
              <h2>
                Today’s orders
                <Tip text="Restaurant orders recorded today by every cashier. Use Receipt to view or reprint one; bank transfer orders get a receipt once the transfer is confirmed." />
              </h2>
              <p>Orders from all cashiers today.</p>
            </div>
          </div>
          {orders.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th data-tip="The receipt number printed for the customer.">RECEIPT</th>
                    <th data-tip="When the order was recorded.">TIME</th>
                    <th data-tip="The cashier who took the order.">CASHIER</th>
                    <th data-tip="How the customer paid: cash, card/POS or bank transfer.">METHOD</th>
                    <th data-tip="The order total.">TOTAL</th>
                    <th data-tip="View or reprint the receipt. Bank transfer orders show “Awaiting confirmation” until an owner or manager confirms the money arrived." />
                  </tr>
                </thead>
                <tbody>
                  {orders.map((order) => (
                    <tr key={order.id}>
                      <td className="booking-amount">{order.receipt_number}</td>
                      <td>{timeLabel(order.created_at)}</td>
                      <td>{order.cashier}</td>
                      <td>{optionLabel(reference.posPaymentMethods, order.payment_method)}</td>
                      <td>{money(order.total_kobo)}</td>
                      <td>
                        <button className="text-link" disabled={order.payment_status === "pending"} onClick={() => void showReceipt(order.id)}>
                          {order.payment_status === "pending" ? "Awaiting confirmation" : "Receipt"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty text="No restaurant orders today." />
          )}
        </section>
      </div>

      {confirmDialog}
      {receipt && <ReceiptModal receipt={receipt} methodLabel={optionLabel(reference.posPaymentMethods, receipt.payment_method)} onClose={() => setReceipt(null)} />}

      {dialog?.kind === "shift-open" && (
        <Modal
          title="Open cashier shift"
          busy={action.busy}
          error={action.error}
          onClose={closeDialog}
          onSubmit={(values) =>
            action.run(async () => {
              await api.pos.openShift(toKobo(values.get("openingFloat")));
              notify("Cashier shift opened");
              closeDialog();
              await overview.reload();
            })
          }
        >
          <Field label="Opening cash float (₦)" tip="The cash already in the till when you start, e.g. change for customers. At closing, expected cash = this float + cash sales during the shift.">
            <input name="openingFloat" type="number" min="0" step="1" defaultValue="0" required />
          </Field>
        </Modal>
      )}

      {dialog?.kind === "shift-close" && (
        <Modal
          title="Close cashier shift"
          description="The cash variance against the opening float plus cash sales is recorded for manager review."
          busy={action.busy}
          error={action.error}
          onClose={closeDialog}
          onSubmit={(values) =>
            action.run(async () => {
              const result = await api.pos.closeShift(toKobo(values.get("countedCash")));
              notify(`Shift closed · cash variance ${money(result.varianceKobo)}`);
              closeDialog();
              await overview.reload();
            })
          }
        >
          <Field label="Counted cash at handover (₦)" tip="Count all the cash in the till now and enter the total. The difference from the expected cash (float + cash sales) is recorded as the variance for manager review.">
            <input name="countedCash" type="number" min="0" step="1" required />
          </Field>
        </Modal>
      )}

      {dialog?.kind === "menu-new" && (
        <Modal
          title="Add menu item"
          busy={action.busy}
          error={action.error}
          wide
          onClose={closeDialog}
          onSubmit={(values) =>
            action.run(async () => {
              await api.menu.create({ name: text(values.get("name")), category: text(values.get("category")), priceKobo: toKobo(values.get("price")), recipe: recipeFrom(recipe) });
              notify("Menu item added");
              closeDialog();
              await menu.reload();
            })
          }
        >
          <div className="form-row">
            <Field label="Item name" tip="The dish or drink as it appears on the menu and receipts, e.g. “Jollof rice & chicken”.">
              <input name="name" required maxLength={120} />
            </Field>
            <Field label="Category" tip="The menu section it belongs to, e.g. Breakfast, Mains, Drinks. Items are grouped by category.">
              <input name="category" required maxLength={60} placeholder="Breakfast" />
            </Field>
          </div>
          <Field label="Price (₦)" tip="The selling price in naira. Changing it only affects new orders; past receipts keep the price charged.">
            <input name="price" type="number" min="0" step="1" required />
          </Field>
          <RecipeEditor stock={stock.data ?? []} lines={recipe} onChange={setRecipe} />
        </Modal>
      )}

      {dialog?.kind === "menu-edit" && (
        <Modal
          title={`Edit ${dialog.item.name}`}
          description="Past receipts keep the name and price at the time of sale."
          wide
          busy={action.busy}
          error={action.error}
          onClose={closeDialog}
          onSubmit={(values) =>
            action.run(async () => {
              await api.menu.update(dialog.item.id, {
                name: text(values.get("name")),
                category: text(values.get("category")),
                priceKobo: toKobo(values.get("price")),
                recipe: recipeFrom(recipe),
              });
              notify(`${text(values.get("name"))} updated`);
              closeDialog();
              await menu.reload();
            })
          }
        >
          <div className="form-row">
            <Field label="Item name" tip="The dish or drink as it appears on the menu and receipts, e.g. “Jollof rice & chicken”.">
              <input name="name" required maxLength={120} defaultValue={dialog.item.name} />
            </Field>
            <Field label="Category" tip="The menu section it belongs to, e.g. Breakfast, Mains, Drinks. Items are grouped by category.">
              <input name="category" required maxLength={60} defaultValue={dialog.item.category} />
            </Field>
          </div>
          <Field label="Price (₦)" tip="The selling price in naira. Changing it only affects new orders; past receipts keep the price charged.">
            <input name="price" type="number" min="0" step="1" required defaultValue={Number(dialog.item.price_kobo) / 100} />
          </Field>
          <RecipeEditor stock={stock.data ?? []} lines={recipe} onChange={setRecipe} />
        </Modal>
      )}
    </>
  );
}
