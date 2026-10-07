"use client";

import { useRef, useState, type ChangeEvent } from "react";
import Image from "next/image";
import { Archive, ArrowLeft, ArrowRight, ExternalLink, Eye, EyeOff, ImagePlus, Pencil, Plus, RotateCcw, Star, Trash2 } from "lucide-react";
import { api, apiAssetUrl, errorMessage, type Apartment, type ApartmentInput, type ApartmentStatus, type Reference } from "@/lib/api";
import { dateLabel, money, optionLabel, text, toKobo } from "../format";
import { DetailList, Drawer, Empty, Field, InlineError, Modal, useAction, useConfirm, useResource, type Notify, type SectionProps } from "../ui";

const STATUS: Record<ApartmentStatus, { label: string; tone: string }> = {
  published: { label: "Published", tone: "status-green" },
  draft: { label: "Draft", tone: "status-gold" },
  archived: { label: "Archived", tone: "status-red" },
};

function StatusPill({ status }: { status: ApartmentStatus }) {
  return (
    <span className={`status ${STATUS[status].tone}`}>
      <i />
      {STATUS[status].label}
    </span>
  );
}

const cover = (apartment: Apartment) => apartment.images.find((image) => image.isCover) ?? apartment.images[0] ?? null;
/** One entry per line or comma, blanks dropped. */
const labels = (value: FormDataEntryValue | null) =>
  String(value ?? "")
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);

