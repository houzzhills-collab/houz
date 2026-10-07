"use client";

import { useEffect, useState } from "react";
import { CreditCard, Pencil, Plus, Search } from "lucide-react";
import { api, errorMessage, type PaymentMethod, type Reference, type Reservation, type ReservationStatus, type Room } from "@/lib/api";
import { dateLabel, dateTimeLabel, humanize, initials, money, optionLabel, text, toKobo } from "../format";
import { DetailList, Drawer, Empty, Field, InlineError, Modal, useAction, useConfirm, useResource, type Notify, type SectionProps } from "../ui";

const STATUS_TONE: Record<string, string> = { checked_in: "status-green", confirmed: "status-gold", pending_payment: "status-gold", hold: "status-gold", checked_out: "status-blue" };

export function StatusBadge({ status, reference }: { status: string; reference: Reference }) {
  return (
    <span className={`status ${STATUS_TONE[status] ?? "status-red"}`}>
      <i />
      {optionLabel(reference.reservationStatuses, status)}
    </span>
  );
}

const nightsOf = (row: Reservation) => Math.round((Date.parse(row.check_out) - Date.parse(row.check_in)) / 86_400_000);

function ReservationPayments({ reservation, reference, refreshKey }: { reservation: Reservation; reference: Reference; refreshKey: string }) {
  const payments = useResource(() => api.reservations.payments(reservation.id), `${reservation.id}:${refreshKey}`);
  return (
    <section className="detail-section">
      <h3>Payments</h3>
      <InlineError message={payments.error} />
      {payments.data?.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>DATE</th>
                <th>METHOD</th>
                <th>AMOUNT</th>
                <th>STATUS</th>
              </tr>
            </thead>
            <tbody>
              {payments.data.map((payment) => (
                <tr key={payment.id}>
                  <td>{dateTimeLabel(payment.created_at)}</td>
                  <td>
                    {optionLabel(reference.paymentMethods, payment.method)}
                    {payment.reference && payment.method !== "online" ? <small className="field-hint"> {payment.reference}</small> : null}
                  </td>
                  <td className="booking-amount">{money(payment.amount_kobo)}</td>
                  <td>{humanize(payment.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !payments.loading && <Empty text="No payments recorded yet." />
      )}
    </section>
  );
}

/** Edits what the API allows for this reservation (`actions.edit`). */
function EditReservationModal({ reservation, notify, onClose, onSaved }: { reservation: Reservation; notify: Notify; onClose: () => void; onSaved: () => void }) {
  const scope = reservation.actions.edit ?? "none";
  const rooms = useResource<Room[]>(
    () => (scope === "full" ? api.rooms.list().then((list) => list.filter((room) => room.id === reservation.room_id || (room.active !== false && !["maintenance", "out_of_order"].includes(room.status)))) : Promise.resolve([])),
    `edit-${reservation.id}`,
  );
  const action = useAction();
  return (
    <Modal
      title={`Edit ${reservation.reference}`}
      description={
        scope === "full"
          ? "Moving dates or room re-checks availability and re-prices the stay. The same room keeps its agreed nightly price."
          : scope === "stay_end"
            ? "The guest is checked in, so only the check-out date, guest count and guest details can change."
            : "This booking is awaiting online payment, so only the guest's details can change."
      }
      busy={action.busy}
      error={action.error || rooms.error}
      wide
      onClose={onClose}
      onSubmit={(values) =>
        action.run(async () => {
          const optional = (name: string) => text(values.get(name)) || null;
          await api.reservations.updateDetails(reservation.id, {
            name: text(values.get("name")),
            email: optional("email"),
            phone: optional("phone"),
            notes: optional("notes"),
            ...(scope === "full" ? { roomId: text(values.get("roomId")), checkIn: text(values.get("checkIn")) } : {}),
            ...(scope === "full" || scope === "stay_end" ? { checkOut: text(values.get("checkOut")), guests: Number(values.get("guests")) } : {}),
          });
          notify(`${reservation.reference} updated`);
          onSaved();
        })
      }
    >
      <p className="form-section-title">Guest</p>
      <Field label="Guest full name">
        <input name="name" required maxLength={120} defaultValue={reservation.guest_name} />
      </Field>
      <div className="form-row">
        <Field label="Email">
          <input name="email" type="email" maxLength={254} defaultValue={reservation.email ?? ""} />
        </Field>
        <Field label="Phone">
          <input name="phone" type="tel" maxLength={32} pattern="[\+0-9 \(\)\-]*" defaultValue={reservation.phone ?? ""} />
        </Field>
      </div>
      {scope !== "contact" && <p className="form-section-title">Stay</p>}
      {scope === "full" && (
        <Field label="Room">
          <select name="roomId" required defaultValue={reservation.room_id}>
            {(rooms.data ?? []).map((room) => (
              <option key={room.id} value={room.id}>
                {room.room_number} · {room.room_type} · {money(room.nightly_rate_kobo)}/night · sleeps {room.capacity}
              </option>
            ))}
          </select>
        </Field>
      )}
      {scope !== "contact" && (
        <div className="form-row">
          {scope === "full" && (
            <Field label="Check in">
              <input name="checkIn" type="date" required defaultValue={reservation.check_in} />
            </Field>
          )}
          <Field label="Check out">
            <input name="checkOut" type="date" required defaultValue={reservation.check_out} />
          </Field>
          <Field label="Guests">
            <input name="guests" type="number" min="1" max="12" required defaultValue={reservation.guests_count ?? 1} />
          </Field>
        </div>
      )}
      <Field label="Notes">
        <textarea name="notes" maxLength={2000} rows={3} defaultValue={reservation.notes ?? ""} />
      </Field>
    </Modal>
  );
}

/**
 * Everything staff do with a reservation, shared by Overview and Reservations:
 * the detail drawer, editing, payments and stay changes. Render `dialogs`.
 */
export function useReservationActions(notify: Notify, onChanged: () => void, reference: Reference, rows: Reservation[] = [], initialOpenId: string | null = null) {
  const [paying, setPaying] = useState<Reservation | null>(null);
  const [editing, setEditing] = useState<Reservation | null>(null);
  const [openId, setOpenId] = useState<string | null>(initialOpenId);
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [version, setVersion] = useState(0);
  const action = useAction();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const changed = () => {
    setVersion((value) => value + 1);
    onChanged();
  };

  const changeStatus = async (reservation: Reservation, status: ReservationStatus) => {
    const label = optionLabel(reference.reservationStatuses, status).toLowerCase();
    const destructive = status === "cancelled" || status === "no_show";
    const accepted = await confirm(
      destructive
        ? {
            title: status === "cancelled" ? `Cancel ${reservation.reference}?` : `Mark ${reservation.reference} as a no-show?`,
            message: `${reservation.guest_name}'s stay will be marked ${label} and the room released. The guest is emailed.`,
            confirmLabel: status === "cancelled" ? "Cancel reservation" : "Mark no-show",
            danger: true,
            reason: "Reason (recorded in the audit log)",
          }
        : { title: `${status === "checked_in" ? "Check in" : "Check out"} ${reservation.guest_name}?`, message: `${reservation.reference} will be marked ${label}.`, confirmLabel: status === "checked_in" ? "Check in" : "Check out" },
    );
    if (accepted === null) return;
    try {
      await api.reservations.updateStatus(reservation.id, status, accepted || undefined);
      notify(`${reservation.reference} updated`);
      changed();
    } catch (error) {
      notify(errorMessage(error, "Reservation update failed"));
    }
  };

  const outstanding = paying ? BigInt(paying.amount_kobo) - BigInt(paying.paid_kobo ?? "0") : 0n;
  const open = rows.find((row) => row.id === openId) ?? null;

  const startPayment = (reservation: Reservation) => {
    action.clearError();
    setMethod((reference.staffPaymentMethods[0]?.value ?? "cash") as PaymentMethod);
    setPaying(reservation);
  };

  const dialogs = (
    <>
      {open && (
        <Drawer
          title={open.guest_name}
          subtitle={open.reference}
          badge={<StatusBadge status={open.status} reference={reference} />}
          onClose={() => setOpenId(null)}
          actions={
            <>
              {open.actions.next_statuses
                .filter((status) => status === "cancelled" || status === "no_show")
                .map((status) => (
                  <button
                    key={status}
                    className="button-ghost-danger"
                    data-tip={status === "cancelled" ? "Releases the room and emails the guest. A reason is required." : "The guest didn't arrive. Releases the room."}
                    onClick={() => void changeStatus(open, status)}
                  >
                    {status === "cancelled" ? "Cancel" : "No-show"}
                  </button>
                ))}
              <span className="spacer" />
              {open.actions.edit && open.actions.edit !== "none" && (
                <button className="button-secondary" onClick={() => setEditing(open)}>
                  <Pencil size={15} /> Edit
                </button>
              )}
              {open.actions.record_payment && (
                <button className="button-secondary" onClick={() => startPayment(open)}>
                  <CreditCard size={15} /> Record payment
                </button>
              )}
              {open.actions.next_statuses
                .filter((status) => status === "checked_in" || status === "checked_out")
                .map((status) => (
                  <button key={status} className="button-primary" onClick={() => void changeStatus(open, status)}>
                    {status === "checked_in" ? "Check in" : "Check out"}
                  </button>
                ))}
            </>
          }
        >
          <DetailList
            title="Stay"
            rows={[
              ["Room", open.room_number ? `${open.room_type} · ${open.room_number}` : open.room_type],
              ["Check in", dateLabel(open.check_in)],
              ["Check out", dateLabel(open.check_out)],
              ["Nights", String(nightsOf(open))],
              ["Guests", open.guests_count ? String(open.guests_count) : null],
              ["Booked", open.source === "public_website" ? "Online, through the website" : open.source ? "By staff" : null],
              ["Created", open.created_at ? dateTimeLabel(open.created_at) : null],
            ]}
          />
          <DetailList
            title="Guest"
            rows={[
              ["Name", open.guest_name],
              ["Email", open.email],
              ["Phone", open.phone],
              ["Notes", open.notes],
            ]}
          />
          <DetailList
            title="Money"
            rows={[
              ["Stay total", money(open.amount_kobo)],
              ["Paid", money(open.paid_kobo ?? "0")],
              ["Balance", money(BigInt(open.amount_kobo) - BigInt(open.paid_kobo ?? "0"))],
              ["Payment status", optionLabel(reference.paymentStatuses, open.payment_status)],
            ]}
          />
          <ReservationPayments reservation={open} reference={reference} refreshKey={String(version)} />
        </Drawer>
      )}
      {editing && (
        <EditReservationModal
          reservation={editing}
          notify={notify}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            changed();
          }}
        />
      )}
      {paying && (
        <Modal
          title="Record guest payment"
          description="Cash and POS terminal payments settle at once. Bank transfers wait for owner or manager confirmation."
          busy={action.busy}
          error={action.error}
          onClose={() => setPaying(null)}
          onSubmit={(values) =>
            action.run(async () => {
              const result = await api.reservations.recordPayment(paying.id, {
                amountKobo: toKobo(values.get("amount")),
                method,
                paymentReference: text(values.get("paymentReference")),
                idempotencyKey: crypto.randomUUID(),
              });
              notify(result.paymentStatus === "pending" ? `Transfer awaiting confirmation · ${paying.reference}` : `Payment recorded for ${paying.reference}`);
              setPaying(null);
              changed();
            })
          }
        >
          <p className="payment-reference">
            {paying.guest_name} · {paying.reference} · outstanding {money(outstanding)}
          </p>
          <div className="form-row">
            <Field label="Amount received (₦)">
              <input name="amount" type="number" min="1" step="1" defaultValue={Number(outstanding) / 100} required />
            </Field>
            <Field label="Payment method">
              <select value={method} onChange={(event) => setMethod(event.target.value as PaymentMethod)}>
                {reference.staffPaymentMethods.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Bank transfer reference or sender name">
            <input name="paymentReference" maxLength={120} required={method === "bank_transfer"} />
          </Field>
        </Modal>
      )}
      {confirmDialog}
    </>
  );

  return { changeStatus, startPayment, openReservation: (row: Reservation) => setOpenId(row.id), dialogs };
}

/** Renders the actions the API allows for each reservation; it holds no rules of its own. */
export function ReservationTable({
  rows,
  reference,
  onStatus,
  onPay,
  onOpen,
}: {
  rows: Reservation[];
  reference: Reference;
  onStatus: (reservation: Reservation, status: ReservationStatus) => void;
  onPay: (reservation: Reservation) => void;
  /** Opens the reservation's detail drawer. */
  onOpen?: (reservation: Reservation) => void;
}) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>GUEST</th>
            <th>ROOM</th>
            <th>STAY DATES</th>
            <th>BOOKING VALUE</th>
            <th>STATUS</th>
            <th>ACTION</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const { next_statuses: nextStatuses, record_payment: canPay } = row.actions;
            const menu = nextStatuses.filter((status) => status !== "checked_out");
            return (
              <tr key={row.id} className={onOpen ? "row-link" : undefined} onClick={() => onOpen?.(row)}>
                <td>
                  <div className="guest-cell">
                    <span className="guest-avatar tone-gold">{initials(row.guest_name)}</span>
                    <div>
                      <strong>{row.guest_name}</strong>
                      <small>
                        {row.reference} · {optionLabel(reference.paymentStatuses, row.payment_status)}
                      </small>
                    </div>
                  </div>
                </td>
                <td>{row.room_number ? `${row.room_type} · ${row.room_number}` : row.room_type}</td>
                <td>
                  {dateLabel(row.check_in)} — {dateLabel(row.check_out)}
                </td>
                <td className="booking-amount">{money(row.amount_kobo)}</td>
                <td>
                  <StatusBadge status={row.status} reference={reference} />
                </td>
                <td onClick={(event) => event.stopPropagation()}>
                  <div className="reservation-actions">
                    {canPay && (
                      <button className="text-link" onClick={() => onPay(row)}>
                        Record payment
                      </button>
                    )}
                    {menu.length > 0 && (
                      <select className="inline-select" value="" onChange={(event) => event.target.value && onStatus(row, event.target.value as ReservationStatus)} aria-label={`Update ${row.reference}`}>
                        <option value="">Stay action</option>
                        {menu.map((status) => (
                          <option key={status} value={status}>
                            {optionLabel(reference.reservationStatuses, status)}
                          </option>
                        ))}
                      </select>
                    )}
                    {nextStatuses.includes("checked_out") && (
                      <button className="text-link" onClick={() => onStatus(row, "checked_out")}>
                        Check out
                      </button>
                    )}
                    {!canPay && nextStatuses.length === 0 && <span className="quiet-action">—</span>}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && <Empty text="No reservations in this view." />}
    </div>
  );
}

/** Staff booking for a specific room. Loads bookable rooms when opened. */
export function NewReservationModal({ notify, onClose, onCreated }: { notify: Notify; onClose: () => void; onCreated: () => void }) {
  const rooms = useResource<Room[]>(() => api.rooms.list().then((list) => list.filter((room) => room.active !== false && !["maintenance", "out_of_order"].includes(room.status))), "new-reservation");
  const action = useAction();
  return (
    <Modal
      title="Create reservation"
      description="Priced from the room rate. Overlapping stays are rejected."
      busy={action.busy}
      error={action.error || rooms.error}
      onClose={onClose}
      onSubmit={(values) =>
        action.run(async () => {
          const reservation = await api.reservations.create({
            name: text(values.get("name")),
            email: text(values.get("email")),
            phone: text(values.get("phone")),
            roomId: text(values.get("roomId")),
            checkIn: text(values.get("checkIn")),
            checkOut: text(values.get("checkOut")),
            guests: Number(values.get("guests") ?? 1),
            notes: text(values.get("notes")),
          });
          notify(`Reservation ${reservation.reference} created`);
          onCreated();
        })
      }
    >
      <Field label="Guest full name">
        <input name="name" required maxLength={120} />
      </Field>
      <div className="form-row">
        <Field label="Email">
          <input name="email" type="email" maxLength={254} />
        </Field>
        <Field label="Phone">
          <input name="phone" type="tel" maxLength={32} />
        </Field>
      </div>
      <Field label="Room">
        <select name="roomId" required defaultValue="">
          <option value="" disabled>
            {rooms.loading ? "Loading rooms…" : "Select a room"}
          </option>
          {(rooms.data ?? []).map((room) => (
            <option key={room.id} value={room.id}>
              {room.room_number} · {room.room_type} · {money(room.nightly_rate_kobo)}/night · sleeps {room.capacity}
            </option>
          ))}
        </select>
      </Field>
      <div className="form-row">
        <Field label="Check in">
          <input name="checkIn" type="date" required />
        </Field>
        <Field label="Check out">
          <input name="checkOut" type="date" required />
        </Field>
      </div>
      <Field label="Guests">
        <input name="guests" type="number" min="1" max="12" defaultValue="1" required />
      </Field>
      <Field label="Notes (optional)">
        <textarea name="notes" maxLength={2000} rows={2} />
      </Field>
    </Modal>
  );
}

export function ReservationsSection({ notify, refreshKey, can, reference, focus }: SectionProps) {
  const [search, setSearch] = useState(focus?.query ?? "");
  const [query, setQuery] = useState(focus?.query ?? "");
  const [creating, setCreating] = useState(focus?.intent === "create");
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [search]);
  const reservations = useResource(() => api.reservations.list({ q: query || undefined }), `${refreshKey}:${query}`);
  const rows = reservations.data ?? [];
  const actions = useReservationActions(notify, () => void reservations.reload(), reference, rows, focus?.id ?? null);

  return (
    <>
      <section className="panel bookings-panel full-panel">
        <div className="panel-heading bookings-heading">
          <div>
            <h2>Reservations</h2>
            <p>Search stays and manage arrivals, departures and payments.</p>
          </div>
          <div className="heading-actions">
            <span className="booking-count">{rows.length} shown</span>
            {can("reservations:write") && (
              <button className="button-primary" onClick={() => setCreating(true)} data-tip="Book a guest into a specific room" data-tip-pos="bottom">
                <Plus size={16} /> New reservation
              </button>
            )}
          </div>
        </div>
        <div className="booking-toolbar">
          <div className="booking-tabs">
            <span className="active">{query ? `Matching “${query}”` : "Most recent"}</span>
          </div>
          <div className="booking-tools">
            <div className="table-search">
              <Search size={15} />
              <input placeholder="Search guest or reference" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search reservations" />
            </div>
          </div>
        </div>
        <InlineError message={reservations.error} />
        <ReservationTable rows={rows} reference={reference} onStatus={(row, status) => void actions.changeStatus(row, status)} onPay={actions.startPayment} onOpen={actions.openReservation} />
      </section>
      {actions.dialogs}
      {creating && (
        <NewReservationModal
          notify={notify}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void reservations.reload();
          }}
        />
      )}
    </>
  );
}
