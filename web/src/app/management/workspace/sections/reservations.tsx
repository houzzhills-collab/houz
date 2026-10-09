"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { CreditCard, IdCard, Pencil, Plus, Search } from "lucide-react";
import { api, errorMessage, type GuestIdInput, type GuestIdSide, type GuestIdType, type PaymentMethod, type Reference, type Reservation, type ReservationStatus, type Room } from "@/lib/api";
import { dateLabel, dateTimeLabel, humanize, initials, money, optionLabel, text, toKobo } from "../format";
import { DetailList, Drawer, Empty, Field, InlineError, Modal, Tip, useAction, useConfirm, useResource, type Notify, type SectionProps } from "../ui";

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
      <h3>
        Payments
        <Tip text="Every payment recorded against this booking: cash, POS, bank transfers and online checkouts, including ones still waiting for confirmation." />
      </h3>
      <InlineError message={payments.error} />
      {payments.data?.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th data-tip="When the payment was recorded.">DATE</th>
                <th data-tip="How the guest paid: cash, POS terminal, bank transfer or online checkout. The transfer reference or sender name is shown beside it.">METHOD</th>
                <th data-tip="How much was paid in this payment.">AMOUNT</th>
                <th data-tip="Settled: the money is confirmed. Pending: a bank transfer awaiting owner or manager confirmation, or an unfinished online checkout. Failed: the payment didn't go through.">STATUS</th>
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

/** Matches the API's per-photo limit, so oversized files are caught before upload. */
const MAX_ID_PHOTO_BYTES = 5 * 1024 * 1024;

/** ID photos need the bearer token, so they are fetched and shown from a local object URL. */
function GuestIdPhoto({ reservationId, side, version }: { reservationId: string; side: GuestIdSide; version: string }) {
  const key = `${reservationId}:${side}:${version}`;
  const [loaded, setLoaded] = useState<{ key: string; url: string | null }>({ key: "", url: null });
  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    api.reservations.identityImage(reservationId, side).then(
      (blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setLoaded({ key, url: objectUrl });
      },
      () => !cancelled && setLoaded({ key, url: null }),
    );
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [key, reservationId, side]);
  const url = loaded.key === key ? loaded.url : null;
  const failed = loaded.key === key && !loaded.url;
  const label = side === "front" ? "Front" : "Back";
  if (failed) return <span className="field-hint">{label}: could not load</span>;
  if (!url) return <span className="field-hint">{label}: loading…</span>;
  return (
    <a className="id-photo" href={url} target="_blank" rel="noreferrer" title={`Open the ${side} of the ID`}>
      <Image src={url} alt={`${label} of the guest's ID`} width={160} height={100} unoptimized />
      <small>{label}</small>
    </a>
  );
}

function GuestIdSection({ reservation, reference }: { reservation: Reservation; reference: Reference }) {
  const idDocument = reservation.guest_id_document;
  if (!idDocument) {
    return (
      <section className="detail-section">
        <h3>
          Guest ID
          <Tip text="The government-issued ID the guest showed, kept with the booking for security and records." />
        </h3>
        <Empty text={reservation.actions.identity ? "No ID recorded yet. Use “Guest ID” to add one." : "No ID recorded."} />
      </section>
    );
  }
  const sides = (["front", "back"] as const).filter((side) => idDocument[side]);
  return (
    <DetailList
      title="Guest ID"
      tip="The government-issued ID the guest showed, kept with the booking for security and records."
      rows={[
        ["ID type", optionLabel(reference.guestIdTypes, idDocument.id_type), "The kind of document: national ID (NIN), passport, driver's licence, voter's card or another government ID."],
        ["ID number", idDocument.id_number, "The number printed on the document."],
        [
          "Photos",
          sides.length ? (
            <div className="id-photos">
              {sides.map((side) => (
                <GuestIdPhoto key={side} reservationId={reservation.id} side={side} version={idDocument.updated_at} />
              ))}
            </div>
          ) : (
            "None"
          ),
          "Photos of the front and back of the card, if taken. Select one to open it full size.",
        ],
        ["Updated", dateTimeLabel(idDocument.updated_at), "When the ID details were last saved."],
      ]}
    />
  );
}

