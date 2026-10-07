import type {
  Apartment,
  ApartmentStatus,
  ApartmentBookings,
  ApartmentInput,
  InventoryItemChanges,
  ReservationChanges,
  ReservationPayment,
  RoomChanges,
  StaffProfileChanges,
  StockMovement,
  AttendanceEvent,
  ChangePasswordInput,
  CreatedPosOrder,
  Dashboard,
  EmploymentStatus,
  AvailableRoomType,
  InventoryItem,
  LiveEvent,
  MenuItemChanges,
  PaymentException,
  PaymentRegister,
  PublicBooking,
  PublicBookingInput,
  PublicApartment,
  PublicApartmentDetail,
  PublicPaymentStatus,
  RoomHistoryEntry,
  EmailLog,
  SettingsChanges,
  SettingsSnapshot,
  LoginInput,
  MenuItem,
  NewInventoryItemInput,
  NewMenuItemInput,
  NewPosOrderInput,
  NewReservationInput,
  NewRoomInput,
  NewStaffInput,
  PaymentSource,
  Property,
  Reference,
  PosOrder,
  Receipt,
  RecordPaymentInput,
  Reservation,
  ReservationStatus,
  Room,
  RoomStatus,
  SetupInput,
  Shift,
  Staff,
  StockMovementInput,
  User,
} from "./types";

/**
 * Everything the web app needs from the Houzz Hills API. Components depend on
 * this interface only; `src/lib/api/http.ts` implements it.
 */