/** Create (as a draft) or edit an apartment listing. */
function ApartmentForm({ apartment, notify, onClose, onSaved }: { apartment: Apartment | null; notify: Notify; onClose: () => void; onSaved: (saved: Apartment) => void }) {
  const action = useAction();
  const a = apartment;
  return (
    <Modal
      title={a ? `Edit ${a.name}` : "Add an apartment"}
      description={a ? "Price and capacity changes apply to new bookings only." : "It's saved as a draft. Add photos, then publish it to open it for booking."}
      submitLabel={a ? "Save changes" : "Create draft"}
      busy={action.busy}
      error={action.error}
      wide
      onClose={onClose}
      onSubmit={(values) =>
        action.run(async () => {
          const optional = (name: string) => text(values.get(name)) || null;
          const size = text(values.get("sizeSqm"));
          const slug = text(values.get("slug"));
          const input: ApartmentInput = {
            name: text(values.get("name")),
            unitCode: text(values.get("unitCode")),
            category: text(values.get("category")),
            ...(slug ? { slug } : {}),
            summary: optional("summary"),
            description: optional("description"),
            location: {
              addressLine: optional("addressLine"),
              area: optional("area"),
              city: text(values.get("city")),
              state: text(values.get("state")),
              country: text(values.get("country")) || "Nigeria",
              directions: optional("directions"),
            },
            nightlyRateKobo: toKobo(values.get("rate")),
            cautionFeeKobo: toKobo(values.get("cautionFee")),
            maxGuests: Number(values.get("maxGuests")),
            bedrooms: Number(values.get("bedrooms")),
            bathrooms: Number(values.get("bathrooms")),
            beds: Number(values.get("beds")),
            sizeSqm: size ? Number(size) : null,
            minimumNights: Number(values.get("minimumNights")),
            checkInTime: text(values.get("checkInTime")),
            checkOutTime: text(values.get("checkOutTime")),
            amenities: labels(values.get("amenities")),
            features: labels(values.get("features")),
            facilities: labels(values.get("facilities")),
            houseRules: labels(values.get("houseRules")),
            cancellationPolicy: optional("cancellationPolicy"),
            warrantyPolicy: optional("warrantyPolicy"),
          };
          if (!a) {
            // Create treats absent optional fields as unset rather than null.
            const created = await api.apartments.create(Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null)) as ApartmentInput);
            notify(`${created.name} created as a draft`);
            onSaved(created);
          } else {
            const saved = await api.apartments.update(a.id, input);
            notify(`${saved.name} updated`);
            onSaved(saved);
          }
        })
      }
    >
      <p className="form-section-title">Listing</p>
      <div className="form-row">
        <Field label="Name" hint="Shown to guests, e.g. The Penthouse">
          <input name="name" required maxLength={80} defaultValue={a?.name} />
        </Field>
        <Field label="Category" hint="e.g. Studio, 2-bedroom">
          <input name="category" required maxLength={60} defaultValue={a?.category} />
        </Field>
      </div>
      <div className="form-row">
        <Field label="Unit code" hint="Internal, unique, e.g. P1">
          <input name="unitCode" required maxLength={20} defaultValue={a?.unitCode} />
        </Field>
        <Field label="Web address" hint="Leave empty to use the name">
          <input name="slug" maxLength={80} pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="the-penthouse" defaultValue={a?.slug} />
        </Field>
      </div>
      <Field label="Summary" hint="One line for the apartment card">
        <input name="summary" maxLength={300} defaultValue={a?.summary ?? ""} />
      </Field>
      <Field label="Description">
        <textarea name="description" maxLength={10000} rows={4} defaultValue={a?.description ?? ""} />
      </Field>

      <p className="form-section-title">Price and capacity</p>
      <div className="form-row">
        <Field label="Nightly rate (₦)">
          <input name="rate" type="number" min="1" step="1" required defaultValue={a?.pricing.nightlyRateKobo ? Number(a.pricing.nightlyRateKobo) / 100 : undefined} />
        </Field>
        <Field label="Caution fee (₦)" hint="Shown to guests; collected separately">
          <input name="cautionFee" type="number" min="0" step="1" defaultValue={a?.pricing.cautionFeeKobo ? Number(a.pricing.cautionFeeKobo) / 100 : 0} />
        </Field>
      </div>
      <div className="form-row">
        <Field label="Maximum guests">
          <input name="maxGuests" type="number" min="1" max="12" required defaultValue={a?.capacity.maxGuests ?? 2} />
        </Field>
        <Field label="Size (sqm)">
          <input name="sizeSqm" type="number" min="1" step="0.1" defaultValue={a?.capacity.sizeSqm ?? ""} />
        </Field>
      </div>
      <div className="form-row">
        <Field label="Bedrooms">
          <input name="bedrooms" type="number" min="0" max="50" required defaultValue={a?.capacity.bedrooms ?? 1} />
        </Field>
        <Field label="Beds">
          <input name="beds" type="number" min="0" max="100" required defaultValue={a?.capacity.beds ?? 1} />
        </Field>
      </div>
      <div className="form-row">
        <Field label="Bathrooms">
          <input name="bathrooms" type="number" min="0" max="50" required defaultValue={a?.capacity.bathrooms ?? 1} />
        </Field>
        <Field label="Minimum nights">
          <input name="minimumNights" type="number" min="1" max="365" required defaultValue={a?.stayRules.minimumNights ?? 1} />
        </Field>
      </div>
      <div className="form-row">
        <Field label="Check-in from">
          <input name="checkInTime" type="time" required defaultValue={a?.stayRules.checkInTime ?? "14:00"} />
        </Field>
        <Field label="Check-out by">
          <input name="checkOutTime" type="time" required defaultValue={a?.stayRules.checkOutTime ?? "12:00"} />
        </Field>
      </div>

      <p className="form-section-title">Location</p>
      <Field label="Street address" hint="Shared with guests only after they book">
        <input name="addressLine" maxLength={200} defaultValue={a?.location.addressLine ?? ""} />
      </Field>
      <div className="form-row">
        <Field label="Area">
          <input name="area" maxLength={120} defaultValue={a?.location.area ?? ""} />
        </Field>
        <Field label="City">
          <input name="city" required maxLength={80} defaultValue={a?.location.city ?? "Kaduna"} />
        </Field>
      </div>
      <div className="form-row">
        <Field label="State">
          <input name="state" required maxLength={80} defaultValue={a?.location.state ?? "Kaduna"} />
        </Field>
        <Field label="Country">
          <input name="country" maxLength={80} defaultValue={a?.location.country ?? "Nigeria"} />
        </Field>
      </div>
      <Field label="Directions" hint="Sent in the booking confirmation email">
        <textarea name="directions" maxLength={2000} rows={2} defaultValue={a?.location.directions ?? ""} />
      </Field>

      <p className="form-section-title">What&apos;s included</p>
      <div className="form-row">
        <Field label="Amenities" hint="One per line or comma-separated">
          <textarea name="amenities" rows={3} defaultValue={a?.amenities.join("\n")} placeholder={"Wi-Fi\nAir conditioning\nSmart TV"} />
        </Field>
        <Field label="Features">
          <textarea name="features" rows={3} defaultValue={a?.features.join("\n")} placeholder={"Balcony\nCity view"} />
        </Field>
      </div>
      <div className="form-row">
        <Field label="Shared facilities">
          <textarea name="facilities" rows={3} defaultValue={a?.facilities.join("\n")} placeholder={"Swimming pool\nGym\nParking"} />
        </Field>
        <Field label="House rules">
          <textarea name="houseRules" rows={3} defaultValue={a?.houseRules.join("\n")} placeholder={"No smoking\nNo parties"} />
        </Field>
      </div>

      <p className="form-section-title">Policies</p>
      <Field label="Cancellation policy">
        <textarea name="cancellationPolicy" maxLength={5000} rows={2} defaultValue={a?.policies.cancellation ?? ""} />
      </Field>
      <Field label="Damage & caution fee policy">
        <textarea name="warrantyPolicy" maxLength={5000} rows={2} defaultValue={a?.policies.warranty ?? ""} />
      </Field>
    </Modal>
  );
}

