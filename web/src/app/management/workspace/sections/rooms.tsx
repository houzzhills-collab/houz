"use client";

import { useState } from "react";
import { Archive, Pencil, Plus, RotateCcw } from "lucide-react";
import { api, errorMessage, type Reference, type Room, type RoomStatus } from "@/lib/api";
import { dateLabel, dateTimeLabel, humanize, money, optionLabel, text, toKobo } from "../format";
import { DetailList, Drawer, Empty, Field, InlineError, Modal, Tip, useAction, useConfirm, useResource, type Notify, type SectionProps } from "../ui";

function tone(status: string): string {
  if (status === "vacant_clean" || status === "inspected") return "status-green";
  if (status === "maintenance" || status === "out_of_order") return "status-red";
  return "status-gold";
}

function RoomHistory({ room, reference }: { room: Room; reference: Reference }) {
  const history = useResource(() => api.rooms.history(room.id), room.id);
  return (
    <section className="detail-section">
      <h3>
        History
        <Tip text="Every status change for this room, newest first, with who made it and when." />
      </h3>
      <InlineError message={history.error} />
      <div className="activity-list">
        {(history.data ?? []).map((entry, index) => (
          <div className="activity-row" key={`${entry.at}-${index}`}>
            <span className="activity-dot gold" />
            <div>
              <strong>
                {entry.from && entry.to ? `${optionLabel(reference.roomStatuses, entry.from)} → ${optionLabel(reference.roomStatuses, entry.to)}` : humanize(entry.action)}
              </strong>
              <p>
                {entry.actor ?? "System"}
                {entry.note ? ` · ${entry.note}` : ""}
              </p>
              <small>{dateTimeLabel(entry.at)}</small>
            </div>
          </div>
        ))}
        {history.data?.length === 0 && <Empty text="No changes recorded yet." />}
      </div>
    </section>
  );
}

/** Add a room, or edit one (rate and capacity changes apply to new bookings). */
function RoomForm({ room, notify, onClose, onSaved }: { room: Room | null; notify: Notify; onClose: () => void; onSaved: () => void }) {
  const action = useAction();
  return (
    <Modal
      title={room ? `Edit room ${room.room_number}` : "Add a room"}
      description={room ? "Rate and capacity changes apply to new bookings only." : undefined}
      submitLabel={room ? "Save changes" : "Add room"}
      busy={action.busy}
      error={action.error}
      onClose={onClose}
      onSubmit={(values) =>
        action.run(async () => {
          const input = {
            roomNumber: text(values.get("roomNumber")),
            roomType: text(values.get("roomType")),
            nightlyRateKobo: toKobo(values.get("rate")),
            capacity: Number(values.get("capacity")),
          };
          if (room) await api.rooms.update(room.id, input);
          else await api.rooms.create(input);
          notify(room ? `Room ${input.roomNumber} updated` : "Room added");
          onSaved();
        })
      }
    >
      <div className="form-row">
        <Field label="Room number" tip="The number or name on the door, e.g. 204. Must be unique.">
          <input name="roomNumber" required maxLength={20} placeholder="e.g. 204" defaultValue={room?.room_number} />
        </Field>
        <Field label="Room category" tip="The room type guests book on the website, e.g. “Executive Suite”. Rooms with the same category are sold together, and a website booking is placed in any free room of that category.">
          <input name="roomType" required maxLength={80} placeholder="e.g. Executive Suite" defaultValue={room?.room_type} />
        </Field>
      </div>
      <div className="form-row">
        <Field label="Nightly rate (₦)" tip="The price per night in naira. New bookings use this rate; existing bookings keep the price agreed when they were made.">
          <input name="rate" type="number" min="0" step="1" required defaultValue={room ? Number(room.nightly_rate_kobo) / 100 : undefined} />
        </Field>
        <Field label="Guest capacity" tip="The most guests the room sleeps. Bookings for more guests than this are refused.">
          <input name="capacity" type="number" min="1" max="12" defaultValue={room?.capacity ?? 2} required />
        </Field>
      </div>
    </Modal>
  );
}

