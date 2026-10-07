/**
 * Data contracts shared by the workspace UI and every ApiClient implementation.
 * Field names mirror the backend payloads (snake_case rows, integer kobo as
 * strings).
 */

export type Role =
  | "owner"
  | "manager"
  | "front_desk"
  | "housekeeping"
  | "restaurant_cashier"
  | "restaurant_manager"
  | "storekeeper"
  | "finance"
  | "auditor";

export type Permission =
  | "dashboard:read"
  | "reservations:read"
  | "reservations:write"
  | "rooms:read"
  | "rooms:write"
  | "rooms:create"
  | "staff:read"
  | "staff:write"
  | "attendance:read"
  | "attendance:write"
  | "pos:read"
  | "pos:write"
  | "inventory:read"
  | "inventory:write"
  | "menu:write"
  | "payments:read"
  | "payments:confirm"
  | "reports:read"
  | "settings:manage";

/** `permissions` comes from the API, which owns the role table and enforces every one. */
export type User = { id: string; fullName: string; email: string; role: Role; mustChangePassword: boolean; permissions: Permission[] };

export type Property = { name: string; timezone: string; currency: string };

export type Option = { value: string; label: string };
/** Labels and allowed values served by the API for building forms. */
export type Reference = {
  roles: Option[];
  assignableRoles: Option[];
  roomStatuses: Option[];
  reservationStatuses: Option[];
  paymentStatuses: Option[];
  paymentMethods: Option[];
  staffPaymentMethods: Option[];
  posPaymentMethods: Option[];
  employmentStatuses: Option[];
  stockMovements: Option[];
  paymentProviders: Option[];
  exceptionKinds: Option[];
};

export type RoomStatus = "vacant_clean" | "vacant_dirty" | "occupied" | "inspected" | "maintenance" | "out_of_order";
export type Room = {
  id: string;
  room_number: string;
  room_type: string;
  nightly_rate_kobo: string;
  capacity: number;
  status: RoomStatus;
  active?: boolean;
  /** Set when the room is an apartment's unit; such rooms are edited from Apartments. */
  apartment_id?: string | null;
  stay?: { reference?: string; guest?: string; checkOut: string } | null;
  /** States the signed-in user may set next (from the API's transition rules). */
  next_statuses: RoomStatus[];
};

export type ReservationStatus = "hold" | "pending_payment" | "confirmed" | "checked_in" | "checked_out" | "cancelled" | "no_show" | "expired";
export type ReservationPaymentStatus = "unpaid" | "pending" | "part_paid" | "paid";
export type Reservation = {
  id: string;
  reference: string;
  guest_name: string;
  email?: string;
  phone?: string;
  room_id?: string;
  room_type: string;
  room_number?: string;
  check_in: string;
  check_out: string;
  guests_count?: number;
  amount_kobo: string;
  paid_kobo?: string;
  status: ReservationStatus;
  payment_status: ReservationPaymentStatus;
  source?: string;
  notes?: string | null;
  created_at?: string;
  /**
   * What the signed-in user may do now, decided by the API. `edit`: everything,
   * guest details and check-out (in-house), guest details only, or nothing.
   */
  actions: { next_statuses: ReservationStatus[]; record_payment: boolean; edit?: "full" | "stay_end" | "contact" | "none" };
};

export type PaymentSource = "accommodation" | "restaurant";
export type PaymentStatus = "pending" | "settled" | "failed";
export type PaymentMethod = "cash" | "pos" | "bank_transfer";
export type PaymentRecord = {
  id: string;
  source: PaymentSource;
  reference: string;
  guest_name: string;
  unit_label: string;
  amount_kobo: string;
  method: string;
  status: PaymentStatus;
  payment_reference?: string;
  created_at: string;
  recorded_by?: string;
  confirmed_by?: string;
  confirmed_at?: string;
};