/** Upload, order, set the cover and delete photos. */
function PhotoManager({ apartment, editable, notify, onChanged }: { apartment: Apartment; editable: boolean; notify: Notify; onChanged: (next: Apartment) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();
  const images = apartment.images;

  const run = async (work: () => Promise<Apartment>, fallback: string) => {
    try {
      onChanged(await work());
    } catch (error) {
      notify(errorMessage(error, fallback));
    }
  };

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    if (files.length === 0) return;
    let latest = apartment;
    let uploaded = 0;
    try {
      // One photo per request keeps each upload well under proxy and server limits.
      for (const [index, file] of files.entries()) {
        setProgress(`Uploading ${index + 1} of ${files.length}…`);
        const result = await api.apartments.uploadImages(apartment.id, [file]);
        latest = result.apartment;
        uploaded += result.uploaded;
      }
      notify(`${uploaded} photo${uploaded === 1 ? "" : "s"} added`);
    } catch (error) {
      notify(errorMessage(error, "Upload failed"));
    } finally {
      setProgress(null);
      onChanged(latest);
    }
  };

  const move = (index: number, by: number) => {
    const order = images.map((image) => image.id);
    const [moved] = order.splice(index, 1);
    order.splice(index + by, 0, moved!);
    void run(() => api.apartments.reorderImages(apartment.id, order), "Unable to reorder photos");
  };

  const remove = async (imageId: string) => {
    const accepted = await confirm({ title: "Delete this photo?", message: "It's removed from the listing and storage. This can't be undone.", confirmLabel: "Delete photo", danger: true });
    if (accepted === null) return;
    await run(() => api.apartments.deleteImage(apartment.id, imageId), "Unable to delete the photo");
  };

  return (
    <section className="detail-section">
      <h3>Photos ({images.length})</h3>
      <div className="photo-grid">
        {images.map((image, index) => (
          <div className="photo-tile" key={image.id}>
            <Image src={apiAssetUrl(image.url)} alt={image.caption ?? `${apartment.name} photo ${index + 1}`} width={300} height={225} unoptimized />
            {image.isCover && <span className="photo-cover">Cover</span>}
            {editable && (
              <div className="photo-tools">
                <button type="button" aria-label="Move earlier" disabled={index === 0} onClick={() => move(index, -1)}>
                  <ArrowLeft size={14} />
                </button>
                <button type="button" aria-label="Make cover photo" disabled={image.isCover} onClick={() => void run(() => api.apartments.updateImage(apartment.id, image.id, { isCover: true }), "Unable to set the cover")}>
                  <Star size={14} />
                </button>
                <button type="button" aria-label="Delete photo" onClick={() => void remove(image.id)}>
                  <Trash2 size={14} />
                </button>
                <button type="button" aria-label="Move later" disabled={index === images.length - 1} onClick={() => move(index, 1)}>
                  <ArrowRight size={14} />
                </button>
              </div>
            )}
          </div>
        ))}
        {editable && (
          <button type="button" className="photo-upload" disabled={progress !== null} onClick={() => input.current?.click()}>
            <ImagePlus size={22} />
            {progress ?? "Add photos"}
            <small>JPEG, PNG or WebP · up to 8 MB each</small>
          </button>
        )}
      </div>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(event) => void upload(event)} />
      {images.length === 0 && !editable && <Empty text="No photos yet." />}
      {dialog}
    </section>
  );
}