/** Records or changes the guest's government-issued ID. Photos of the card are optional. */
function GuestIdModal({ reservation, reference, notify, onClose, onSaved }: { reservation: Reservation; reference: Reference; notify: Notify; onClose: () => void; onSaved: () => void }) {
  const current = reservation.guest_id_document ?? null;
  const [remove, setRemove] = useState<Record<GuestIdSide, boolean>>({ front: false, back: false });
  const action = useAction();
  const { confirm, dialog } = useConfirm();

  const removeAll = async () => {
    const accepted = await confirm({
      title: "Remove this guest's ID?",
      message: `The ID type, number and any photos are deleted from ${reservation.reference}.`,
      confirmLabel: "Remove ID",
      danger: true,
    });
    if (accepted === null) return;
    await action.run(async () => {
      await api.reservations.deleteIdentity(reservation.id);
      notify(`Guest ID removed from ${reservation.reference}`);
      onSaved();
    });
  };

  return (
    <>
      <Modal
        title={current ? "Update guest ID" : "Add guest ID"}
        description={`${reservation.guest_name} · ${reservation.reference}. Photos of the front and back are optional (JPEG, PNG or WebP, up to 5 MB each).`}
        busy={action.busy}
        error={action.error}
        onClose={onClose}
        onSubmit={(values) =>
          action.run(async () => {
            const input: GuestIdInput = { idType: text(values.get("idType")) as GuestIdType, idNumber: text(values.get("idNumber")) };
            for (const side of ["front", "back"] as const) {
              const file = values.get(side);
              if (file instanceof File && file.size > 0) {
                if (file.size > MAX_ID_PHOTO_BYTES) throw new Error(`The ${side} photo is larger than 5 MB`);
                input[side] = file;
              } else if (remove[side]) {
                input[side] = "remove";
              }
            }
            await api.reservations.updateIdentity(reservation.id, input);
            notify(`Guest ID saved for ${reservation.reference}`);
            onSaved();
          })
        }
      >
        <div className="form-row">
          <Field label="ID type" tip="The kind of government-issued ID the guest showed: national ID (NIN), international passport, driver's licence, voter's card, or another government ID.">
            <select name="idType" required defaultValue={current?.id_type ?? ""}>
              <option value="" disabled>
                Select an ID type
              </option>
              {reference.guestIdTypes.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="ID number" tip="The number exactly as printed on the document, e.g. the 11-digit NIN or the passport number.">
            <input name="idNumber" required maxLength={64} autoComplete="off" defaultValue={current?.id_number ?? ""} />
          </Field>
        </div>
        <div className="form-row">
          {(["front", "back"] as const).map((side) => (
            <Field
              key={side}
              label={`${side === "front" ? "Front" : "Back"} of ID (optional)`}
              tip={`A clear photo of the ${side} of the card (JPEG, PNG or WebP, up to 5 MB). On a phone this opens the camera. Only signed-in staff can view it.`}
              hint={current?.[side] ? "A photo is on file. Choose a new one to replace it." : undefined}>
              {current?.[side] && !remove[side] && <GuestIdPhoto reservationId={reservation.id} side={side} version={current.updated_at} />}
              <input name={side} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" disabled={remove[side]} />
              {current?.[side] && (
                <label className="table-filter">
                  <input type="checkbox" checked={remove[side]} onChange={(event) => setRemove((value) => ({ ...value, [side]: event.target.checked }))} /> Remove this photo
                </label>
              )}
            </Field>
          ))}
        </div>
        {current && (
          <button type="button" className="button-ghost-danger" onClick={() => void removeAll()} disabled={action.busy}>
            Remove guest ID
          </button>
        )}
      </Modal>
      {dialog}
    </>
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
      <Field label="Guest full name" tip="The name of the person the booking is for, as it appears on their ID.">
        <input name="name" required maxLength={120} defaultValue={reservation.guest_name} />
      </Field>
      <div className="form-row">
        <Field label="Email" tip="The guest's email address. Booking confirmations, receipts and check-in/out notices are sent here. Optional.">
          <input name="email" type="email" maxLength={254} defaultValue={reservation.email ?? ""} />
        </Field>
        <Field label="Phone" tip="The guest's phone number, so staff can reach them about the stay. Optional.">
          <input name="phone" type="tel" maxLength={32} pattern="[\+0-9 \(\)\-]*" defaultValue={reservation.phone ?? ""} />
        </Field>
      </div>
      {scope !== "contact" && <p className="form-section-title">Stay</p>}
      {scope === "full" && (
        <Field label="Room" tip="The physical room the guest will stay in. Each option shows the room number, type, nightly rate and how many guests it sleeps. Rooms under maintenance or out of order aren't listed.">
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
            <Field label="Check in" tip="The arrival date: the first night of the stay.">
              <input name="checkIn" type="date" required defaultValue={reservation.check_in} />
            </Field>
          )}
          <Field label="Check out" tip="The departure date. The guest doesn't stay this night, so a 10th–12th stay is 2 nights.">
            <input name="checkOut" type="date" required defaultValue={reservation.check_out} />
          </Field>
          <Field label="Guests" tip="How many people will stay, up to the room's capacity.">
            <input name="guests" type="number" min="1" max="12" required defaultValue={reservation.guests_count ?? 1} />
          </Field>
        </div>
      )}
      <Field label="Notes" tip="Anything staff should know about this stay, e.g. late arrival or special requests. Not shown to the guest.">
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
  const [identifying, setIdentifying] = useState<Reservation | null>(null);
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
              {open.actions.identity && (
                <button className="button-secondary" onClick={() => setIdentifying(open)} data-tip="Record the guest's government-issued ID">
                  <IdCard size={15} /> Guest ID
                </button>
              )}
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
              ["Room", open.room_number ? `${open.room_type} · ${open.room_number}` : open.room_type, "The room type and, once assigned, the room number."],
              ["Check in", dateLabel(open.check_in), "The arrival date: the first night of the stay."],
              ["Check out", dateLabel(open.check_out), "The departure date. This night isn't charged."],
              ["Nights", String(nightsOf(open)), "Nights charged: from check-in up to, but not including, check-out."],
              ["Guests", open.guests_count ? String(open.guests_count) : null, "How many people are staying."],
              ["Booked", open.source === "public_website" ? "Online, through the website" : open.source ? "By staff" : null, "Where the booking came from: the public website or a staff member in this workspace."],
              ["Created", open.created_at ? dateTimeLabel(open.created_at) : null, "When the booking was made."],
            ]}
          />
          <DetailList
            title="Guest"
            rows={[
              ["Name", open.guest_name, "The person the booking is for."],
              ["Email", open.email, "Where confirmations and receipts are sent."],
              ["Phone", open.phone, "How staff can reach the guest."],
              ["Notes", open.notes, "Staff notes about the stay. Not shown to the guest."],
            ]}
          />
          <GuestIdSection reservation={open} reference={reference} />
          <DetailList
            title="Money"
            rows={[
              ["Stay total", money(open.amount_kobo), "The full price of the stay: nightly rate × nights."],
              ["Paid", money(open.paid_kobo ?? "0"), "Confirmed (settled) payments only. Bank transfers count once an owner or manager confirms them."],
              ["Balance", money(BigInt(open.amount_kobo) - BigInt(open.paid_kobo ?? "0")), "What the guest still owes: stay total minus paid."],
              ["Payment status", optionLabel(reference.paymentStatuses, open.payment_status), "Unpaid: nothing confirmed yet. Part paid: some paid, a balance remains. Pending confirmation: a transfer is waiting to be confirmed. Paid: settled in full."],
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
      {identifying && (
        <GuestIdModal
          reservation={identifying}
          reference={reference}
          notify={notify}
          onClose={() => setIdentifying(null)}
          onSaved={() => {
            setIdentifying(null);
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
            <Field label="Amount received (₦)" tip="How much the guest paid now, in naira. Pre-filled with the outstanding balance; enter less for a part payment. It can't exceed the balance.">
              <input name="amount" type="number" min="1" step="1" defaultValue={Number(outstanding) / 100} required />
            </Field>
            <Field label="Payment method" tip="Cash and POS terminal payments count as paid immediately. Bank transfers wait until an owner or manager confirms the money arrived.">
              <select value={method} onChange={(event) => setMethod(event.target.value as PaymentMethod)}>
                {reference.staffPaymentMethods.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Bank transfer reference or sender name" tip="For bank transfers (required): the transaction reference or the sender's account name, so the owner can match it to the bank statement. Optional for cash and POS, e.g. a POS slip number.">
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
            <th data-tip="The guest's name, the booking reference and its payment status.">GUEST</th>
            <th data-tip="The room type and the assigned room number.">ROOM</th>
            <th data-tip="Check-in date — check-out date. The check-out night isn't charged.">STAY DATES</th>
            <th data-tip="The full price of the stay, before any payments.">BOOKING VALUE</th>
            <th data-tip="Where the stay is: on hold or awaiting online payment, confirmed, checked in, checked out, cancelled, no-show or expired (an unpaid hold that lapsed).">STATUS</th>
            <th data-tip="What you can do now: record a payment, check in, cancel, mark a no-show or check out. Only actions your role allows are shown.">ACTION</th>
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
      <Field label="Guest full name" tip="The name of the person the booking is for, as it appears on their ID.">
        <input name="name" required maxLength={120} />
      </Field>
      <div className="form-row">
        <Field label="Email" tip="The guest's email address. Booking confirmations, receipts and check-in/out notices are sent here. Optional.">
          <input name="email" type="email" maxLength={254} />
        </Field>
        <Field label="Phone" tip="The guest's phone number, so staff can reach them about the stay. Optional.">
          <input name="phone" type="tel" maxLength={32} />
        </Field>
      </div>
      <Field label="Room" tip="The physical room the guest will stay in. Each option shows the room number, type, nightly rate and how many guests it sleeps. Rooms under maintenance or out of order aren't listed.">
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
        <Field label="Check in" tip="The arrival date: the first night of the stay.">
          <input name="checkIn" type="date" required />
        </Field>
        <Field label="Check out" tip="The departure date. The guest doesn't stay this night, so a 10th–12th stay is 2 nights.">
          <input name="checkOut" type="date" required />
        </Field>
      </div>
      <Field label="Guests" tip="How many people will stay, up to the room's capacity.">
        <input name="guests" type="number" min="1" max="12" defaultValue="1" required />
      </Field>
      <Field label="Notes (optional)" tip="Anything staff should know about this stay, e.g. late arrival or special requests. Not shown to the guest.">
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
            <h2>
              Reservations
              <Tip text="All room and apartment bookings, from the website and from staff. Select a booking to see its guest, ID, money and payments, and to edit it, take payment or check the guest in or out." />
            </h2>
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