export type EmploymentStatus = "active" | "on_leave" | "terminated";
export type AttendanceEvent = "clock_in" | "clock_out";
export type Staff = {
  id: string;
  user_id?: string;
  employee_number: string;
  department: string;
  job_title: string;
  phone?: string;
  emergency_contact?: string;
  start_date?: string | null;
  employment_status: EmploymentStatus;
  full_name: string;
  email: string;
  role: Role;
  last_attendance_event?: AttendanceEvent;
  last_attendance_at?: string;
  /** Whether the signed-in user may change this member's status or reset their password. */
  can_manage: boolean;
};

export type InventoryItem = {
  id: string;
  name: string;
  sku?: string;
  unit: string;
  quantity: string;
  reorder_level: string;
  cost_kobo: string;
  low_stock: boolean;
  active?: boolean;
};

export type StockMovement = { id: string; type: string; quantity_delta: string; reason: string | null; reference: string | null; recorded_by: string | null; created_at: string };

export type MenuItem = {
  id: string;
  name: string;
  category: string;
  price_kobo: string;
  active?: boolean;
  /** Stock used per item sold, with what is on hand now. */
  recipe: { itemId: string; name: string; quantity: number; unit?: string; onHand?: number }[];
};

export type ActivityEvent = { id: string; event_type: string; entity_id: string; payload: Record<string, unknown>; created_at: string };

export type Dashboard = {
  property: { name: string; timezone: string; currency: string };
  metrics: Record<string, number | string>;
  reservations: Reservation[];
  activity: ActivityEvent[];
  operations: { open_housekeeping: number; completed_housekeeping: number };
  staff: { clocked_in: number };
  user: User;
  serverTime: string;
};

export type Shift = { id: string; opening_float_kobo: string; opened_at: string };
export type PosOrder = {
  id: string;
  receipt_number: string;
  total_kobo: string;
  payment_method: PaymentMethod;
  payment_status: "pending" | "settled";
  created_at: string;
  cashier: string;
};
export type Receipt = {
  receipt_number: string;
  property_name: string;
  items: { item_name: string; quantity: number; unit_price_kobo: string; line_total_kobo: string }[];
  payment_method: PaymentMethod;
  total_kobo: string;
  created_at: string;
  cashier: string;
};

// ---- Request inputs ----

export type LoginInput = { email: string; password: string };
export type ChangePasswordInput = { currentPassword: string; newPassword: string };
export type SetupInput = { propertyName: string; fullName: string; email: string; password: string; setupSecret?: string };
export type NewReservationInput = { name: string; email?: string; phone?: string; roomId: string; checkIn: string; checkOut: string; guests: number; notes?: string };
export type RecordPaymentInput = { amountKobo: number; method: PaymentMethod; paymentReference?: string; idempotencyKey: string };
export type NewRoomInput = { roomNumber: string; roomType: string; nightlyRateKobo: number; capacity: number };
export type NewStaffInput = {
  fullName: string;
  email: string;
  employeeNumber: string;
  department: string;
  jobTitle: string;
  role: Role;
  phone?: string;
  emergencyContact?: string;
  startDate?: string;
  /** Omit to have the server generate one (returned once). */
  temporaryPassword?: string;
};
export type NewInventoryItemInput = { name: string; sku?: string; unit: string; quantity: number; reorderLevel: number; costKobo: number };
export type StockMovementInput = { action: "receive" | "adjust" | "wastage"; itemId: string; quantity: number; reason: string };
export type NewMenuItemInput = { name: string; category: string; priceKobo: number; recipe: { itemId: string; quantity: number }[] };
export type NewPosOrderInput = {
  items: { menuItemId: string; quantity: number }[];
  paymentMethod: PaymentMethod;
  paymentReference?: string;
  idempotencyKey: string;
};
export type CreatedPosOrder = { id: string; receipt_number: string; payment_status: "pending" | "settled"; duplicate: boolean };

// ---- Owner settings ----

