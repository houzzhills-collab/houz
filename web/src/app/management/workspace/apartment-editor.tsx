"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ArrowLeft, ImagePlus, Plus, Star, Trash2, X } from "lucide-react";
import { api, errorMessage, type Apartment, type ApartmentInput } from "@/lib/api";
import { text, toKobo } from "./format";
import { MAX_APARTMENT_PHOTOS, PhotoManager, StatusPill } from "./sections/apartments";
import { Field, InlineError, useResource, type SectionProps } from "./ui";

const SUGGESTIONS = {
  amenities: ["Wi-Fi", "Air conditioning", "24-hour power", "Smart TV", "Kitchen", "Washing machine", "Hot water", "Workspace", "Netflix", "Iron"],
  features: ["Balcony", "City view", "Terrace", "Garden", "Private entrance", "King-size bed", "Walk-in closet"],
  facilities: ["Parking", "24-hour security", "Swimming pool", "Gym", "Lift", "Backup generator", "CCTV"],
  houseRules: ["No smoking", "No parties", "No pets", "Quiet hours after 10pm", "ID required at check-in"],
} as const;
type ListKey = keyof typeof SUGGESTIONS;
const LIST_LABELS: Record<ListKey, { label: string; hint: string }> = {
  amenities: { label: "Amenities", hint: "In the apartment" },
  features: { label: "Features", hint: "What makes it special" },
  facilities: { label: "Shared facilities", hint: "On the property" },
  houseRules: { label: "House rules", hint: "Shown before booking" },
};