export interface ApiClient {
  auth: {
    /** The signed-in user, or null. */
    session(): Promise<User | null>;
    login(input: LoginInput): Promise<User>;
    logout(): Promise<void>;
    changePassword(input: ChangePasswordInput): Promise<void>;
  };
  setup: {
    status(): Promise<{ setupRequired: boolean; setupEnabled: boolean }>;
    createOwner(input: SetupInput): Promise<void>;
  };
  dashboard: {
    get(): Promise<Dashboard>;
  };
  reservations: {
    /** Most recent stays; `q` searches guest name and reference on the server. */
    list(filters?: { q?: string }): Promise<Reservation[]>;
    create(input: NewReservationInput): Promise<Reservation>;
    /** `reason` is required (and audited) for cancellations and no-shows. */
    updateStatus(id: string, status: ReservationStatus, reason?: string): Promise<void>;
    /** Guest details, dates, room or guest count; `actions.edit` says what may change. */
    updateDetails(id: string, changes: ReservationChanges): Promise<Reservation>;
    payments(id: string): Promise<ReservationPayment[]>;
    recordPayment(id: string, input: RecordPaymentInput): Promise<{ paymentStatus: "pending" | "settled" }>;
  };
  payments: {
    register(): Promise<PaymentRegister>;
    /** Confirms a pending bank transfer (owner/manager). */
    confirm(id: string, source: PaymentSource, note?: string): Promise<void>;
    /** The register as a CSV file. */
    exportCsv(): Promise<{ filename: string; blob: Blob }>;
    exceptions(status: "open" | "resolved"): Promise<PaymentException[]>;
    resolveException(id: string, resolutionNote: string): Promise<void>;
  };
  rooms: {
    list(): Promise<Room[]>;
    create(input: NewRoomInput): Promise<{ created: number; roomIds: string[] }>;
    updateStatus(id: string, status: RoomStatus, note?: string): Promise<void>;
    /** Edits a room, or retires (`active: false`) / restores it. */
    update(id: string, changes: RoomChanges): Promise<void>;
    history(id: string): Promise<RoomHistoryEntry[]>;
  };
  staff: {
    list(): Promise<Staff[]>;
    /** `temporaryPassword` is returned once when the server generated it. */
    create(input: NewStaffInput): Promise<{ id: string; userId: string; temporaryPassword?: string }>;
    updateStatus(id: string, status: EmploymentStatus): Promise<void>;
    /** A role change signs the member out everywhere. */
    updateProfile(id: string, changes: StaffProfileChanges): Promise<{ sessionsRevoked: number }>;
    /** Issues a one-time temporary password and signs the member out everywhere. */
    resetPassword(id: string): Promise<{ temporaryPassword: string }>;
  };
  attendance: {
    self(): Promise<{ clockedIn: boolean }>;
    record(eventType: AttendanceEvent): Promise<void>;
  };
  inventory: {
    list(options?: { includeArchived?: boolean }): Promise<InventoryItem[]>;
    createItem(input: NewInventoryItemInput): Promise<{ id: string }>;
    /** Edits, archives (`active: false`) or restores an item. Quantity changes only through movements. */
    updateItem(id: string, changes: InventoryItemChanges): Promise<void>;
    movements(id: string): Promise<StockMovement[]>;
    recordMovement(input: StockMovementInput): Promise<void>;
  };
  menu: {
    list(options?: { includeArchived?: boolean }): Promise<MenuItem[]>;
    create(input: NewMenuItemInput): Promise<{ id: string }>;
    /** Edits or archives (`active: false`) an item; past receipts keep the old values. */
    update(id: string, changes: MenuItemChanges): Promise<void>;
  };
  apartments: {
    /** Draft and published apartments, or only those with `status` (e.g. archived). */
    list(options?: { status?: ApartmentStatus }): Promise<Apartment[]>;
    get(id: string): Promise<Apartment>;
    /** Created as a draft; upload photos, then publish. */
    create(input: ApartmentInput): Promise<Apartment>;
    /** Edit, publish, unpublish (`draft`) or archive. */
    update(id: string, changes: ApartmentInput): Promise<Apartment>;
    uploadImages(id: string, files: File[], caption?: string): Promise<{ uploaded: number; duplicates: number; apartment: Apartment }>;
    updateImage(id: string, imageId: string, changes: { caption?: string | null; isCover?: true }): Promise<Apartment>;
    reorderImages(id: string, imageIds: string[]): Promise<Apartment>;
    deleteImage(id: string, imageId: string): Promise<Apartment>;
    bookings(filters?: { apartmentId?: string; q?: string }): Promise<ApartmentBookings>;
  };
  pos: {
    /** The current user's open cashier shift and today's orders. */
    overview(): Promise<{ shift: Shift | null; orders: PosOrder[] }>;
    createOrder(input: NewPosOrderInput): Promise<CreatedPosOrder>;
    /** Only available once the order's payment is settled. */
    receipt(orderId: string): Promise<Receipt>;
    openShift(openingFloatKobo: number): Promise<void>;
    closeShift(countedCashKobo: number): Promise<{ varianceKobo: string }>;
  };
  settings: {
    /** Owner only. Secret values are never returned. */
    get(): Promise<SettingsSnapshot>;
    update(changes: SettingsChanges): Promise<SettingsSnapshot>;
    verifyPayments(): Promise<{ provider: string }>;
    /** Renames the property: the workspace logo, receipts, booking pages and every email's brand. */
    renameProperty(name: string): Promise<{ name: string }>;
    /** Sends a test email to the signed-in owner with the saved Resend key and sender. */
    sendTestEmail(): Promise<{ to: string }>;
    emailLog(): Promise<EmailLog>;
  };
  events: {
    /** Live property updates; reconnects automatically. Returns a function that stops the stream. */
    subscribe(onEvent: (event: LiveEvent) => void, onStatus?: (connected: boolean) => void): () => void;
  };
  reference: {
    /** Form vocabularies and the roles the signed-in user may assign. */
    get(): Promise<Reference>;
  };
  publicBooking: {
    /** The property the public site serves. */
    property(): Promise<Property>;
    availability(query: { checkIn: string; checkOut: string; guests: number }): Promise<AvailableRoomType[]>;
    reserve(input: PublicBookingInput, idempotencyKey: string): Promise<PublicBooking>;
    paymentStatus(reference: string): Promise<PublicPaymentStatus>;
    /** Published apartments; with dates, only those free for the whole stay. */
    apartments(query?: { checkIn?: string; checkOut?: string; guests?: number }): Promise<PublicApartment[]>;
    apartment(slug: string): Promise<PublicApartmentDetail>;
  };
}

/** Error raised by every ApiClient; `message` is safe to show to staff. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