export type SettingView = {
  key: string;
  group: "payments" | "booking" | "email";
  label: string;
  description: string;
  type: "string" | "enum" | "integer";
  secret: boolean;
  value: string | number | null;
  configured: boolean;
  hint: string | null;
  readable: boolean;
  default: string | number | null;
  options: Option[] | null;
  /** For provider credentials: the provider they belong to. */
  provider: string | null;
  minimum: number | null;
  maximum: number | null;
  updatedAt: string;
  updatedBy: string | null;
};
export type SettingsSnapshot = { settings: SettingView[]; environment: { publicWebUrl: string | null; webhookUrl: string | null } };
export type SettingsChanges = Record<string, string | number | null>;

export type EmailStatus = "queued" | "sending" | "sent" | "failed" | "skipped";
export type EmailLogEntry = {
  id: string;
  template: string;
  audience: "guest" | "staff" | "management";
  recipient: string;
  /** Null until the message has been rendered for sending. */
  subject: string | null;
  status: EmailStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
};
/** Recent deliveries, and counts by status over the last 7 days plus everything still queued. */
export type EmailLog = { messages: EmailLogEntry[]; counts: Partial<Record<EmailStatus, number>> };

// ---- Payment exceptions & register ----

export type PaymentException = {
  id: string;
  kind: string;
  title: string;
  status: "open" | "resolved";
  reservation_id: string | null;
  reservation_reference: string | null;
  payment_id: string | null;
  pos_order_id: string | null;
  provider: string | null;
  provider_reference: string | null;
  expected_amount_kobo: string | null;
  received_amount_kobo: string | null;
  details: Record<string, unknown>;
  detected_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
};
export type PaymentTotals = { count: number; settledKobo: string; pendingKobo: string; failedKobo: string };
export type PaymentRegister = { payments: PaymentRecord[]; totals: PaymentTotals };

export type RoomHistoryEntry = { action: string; from: string | null; to: string | null; note: string | null; actor: string | null; at: string };
export type MenuItemChanges = Partial<{ name: string; category: string; priceKobo: number; active: boolean; recipe: { itemId: string; quantity: number }[] }>;

// ---- Live updates ----

export type LiveEvent = { id: string; type: string; entityId: string; reference: string | null; at: string };

// ---- Public booking ----

export type AvailableRoomType = { room_type: string; nightly_rate_kobo: string; capacity: number; available_count: number };
export type PublicBookingInput = { name: string; email: string; phone?: string; roomType: string; checkIn: string; checkOut: string; guests: number; notes?: string };
export type PublicBooking = {
  reservation: { id: string; reference: string; amountKobo: string; currency: "NGN"; status: "pending_payment"; holdExpiresAt: string };
  checkoutUrl: string;
};
export type PublicPaymentStatus = { reference: string; paymentStatus: string; reservationStatus: string; amountKobo: string };

/** A published apartment as guests see it (`/public/apartments`). The exact address is shared after booking. */
export type PublicApartment = {
  id: string;
  slug: string;
  name: string;
  /** Send as `roomType` when booking this apartment. */
  bookingRoomType: string;
  category: string;
  summary: string | null;
  description: string | null;
  location: { area: string | null; city: string; state: string; country: string };
  pricing: { nightlyRateKobo: string; cautionFeeKobo: string; currency: "NGN" };
  capacity: { maxGuests: number; bedrooms: number; bathrooms: number; beds: number; sizeSqm: number | null };
  stayRules: { minimumNights: number; checkInTime: string; checkOutTime: string };
  amenities: string[];
  features: string[];
  facilities: string[];
  houseRules: string[];
  policies: { warranty: string | null; cancellation: string | null };
  images: Array<{ id: string; url: string; caption: string | null; isCover: boolean }>;
};
/** Taken nights; a check-out day is free for a new check-in. */
export type BookedRange = { checkIn: string; checkOut: string };
export type PublicApartmentDetail = { apartment: PublicApartment; bookedRanges: BookedRange[] };

// ---- Workspace edits ----