/** Labels as removable chips: type and press Enter or comma, or pick a suggestion. */
function TagInput({ label, hint, values, suggestions, onChange }: { label: string; hint: string; values: string[]; suggestions: readonly string[]; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = (value: string) => {
    const clean = value.trim().slice(0, 80);
    if (clean && !values.some((existing) => existing.toLowerCase() === clean.toLowerCase())) onChange([...values, clean]);
    setDraft("");
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      add(draft);
    } else if (event.key === "Backspace" && !draft && values.length) {
      onChange(values.slice(0, -1));
    }
  };
  const unused = suggestions.filter((item) => !values.some((value) => value.toLowerCase() === item.toLowerCase()));
  return (
    <div className="form-field">
      <span>
        {label} <small className="field-hint">· {hint}</small>
      </span>
      <div className="tag-input">
        {values.map((value) => (
          <span key={value} className="tag">
            {value}
            <button type="button" aria-label={`Remove ${value}`} onClick={() => onChange(values.filter((item) => item !== value))}>
              <X size={12} />
            </button>
          </span>
        ))}
        <input value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKey} onBlur={() => draft && add(draft)} placeholder={values.length ? "Add another…" : "Type and press Enter"} aria-label={label} />
      </div>
      {unused.length > 0 && (
        <div className="tag-suggestions">
          {unused.map((item) => (
            <button type="button" key={item} onClick={() => add(item)}>
              <Plus size={11} /> {item}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Photos picked before the apartment exists; uploaded right after it is created. */
function QueuedPhotos({ files, onChange, notify }: { files: File[]; onChange: (next: File[]) => void; notify: SectionProps["notify"] }) {
  const input = useRef<HTMLInputElement>(null);
  const previews = useMemo(() => files.map((file) => URL.createObjectURL(file)), [files]);
  useEffect(() => () => previews.forEach((url) => URL.revokeObjectURL(url)), [previews]);
  const tooBig = files.filter((file) => file.size > 8 * 1024 * 1024).length;
  return (
    <section className="detail-section">
      <div className="photo-grid">
        {files.map((file, index) => (
          <div className="photo-tile" key={`${file.name}-${index}`}>
            {previews[index] && <Image src={previews[index]} alt={file.name} width={300} height={225} unoptimized />}
            {index === 0 && <span className="photo-cover">Cover</span>}
            <div className="photo-tools">
              <button type="button" aria-label="Make cover photo" disabled={index === 0} onClick={() => onChange([file, ...files.filter((_, i) => i !== index)])}>
                <Star size={14} />
              </button>
              <button type="button" aria-label="Remove photo" onClick={() => onChange(files.filter((_, i) => i !== index))}>
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
        {files.length < MAX_APARTMENT_PHOTOS && (
          <button type="button" className="photo-upload" onClick={() => input.current?.click()}>
            <ImagePlus size={22} />
            Add photos
            <small>
              {MAX_APARTMENT_PHOTOS - files.length} more allowed · JPEG, PNG or WebP · up to 8 MB each
            </small>
          </button>
        )}
      </div>
      <p className="modal-help">
        {files.length} of {MAX_APARTMENT_PHOTOS} photos
      </p>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        hidden
        onChange={(event) => {
          const picked = [...files, ...(event.target.files ?? [])];
          if (picked.length > MAX_APARTMENT_PHOTOS) notify(`An apartment can have up to ${MAX_APARTMENT_PHOTOS} photos. Only the first ${MAX_APARTMENT_PHOTOS} are kept.`);
          onChange(picked.slice(0, MAX_APARTMENT_PHOTOS));
          event.target.value = "";
        }}
      />
      {tooBig > 0 && <p className="form-error">{tooBig === 1 ? "One photo is" : `${tooBig} photos are`} larger than 8 MB and will be refused. Remove or resize them.</p>}
    </section>
  );
}

const emptyLists = (apartment: Apartment | null): Record<ListKey, string[]> => ({
  amenities: apartment?.amenities ?? [],
  features: apartment?.features ?? [],
  facilities: apartment?.facilities ?? [],
  houseRules: apartment?.houseRules ?? [],
});

function EditorForm({ apartment, notify, onSaved }: { apartment: Apartment | null; notify: SectionProps["notify"]; onSaved: (saved: Apartment) => void }) {
  const a = apartment;
  const [lists, setLists] = useState(() => emptyLists(a));
  const [current, setCurrent] = useState<Apartment | null>(a);
  const [queued, setQueued] = useState<File[]>([]);
  const [publish, setPublish] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
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
      ...lists,
      cancellationPolicy: optional("cancellationPolicy"),
      warrantyPolicy: optional("warrantyPolicy"),
    };
    setError("");
    try {
      if (current) {
        setBusy("Saving…");
        const saved = await api.apartments.update(current.id, input);
        notify(`${saved.name} saved`);
        onSaved(saved);
        return;
      }
      setBusy("Creating…");
      // Create treats absent optional fields as unset rather than null.
      let saved = await api.apartments.create(Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null)) as ApartmentInput);
      setCurrent(saved);
      let failed = 0;
      // One photo per request keeps each upload within proxy and server limits.
      for (const [index, file] of queued.entries()) {
        setBusy(`Uploading photo ${index + 1} of ${queued.length}…`);
        try {
          saved = (await api.apartments.uploadImages(saved.id, [file])).apartment;
        } catch {
          failed += 1;
        }
      }
      setQueued([]);
      if (publish && saved.images.length > 0) {
        setBusy("Publishing…");
        saved = await api.apartments.update(saved.id, { status: "published" });
      }
      notify(
        failed > 0
          ? `${saved.name} created; ${failed} photo${failed === 1 ? "" : "s"} could not be uploaded`
          : `${saved.name} ${saved.status === "published" ? "created and published" : "saved as a draft"}`,
      );
      onSaved(saved);
    } catch (caught) {
      setError(errorMessage(caught, "Unable to save the apartment"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <form className="editor-layout" onSubmit={(event) => void submit(event)}>
      <div className="editor-main">
        <InlineError message={error} onDismiss={() => setError("")} />
        <section className="panel editor-card">
          <h2>Listing</h2>
          <p>How the apartment appears on the website.</p>
          <div className="form-row">
            <Field label="Name" hint="e.g. The Penthouse">
              <input name="name" required maxLength={80} defaultValue={a?.name} />
            </Field>
            <Field label="Category" hint="e.g. Studio, 2-bedroom">
              <input name="category" required maxLength={60} defaultValue={a?.category} />
            </Field>
          </div>
          <div className="form-row">
            <Field label="Unit code" hint="Internal and unique, e.g. P1">
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
            <textarea name="description" maxLength={10000} rows={6} defaultValue={a?.description ?? ""} />
          </Field>
        </section>

        <section className="panel editor-card">
          <h2>Price and capacity</h2>
          <p>Price and capacity changes apply to new bookings only.</p>
          <div className="form-row form-row-3">
            <Field label="Nightly rate (₦)">
              <input name="rate" type="number" min="1" step="1" required defaultValue={a?.pricing.nightlyRateKobo ? Number(a.pricing.nightlyRateKobo) / 100 : undefined} />
            </Field>
            <Field label="Caution fee (₦)" hint="Collected separately">
              <input name="cautionFee" type="number" min="0" step="1" defaultValue={a?.pricing.cautionFeeKobo ? Number(a.pricing.cautionFeeKobo) / 100 : 0} />
            </Field>
            <Field label="Minimum nights">
              <input name="minimumNights" type="number" min="1" max="365" required defaultValue={a?.stayRules.minimumNights ?? 1} />
            </Field>
          </div>
          <div className="form-row form-row-3">
            <Field label="Maximum guests">
              <input name="maxGuests" type="number" min="1" max="12" required defaultValue={a?.capacity.maxGuests ?? 2} />
            </Field>
            <Field label="Bedrooms">
              <input name="bedrooms" type="number" min="0" max="50" required defaultValue={a?.capacity.bedrooms ?? 1} />
            </Field>
            <Field label="Beds">
              <input name="beds" type="number" min="0" max="100" required defaultValue={a?.capacity.beds ?? 1} />
            </Field>
          </div>
          <div className="form-row form-row-3">
            <Field label="Bathrooms">
              <input name="bathrooms" type="number" min="0" max="50" required defaultValue={a?.capacity.bathrooms ?? 1} />
            </Field>
            <Field label="Size (sqm)">
              <input name="sizeSqm" type="number" min="1" step="0.1" defaultValue={a?.capacity.sizeSqm ?? ""} />
            </Field>
            <div />
          </div>
          <div className="form-row form-row-3">
            <Field label="Check-in from">
              <input name="checkInTime" type="time" required defaultValue={a?.stayRules.checkInTime ?? "14:00"} />
            </Field>
            <Field label="Check-out by">
              <input name="checkOutTime" type="time" required defaultValue={a?.stayRules.checkOutTime ?? "12:00"} />
            </Field>
            <div />
          </div>
        </section>

        <section className="panel editor-card">
          <h2>Location</h2>
          <p>Guests see the area and city. The street address and directions are sent only after they book.</p>
          <Field label="Street address">
            <input name="addressLine" maxLength={200} defaultValue={a?.location.addressLine ?? ""} />
          </Field>
          <div className="form-row">
            <Field label="Area">
              <input name="area" maxLength={120} defaultValue={a?.location.area ?? ""} placeholder="e.g. Malali" />
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
          <Field label="Directions">
            <textarea name="directions" maxLength={2000} rows={3} defaultValue={a?.location.directions ?? ""} />
          </Field>
        </section>

        <section className="panel editor-card">
          <h2>What&apos;s included</h2>
          <p>Pick from the suggestions or type your own.</p>
          {(Object.keys(SUGGESTIONS) as ListKey[]).map((key) => (
            <TagInput key={key} label={LIST_LABELS[key].label} hint={LIST_LABELS[key].hint} values={lists[key]} suggestions={SUGGESTIONS[key]} onChange={(next) => setLists((current) => ({ ...current, [key]: next }))} />
          ))}
        </section>

        <section className="panel editor-card">
          <h2>Policies</h2>
          <Field label="Cancellation policy">
            <textarea name="cancellationPolicy" maxLength={5000} rows={3} defaultValue={a?.policies.cancellation ?? ""} />
          </Field>
          <Field label="Damage & caution fee policy">
            <textarea name="warrantyPolicy" maxLength={5000} rows={3} defaultValue={a?.policies.warranty ?? ""} />
          </Field>
        </section>
      </div>

      <aside className="editor-aside">
        <section className="panel editor-card">
          <div className="editor-card-heading">
            <h2>Photos</h2>
            {current && <StatusPill status={current.status} />}
          </div>
          <p>{current ? "Changes to photos are saved straight away. The first photo is the cover." : "Choose photos now; they're uploaded when you create the apartment. The first is the cover."}</p>
          {current ? <PhotoManager apartment={current} editable notify={notify} onChanged={setCurrent} bare /> : <QueuedPhotos files={queued} onChange={setQueued} notify={notify} />}
        </section>
        <section className="panel editor-card editor-actions">
          {!current && (
            <label className="table-filter">
              <input type="checkbox" checked={publish} onChange={(event) => setPublish(event.target.checked)} disabled={queued.length === 0} />
              Publish as soon as it&apos;s created{queued.length === 0 ? " (add a photo first)" : ""}
            </label>
          )}
          <button className="button-primary" disabled={busy !== null}>
            {busy ?? (current ? "Save changes" : publish ? "Create and publish" : "Create as draft")}
          </button>
          <Link className="button-secondary" href="/management?section=Apartments">
            <ArrowLeft size={15} /> Back to apartments
          </Link>
        </section>
      </aside>
    </form>
  );
}

/** Add (no `apartmentId`) or edit an apartment on its own page; the form is too long for a dialog. */
export function ApartmentEditor({ apartmentId, notify }: SectionProps & { apartmentId?: string }) {
  const router = useRouter();
  const loaded = useResource(() => (apartmentId ? api.apartments.get(apartmentId) : Promise.resolve(null)), apartmentId ?? "new");
  const done = (saved: Apartment) => router.push(`/management?section=Apartments&open=${saved.id}`);
  if (apartmentId && !loaded.data) return loaded.error ? <InlineError message={loaded.error} /> : <div className="empty-state">Loading apartment…</div>;
  return <EditorForm key={loaded.data?.id ?? "new"} apartment={loaded.data} notify={notify} onSaved={done} />;
}