function ApartmentBookings({ apartment, reference, refreshKey }: { apartment: Apartment; reference: Reference; refreshKey: number }) {
  const bookings = useResource(() => api.apartments.bookings({ apartmentId: apartment.id }), `${apartment.id}:${refreshKey}`);
  const list = bookings.data?.bookings ?? [];
  return (
    <section className="detail-section">
      <h3>Bookings</h3>
      <InlineError message={bookings.error} />
      {list.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>GUEST</th>
                <th>STAY</th>
                <th>TOTAL</th>
                <th>STATUS</th>
              </tr>
            </thead>
            <tbody>
              {list.slice(0, 20).map((booking) => (
                <tr key={booking.id}>
                  <td>
                    <div className="guest-cell">
                      <div>
                        <strong>{booking.booker.name}</strong>
                        <small>{booking.reference.length > 18 ? `${booking.reference.slice(0, 18)}…` : booking.reference}</small>
                      </div>
                    </div>
                  </td>
                  <td>
                    {dateLabel(booking.checkIn)} — {dateLabel(booking.checkOut)}
                  </td>
                  <td className="booking-amount">{money(booking.payment.amountKobo)}</td>
                  <td>{optionLabel(reference.reservationStatuses, booking.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !bookings.loading && <Empty text="No bookings yet." />
      )}
    </section>
  );
}

export function ApartmentsSection({ notify, refreshKey, can, reference }: SectionProps) {
  const [showArchived, setShowArchived] = useState(false);
  const apartments = useResource(() => api.apartments.list(), String(refreshKey));
  const archived = useResource(() => (showArchived ? api.apartments.list({ status: "archived" }) : Promise.resolve([])), `${refreshKey}:${showArchived}`);
  const [form, setForm] = useState<{ apartment: Apartment | null } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [patched, setPatched] = useState<Record<string, Apartment>>({});
  const { confirm, dialog } = useConfirm();
  const editable = can("rooms:create");
  const list = [...(apartments.data ?? []), ...(archived.data ?? [])].map((apartment) => patched[apartment.id] ?? apartment);
  const open = list.find((apartment) => apartment.id === openId) ?? (openId ? patched[openId] : undefined) ?? null;

  // Keep the drawer current after a change without waiting for the list to reload.
  const saved = (next: Apartment) => {
    setPatched((current) => ({ ...current, [next.id]: next }));
    void apartments.reload();
    void archived.reload();
  };

  const setStatus = async (apartment: Apartment, status: ApartmentStatus) => {
    const options = {
      published: { title: `Publish ${apartment.name}?`, message: "It appears on the website and can be booked straight away.", confirmLabel: "Publish" },
      draft: { title: apartment.status === "archived" ? `Restore ${apartment.name}?` : `Unpublish ${apartment.name}?`, message: apartment.status === "archived" ? "It returns as a draft. Publish it when it's ready." : "It's hidden from the website and can't be booked. Existing bookings are kept.", confirmLabel: apartment.status === "archived" ? "Restore as draft" : "Unpublish" },
      archived: { title: `Archive ${apartment.name}?`, message: "It's retired from the website and the workspace list. Its bookings and history are kept.", confirmLabel: "Archive", danger: true },
    }[status];
    if ((await confirm(options)) === null) return;
    try {
      saved(await api.apartments.update(apartment.id, { status }));
      notify(`${apartment.name} ${status === "published" ? "published" : status === "archived" ? "archived" : apartment.status === "archived" ? "restored as a draft" : "unpublished"}`);
    } catch (error) {
      notify(errorMessage(error, "Unable to update the apartment"));
    }
  };

  return (
    <section className="panel bookings-panel full-panel">
      <div className="panel-heading bookings-heading">
        <div>
          <h2>Apartments</h2>
          <p>Listings on the website: details, photos, prices and bookings. Select one to manage it.</p>
        </div>
        <div className="heading-actions">
          <label className="table-filter">
            <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> Show archived
          </label>
          <span className="booking-count">{list.filter((apartment) => apartment.status === "published").length} published</span>
          {editable && (
            <button className="button-primary" onClick={() => setForm({ apartment: null })}>
              <Plus size={16} /> Add apartment
            </button>
          )}
        </div>
      </div>
      <InlineError message={apartments.error || archived.error} />
      {list.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>APARTMENT</th>
                <th>UNIT</th>
                <th>RATE / NIGHT</th>
                <th>SLEEPS</th>
                <th>NOW</th>
                <th>STATUS</th>
              </tr>
            </thead>
            <tbody>
              {list.map((apartment) => {
                const photo = cover(apartment);
                return (
                  <tr key={apartment.id} className={`row-link ${apartment.status === "archived" ? "row-muted" : ""}`} onClick={() => setOpenId(apartment.id)}>
                    <td>
                      <div className="guest-cell">
                        {photo ? <Image className="apartment-thumb" src={apiAssetUrl(photo.url)} alt="" width={64} height={48} unoptimized /> : <span className="apartment-thumb" />}
                        <div>
                          <strong>{apartment.name}</strong>
                          <small>
                            {apartment.category} · {apartment.images.length} photo{apartment.images.length === 1 ? "" : "s"}
                          </small>
                        </div>
                      </div>
                    </td>
                    <td>{apartment.unitCode}</td>
                    <td className="booking-amount">{apartment.pricing.nightlyRateKobo ? money(apartment.pricing.nightlyRateKobo) : "—"}</td>
                    <td>{apartment.capacity.maxGuests}</td>
                    <td>
                      {apartment.currentStay
                        ? `${apartment.currentStay.guestName ?? "Guest"} until ${dateLabel(apartment.currentStay.checkOut)}`
                        : apartment.nextArrival
                          ? `Next arrival ${dateLabel(apartment.nextArrival.checkIn)}`
                          : "Free"}
                    </td>
                    <td>
                      <StatusPill status={apartment.status} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        !apartments.loading && <Empty text="No apartments yet. Add one, upload its photos and publish it to show it on the website." />
      )}

      {open && (
        <Drawer
          title={open.name}
          subtitle={`${open.category} · Unit ${open.unitCode}`}
          badge={<StatusPill status={open.status} />}
          onClose={() => setOpenId(null)}
          actions={
            <>
              {editable && open.status !== "archived" && (
                <button className="button-ghost-danger" onClick={() => void setStatus(open, "archived")}>
                  <Archive size={15} /> Archive
                </button>
              )}
              {open.status === "published" && (
                <a className="button-secondary" href={`/apartments/${open.slug}`} target="_blank" rel="noreferrer">
                  <ExternalLink size={15} /> View on site
                </a>
              )}
              <span className="spacer" />
              {editable && open.status === "published" && (
                <button className="button-secondary" onClick={() => void setStatus(open, "draft")}>
                  <EyeOff size={15} /> Unpublish
                </button>
              )}
              {editable && open.status === "archived" && (
                <button className="button-secondary" onClick={() => void setStatus(open, "draft")}>
                  <RotateCcw size={15} /> Restore
                </button>
              )}
              {editable && open.status !== "archived" && (
                <button className="button-secondary" onClick={() => setForm({ apartment: open })}>
                  <Pencil size={15} /> Edit
                </button>
              )}
              {editable && open.status === "draft" && (
                <button className="button-primary" onClick={() => void setStatus(open, "published")} disabled={open.images.length === 0} title={open.images.length === 0 ? "Add at least one photo first" : undefined}>
                  <Eye size={15} /> Publish
                </button>
              )}
            </>
          }
        >
          <PhotoManager apartment={open} editable={editable && open.status !== "archived"} notify={notify} onChanged={saved} />
          <DetailList
            title="Listing"
            rows={[
              ["Summary", open.summary],
              ["Description", open.description],
              ["Web address", `/apartments/${open.slug}`],
            ]}
          />
          <DetailList
            title="Price and capacity"
            rows={[
              ["Nightly rate", open.pricing.nightlyRateKobo ? money(open.pricing.nightlyRateKobo) : null],
              ["Caution fee", open.pricing.cautionFeeKobo ? money(open.pricing.cautionFeeKobo) : null],
              ["Sleeps", String(open.capacity.maxGuests)],
              ["Bedrooms · beds · bathrooms", `${open.capacity.bedrooms} · ${open.capacity.beds} · ${open.capacity.bathrooms}`],
              ["Size", open.capacity.sizeSqm ? `${open.capacity.sizeSqm} sqm` : null],
              ["Minimum stay", `${open.stayRules.minimumNights} night${open.stayRules.minimumNights === 1 ? "" : "s"}`],
              ["Check-in / out", `From ${open.stayRules.checkInTime} · by ${open.stayRules.checkOutTime}`],
            ]}
          />
          <DetailList
            title="Location"
            rows={[
              ["Address", [open.location.addressLine, open.location.area, open.location.city, open.location.state, open.location.country].filter(Boolean).join(", ")],
              ["Directions", open.location.directions],
            ]}
          />
          {[
            ["Amenities", open.amenities],
            ["Features", open.features],
            ["Facilities", open.facilities],
            ["House rules", open.houseRules],
          ].map(([title, items]) =>
            (items as string[]).length ? (
              <section className="detail-section" key={title as string}>
                <h3>{title as string}</h3>
                <div className="chip-list">
                  {(items as string[]).map((item) => (
                    <span key={item}>{item}</span>
                  ))}
                </div>
              </section>
            ) : null,
          )}
          <DetailList
            title="Policies"
            rows={[
              ["Cancellation", open.policies.cancellation],
              ["Damage & caution fee", open.policies.warranty],
            ]}
          />
          {can("reservations:read") && <ApartmentBookings apartment={open} reference={reference} refreshKey={refreshKey} />}
        </Drawer>
      )}
      {form && (
        <ApartmentForm
          apartment={form.apartment}
          notify={notify}
          onClose={() => setForm(null)}
          onSaved={(next) => {
            setForm(null);
            saved(next);
            setOpenId(next.id);
          }}
        />
      )}
      {dialog}
    </section>
  );
}