export function RoomsSection({ notify, refreshKey, can, reference, focus }: SectionProps) {
  const rooms = useResource(() => api.rooms.list(), String(refreshKey));
  const [form, setForm] = useState<{ room: Room | null } | null>(focus?.intent === "create" ? { room: null } : null);
  const [openId, setOpenId] = useState<string | null>(focus?.id ?? null);
  const [showRetired, setShowRetired] = useState(Boolean(focus?.id));
  const { confirm, dialog } = useConfirm();
  const all = rooms.data ?? [];
  const list = all.filter((room) => showRetired || room.active !== false);
  const retired = all.filter((room) => room.active === false).length;
  const open = all.find((room) => room.id === openId) ?? null;
  // The API withholds rates and guest details from roles that may not see them.
  const showRates = all.some((room) => room.nightly_rate_kobo !== null);
  const editable = (room: Room) => can("rooms:create") && !room.apartment_id;

  const change = async (room: Room, status: RoomStatus) => {
    try {
      await api.rooms.updateStatus(room.id, status);
      notify(`Room ${room.room_number} updated`);
      await rooms.reload();
    } catch (error) {
      notify(errorMessage(error, "Room update failed"));
    }
  };

  const setActive = async (room: Room, active: boolean) => {
    const accepted = await confirm(
      active
        ? { title: `Restore room ${room.room_number}?`, message: "It becomes bookable again.", confirmLabel: "Restore room" }
        : { title: `Retire room ${room.room_number}?`, message: "It can no longer be booked. Its history is kept and you can restore it later.", confirmLabel: "Retire room", danger: true },
    );
    if (accepted === null) return;
    try {
      await api.rooms.update(room.id, { active });
      notify(`Room ${room.room_number} ${active ? "restored" : "retired"}`);
      await rooms.reload();
    } catch (error) {
      notify(errorMessage(error, "Room update failed"));
    }
  };

  return (
    <section className="panel bookings-panel full-panel">
      <div className="panel-heading bookings-heading">
        <div>
          <h2>
            Room inventory
            <Tip text="Every room, whether it's ready for a guest, its nightly rate and who's in it tonight. Housekeeping updates readiness here; select a room for details and history." />
          </h2>
          <p>Readiness, nightly rate and current stay. Select a room for details, history and changes.</p>
        </div>
        <div className="heading-actions">
          {retired > 0 && (
            <label className="table-filter" data-tip="Retired rooms can't be booked. Show them to restore one." data-tip-pos="bottom">
              <input type="checkbox" checked={showRetired} onChange={(event) => setShowRetired(event.target.checked)} /> Show retired ({retired})
            </label>
          )}
          <span className="booking-count">{list.length} rooms</span>
          {can("rooms:create") && (
            <button className="button-primary" onClick={() => setForm({ room: null })} data-tip="Add a bookable room with its rate and capacity" data-tip-pos="bottom">
              <Plus size={16} /> Add room
            </button>
          )}
        </div>
      </div>
      <InlineError message={rooms.error} />
      {list.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th data-tip="The room number.">ROOM</th>
                <th data-tip="The room category guests book, e.g. Executive Suite.">TYPE</th>
                {showRates && <th data-tip="The current price per night for new bookings.">RATE / NIGHT</th>}
                <th data-tip={showRates ? "Who's staying tonight and their booking reference, if anyone." : "Whether the room needs cleaning before the next guest."}>{showRates ? "GUEST / STAY" : "TURNOVER"}</th>
                <th data-tip="Vacant · clean: ready to sell. Vacant · dirty: needs cleaning after check-out. Inspected: cleaned and checked by a supervisor. Occupied: a guest is in. Maintenance / Out of order: can't be booked.">STATUS</th>
                <th data-tip="Change the room's status, e.g. mark it clean after housekeeping. Only the changes allowed from its current status are offered.">UPDATE</th>
              </tr>
            </thead>
            <tbody>
              {list.map((room) => (
                <tr key={room.id} className={`row-link ${room.active === false ? "row-muted" : ""}`} onClick={() => setOpenId(room.id)}>
                  <td className="booking-amount">{room.room_number}</td>
                  <td>
                    {room.room_type} · sleeps {room.capacity}
                  </td>
                  {showRates && <td>{money(room.nightly_rate_kobo)}</td>}
                  <td>{room.stay ? (room.stay.guest ? `${room.stay.guest} · ${room.stay.reference ?? ""}` : `Due ${dateLabel(room.stay.checkOut)}`) : "—"}</td>
                  <td>
                    <span className={`status ${room.active === false ? "status-red" : tone(room.status)}`}>
                      <i />
                      {room.active === false ? "Retired" : optionLabel(reference.roomStatuses, room.status)}
                    </span>
                  </td>
                  <td onClick={(event) => event.stopPropagation()}>
                    {room.next_statuses.length > 0 && room.active !== false ? (
                      <select className="inline-select" value="" onChange={(event) => event.target.value && void change(room, event.target.value as RoomStatus)} aria-label={`Update room ${room.room_number}`}>
                        <option value="">Set status</option>
                        {room.next_statuses.map((status) => (
                          <option key={status} value={status}>
                            {optionLabel(reference.roomStatuses, status)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="quiet-action">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !rooms.loading && <Empty text="No rooms yet. Add room numbers, categories, nightly rates and capacities to start taking reservations." />
      )}

      {open && (
        <Drawer
          title={`Room ${open.room_number}`}
          subtitle={open.room_type}
          badge={
            <span className={`status ${open.active === false ? "status-red" : tone(open.status)}`}>
              <i />
              {open.active === false ? "Retired" : optionLabel(reference.roomStatuses, open.status)}
            </span>
          }
          onClose={() => setOpenId(null)}
          actions={
            editable(open) && (
              <>
                {open.active === false ? (
                  <button className="button-secondary" onClick={() => void setActive(open, true)}>
                    <RotateCcw size={15} /> Restore
                  </button>
                ) : (
                  <button className="button-ghost-danger" onClick={() => void setActive(open, false)} data-tip="Stops new bookings. History is kept and you can restore it.">
                    <Archive size={15} /> Retire room
                  </button>
                )}
                <span className="spacer" />
                <button className="button-primary" onClick={() => setForm({ room: open })}>
                  <Pencil size={15} /> Edit room
                </button>
              </>
            )
          }
        >
          <DetailList
            title="Room"
            rows={[
              ["Room number", open.room_number, "The number on the door."],
              ["Category", open.room_type, "The room type guests book on the website."],
              ["Sleeps", String(open.capacity), "The most guests the room can take."],
              ["Nightly rate", open.nightly_rate_kobo !== null ? money(open.nightly_rate_kobo) : null, "The current price per night for new bookings."],
              ["Apartment unit", open.apartment_id ? "Yes. Edit its details, price and photos from Apartments." : null, "This room is a shortlet apartment listed on the website."],
            ]}
          />
          <DetailList
            title="Current stay"
            rows={[
              ["Guest", open.stay?.guest ?? (open.stay ? "In house" : "No one tonight"), "Who is booked into this room tonight."],
              ["Reference", open.stay?.reference, "The booking reference, to find the stay in Reservations."],
              ["Check-out", open.stay ? dateLabel(open.stay.checkOut) : null, "When the current guest leaves."],
            ]}
          />
          {open.next_statuses.length > 0 && open.active !== false && (
            <section className="detail-section">
              <h3>
                Change status
                <Tip text="Move the room to its next state, e.g. Vacant · dirty → Vacant · clean once housekeeping is done. Check-in and check-out update it automatically." />
              </h3>
              <div className="chip-list">
                {open.next_statuses.map((status) => (
                  <button key={status} className="button-secondary" onClick={() => void change(open, status)}>
                    {optionLabel(reference.roomStatuses, status)}
                  </button>
                ))}
              </div>
            </section>
          )}
          <RoomHistory key={`${open.id}:${refreshKey}`} room={open} reference={reference} />
        </Drawer>
      )}
      {form && (
        <RoomForm
          room={form.room}
          notify={notify}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            void rooms.reload();
          }}
        />
      )}
      {dialog}
    </section>
  );
}