export type RoomChanges = Partial<{ roomNumber: string; roomType: string; nightlyRateKobo: number; capacity: number; active: boolean }>;
export type InventoryItemChanges = Partial<{ name: string; sku: string | null; unit: string; reorderLevel: number; costKobo: number; active: boolean }>;
export type StaffProfileChanges = Partial<{
  fullName: string;
  role: Role;
  employeeNumber: string;
  department: string;
  jobTitle: string;
  phone: string | null;
  emergencyContact: string | null;
  startDate: string | null;
}>;
export type ReservationChanges = Partial<{
  name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  guests: number;
  roomId: string;
  checkIn: string;
  checkOut: string;
}>;
export type ReservationPayment = { id: string; amount_kobo: string; method: string; status: string; reference: string | null; recorded_by: string | null; created_at: string; settled_at: string | null };

// ---- Apartments (management) ----

export type ApartmentStatus = "draft" | "published" | "archived";
export type ApartmentStay = { reference: string; guestName: string | null; checkIn: string; checkOut: string; status: string };
export type ApartmentImage = { id: string; url: string; caption: string | null; position: number; isCover: boolean; contentType: string; byteSize: number };
export type Apartment = {
  id: string;
  roomId: string;
  slug: string;
  name: string;
  unitCode: string;
  category: string;
  summary: string | null;
  description: string | null;
  status: ApartmentStatus;
  location: { addressLine: string | null; area: string | null; city: string; state: string; country: string; latitude: number | null; longitude: number | null; directions: string | null };
  /** Null for roles that may not see prices. */
  pricing: { nightlyRateKobo: string | null; cautionFeeKobo: string | null; currency: "NGN" };
  capacity: { maxGuests: number; bedrooms: number; bathrooms: number; beds: number; sizeSqm: number | null };
  stayRules: { minimumNights: number; checkInTime: string; checkOutTime: string };
  amenities: string[];
  features: string[];
  facilities: string[];
  houseRules: string[];
  policies: { warranty: string | null; cancellation: string | null };
  images: ApartmentImage[];
  unitStatus: string;
  currentStay: ApartmentStay | null;
  nextArrival: ApartmentStay | null;
  createdAt: string;
  updatedAt: string;
};
/** Create and update share one shape; on update only sent fields change and null clears optional text. */
export type ApartmentInput = {
  name?: string;
  unitCode?: string;
  slug?: string;
  category?: string;
  summary?: string | null;
  description?: string | null;
  status?: ApartmentStatus;
  location?: Partial<{ addressLine: string | null; area: string | null; city: string; state: string; country: string; directions: string | null }>;
  nightlyRateKobo?: number;
  cautionFeeKobo?: number;
  maxGuests?: number;
  bedrooms?: number;
  bathrooms?: number;
  beds?: number;
  sizeSqm?: number | null;
  minimumNights?: number;
  checkInTime?: string;
  checkOutTime?: string;
  amenities?: string[];
  features?: string[];
  facilities?: string[];
  houseRules?: string[];
  warrantyPolicy?: string | null;
  cancellationPolicy?: string | null;
};
export type ApartmentBooking = {
  id: string;
  reference: string;
  apartment: { id: string; name: string; unitCode: string; slug: string };
  status: string;
  source: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  guests: number;
  booker: { name: string; email: string | null; phone: string | null };
  notes: string | null;
  payment: {
    status: string;
    amountKobo: string;
    paidKobo: string;
    pendingKobo: string;
    balanceKobo: string;
    cautionFeeKobo: string;
    payments: Array<{ id: string; amountKobo: string; method: string; status: string; reference: string | null; provider: string | null; recordedBy: string | null; confirmedBy: string | null; createdAt: string; settledAt: string | null }>;
  };
  holdExpiresAt: string | null;
  createdBy: string | null;
  createdAt: string;
};
export type ApartmentBookings = { bookings: ApartmentBooking[]; totals: { count: number; amountKobo: string; paidKobo: string; balanceKobo: string } };
