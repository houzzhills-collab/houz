import { ApiError, type ApiClient } from "./client";
import type {
  Apartment,
  GuestIdSide,
  GuestBooking,
  GuestSession,
  ApartmentBookings,
  ReservationPayment,
  StockMovement,
  AvailableRoomType,
  CreatedPosOrder,
  Dashboard,
  EmailLog,
  InventoryItem,
  LiveEvent,
  MenuItem,
  PaymentException,
  PaymentRecord,
  PaymentTotals,
  PosOrder,
  Property,
  PublicBooking,
  PublicApartment,
  PublicApartmentDetail,
  PublicPaymentStatus,
  Receipt,
  Reference,
  Reservation,
  Room,
  RoomHistoryEntry,
  SettingsSnapshot,
  Shift,
  Staff,
  User,
} from "./types";

/**
 * ApiClient for the Houzz Hills API (../api), served under `/api/v1`.
 *
 * - Base URL: empty means same-origin; the web server forwards `/api/v1/*` to the
 *   API (see next.config.ts), so the refresh cookie stays first-party. Set
 *   NEXT_PUBLIC_API_BASE_URL only to call the API directly on another origin.
 * - Auth: the short-lived access token is kept in memory only and sent as a
 *   bearer token; the refresh token is an HttpOnly cookie the browser handles.
 *   An expired access token is refreshed once (single-flight) and the request retried.
 * - Money/order writes send an `Idempotency-Key` header.
 */

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type RequestOptions = { body?: unknown; form?: FormData; idempotencyKey?: string; authenticated?: boolean; retryOnExpiry?: boolean; headers?: Record<string, string> };
type TokenResponse = { accessToken: string; user: User };

const PREFIX = "/api/v1";
const TIMEOUT_MS = 20_000;
/** The API's maximum page size. */
const PAGE_SIZE = 200;
/** Upper bound when reading a whole collection (rooms, staff, stock, menu). */
const MAX_PAGES = 50;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export function createHttpClient(baseUrl: string): ApiClient {
  const origin = baseUrl.replace(/\/+$/, "");
  let accessToken: string | null = null;
  let refreshing: Promise<boolean> | null = null;

  async function send(method: Method, path: string, options: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json", ...options.headers };
    // The browser sets the multipart boundary itself for form uploads.
    if (options.body !== undefined && !options.form) headers["Content-Type"] = "application/json";
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
    if (options.authenticated !== false && accessToken) headers.Authorization = `Bearer ${accessToken}`;
    try {
      return await fetch(`${origin}${PREFIX}${path}`, {
        method,
        headers,
        body: options.form ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
        credentials: "include",
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      throw new ApiError(0, timedOut ? "TIMEOUT" : "NETWORK_ERROR", timedOut ? "The server took too long to respond. Try again." : "Unable to reach Houzz Hills. Check your connection.");
    }
  }

  async function toError(response: Response): Promise<ApiError> {
    const payload = (await response.json().catch(() => null)) as { code?: string; message?: string } | null;
    return new ApiError(response.status, payload?.code ?? `HTTP_${response.status}`, payload?.message ?? `Request failed (${response.status})`);
  }

  async function refreshAccessToken(): Promise<boolean> {
    refreshing ??= (async () => {
      try {
        const response = await send("POST", "/auth/refresh", { authenticated: false });
        if (!response.ok) {
          accessToken = null;
          return false;
        }
        accessToken = ((await response.json()) as TokenResponse).accessToken;
        return true;
      } catch {
        return false;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  /** Sends a request, refreshing an expired access token once. Returns the raw response. */
  async function exchange(method: Method, path: string, options: RequestOptions = {}): Promise<Response> {
    const response = await send(method, path, options);
    if (response.status === 401 && options.authenticated !== false && options.retryOnExpiry !== false && (await refreshAccessToken())) {
      return exchange(method, path, { ...options, retryOnExpiry: false });
    }
    if (!response.ok) throw await toError(response);
    return response;
  }

  async function request<T>(method: Method, path: string, options: RequestOptions = {}): Promise<T> {
    const response = await exchange(method, path, options);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  /** Reads every page of a keyset-paginated collection. */
  async function listAll<K extends string, T>(path: string, key: K, params: Record<string, string> = {}): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query: URLSearchParams = new URLSearchParams({ ...params, limit: String(PAGE_SIZE), ...(cursor ? { cursor } : {}) });
      const result: Record<K, T[]> & { nextCursor: string | null } = await request("GET", `${path}?${query.toString()}`);
      items.push(...result[key]);
      cursor = result.nextCursor;
      if (!cursor) return items;
    }
    return items;
  }

  /** Server-sent events over fetch, so the bearer token can be sent (EventSource cannot). */
  function subscribe(onEvent: (event: LiveEvent) => void, onStatus?: (connected: boolean) => void): () => void {
    const controller = new AbortController();
    let lastEventId: string | null = null;
    let delay = RECONNECT_MIN_MS;

    const readStream = async (body: ReadableStream<Uint8Array>) => {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
          const fields = new Map<string, string>();
          for (const line of block.split("\n")) {
            const colon = line.indexOf(":");
            if (colon > 0) fields.set(line.slice(0, colon), line.slice(colon + 1).trimStart());
          }
          const id = fields.get("id");
          if (id) lastEventId = id;
          const name = fields.get("event");
          if (name === "property-update") onEvent({ ...(JSON.parse(fields.get("data") ?? "{}") as Omit<LiveEvent, "id">), id: id ?? "" });
          if (name === "resync") onEvent({ id: id ?? "", type: "resync", entityId: "", reference: null, at: new Date().toISOString() });
        }
      }
    };

    const connect = async (): Promise<void> => {
      while (!controller.signal.aborted) {
        try {
          if (!accessToken) await refreshAccessToken();
          const response = await fetch(`${origin}${PREFIX}/management/events`, {
            headers: {
              Accept: "text/event-stream",
              ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
              ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
            },
            credentials: "include",
            cache: "no-store",
            signal: controller.signal,
          });
          // The stream also ends when the access token expires: refresh, then reconnect.
          if (response.status === 401) {
            if (await refreshAccessToken()) continue;
            throw new Error("signed out");
          }
          if (!response.ok || !response.body) throw new Error(`stream failed (${response.status})`);
          onStatus?.(true);
          delay = RECONNECT_MIN_MS;
          await readStream(response.body);
        } catch {
          if (controller.signal.aborted) return;
        }
        onStatus?.(false);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, RECONNECT_MAX_MS);
      }
    };
    void connect();
    return () => controller.abort();
  }

  return {
    auth: {
      async session() {
        if (!accessToken && !(await refreshAccessToken())) return null;
        try {
          return (await request<{ user: User | null }>("GET", "/auth/session")).user;
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) return null;
          throw error;
        }
      },
      async login(input) {
        const result = await request<TokenResponse>("POST", "/auth/login", { body: input, authenticated: false });
        accessToken = result.accessToken;
        return result.user;
      },
      async logout() {
        try {
          await request<void>("POST", "/auth/logout", { authenticated: false });
        } finally {
          accessToken = null;
        }
      },
      changePassword: (input) => request<void>("POST", "/auth/password", { body: input }),
    },

    setup: {
      status: () => request<{ setupRequired: boolean; setupEnabled: boolean }>("GET", "/setup", { authenticated: false }),
      async createOwner({ setupSecret, ...input }) {
        // The setup secret travels in a header, never in the JSON body.
        const response = await fetch(`${origin}${PREFIX}/setup`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(setupSecret ? { "x-setup-secret": setupSecret } : {}) },
          body: JSON.stringify(input),
          credentials: "include",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) throw await toError(response);
      },
    },

    dashboard: {
      get: () => request<Dashboard>("GET", "/management/dashboard"),
    },

    reservations: {
      async list(filters = {}) {
        const query = new URLSearchParams({ limit: String(PAGE_SIZE), ...(filters.q ? { q: filters.q } : {}) });
        return (await request<{ reservations: Reservation[] }>("GET", `/management/reservations?${query.toString()}`)).reservations;
      },
      create: async (input) => (await request<{ reservation: Reservation }>("POST", "/management/reservations", { body: input })).reservation,
      async updateStatus(id, status, reason) {
        await request<unknown>("PATCH", `/management/reservations/${encodeURIComponent(id)}`, { body: reason ? { status, reason } : { status } });
      },
      updateDetails: async (id, changes) =>
        (await request<{ reservation: Reservation }>("PATCH", `/management/reservations/${encodeURIComponent(id)}/details`, { body: changes })).reservation,
      payments: async (id) => (await request<{ payments: ReservationPayment[] }>("GET", `/management/reservations/${encodeURIComponent(id)}/payments`)).payments,
      async updateIdentity(id, input) {
        const form = new FormData();
        form.append("idType", input.idType);
        form.append("idNumber", input.idNumber);
        for (const side of ["front", "back"] as const) {
          const change = input[side];
          if (change === "remove") form.append(side === "front" ? "removeFront" : "removeBack", "true");
          else if (change) form.append(side, change, change.name);
        }
        return (await request<{ reservation: Reservation }>("PUT", `/management/reservations/${encodeURIComponent(id)}/identity`, { form })).reservation;
      },
      deleteIdentity: async (id) => (await request<{ reservation: Reservation }>("DELETE", `/management/reservations/${encodeURIComponent(id)}/identity`)).reservation,
      identityImage: async (id, side: GuestIdSide) =>
        (await exchange("GET", `/management/reservations/${encodeURIComponent(id)}/identity/${side}`, { headers: { Accept: "image/*" } })).blob(),
      recordPayment: async (id, input) =>
        (
          await request<{ payment: { paymentStatus: "pending" | "settled" } }>("POST", `/management/reservations/${encodeURIComponent(id)}/payments`, {
            body: input,
            idempotencyKey: input.idempotencyKey,
          })
        ).payment,
    },

    payments: {
      async register() {
        const result = await request<{ payments: PaymentRecord[]; totals: PaymentTotals }>("GET", `/management/payments?limit=${PAGE_SIZE}`);
        return { payments: result.payments, totals: result.totals };
      },
      async confirm(id, source, note) {
        await request<unknown>("PATCH", `/management/payments/${encodeURIComponent(id)}`, { body: note ? { source, note } : { source } });
      },
      async exportCsv() {
        const response = await exchange("GET", "/management/payments/export");
        const disposition = response.headers.get("content-disposition") ?? "";
        return { filename: /filename="([^"]+)"/.exec(disposition)?.[1] ?? "payments.csv", blob: await response.blob() };
      },
      exceptions: async (status) =>
        (await request<{ exceptions: PaymentException[] }>("GET", `/management/payment-exceptions?status=${status}&limit=${PAGE_SIZE}`)).exceptions,
      async resolveException(id, resolutionNote) {
        await request<unknown>("PATCH", `/management/payment-exceptions/${encodeURIComponent(id)}`, { body: { resolutionNote } });
      },
    },

    rooms: {
      list: () => listAll<"rooms", Room>("/management/rooms", "rooms"),
      create: (input) => request<{ created: number; roomIds: string[] }>("POST", "/management/rooms", { body: input }),
      async updateStatus(id, status, note) {
        await request<unknown>("PATCH", `/management/rooms/${encodeURIComponent(id)}`, { body: note ? { status, note } : { status } });
      },
      history: async (id) => (await request<{ history: RoomHistoryEntry[] }>("GET", `/management/rooms/${encodeURIComponent(id)}/history`)).history,
      async update(id, changes) {
        await request<unknown>("PATCH", `/management/rooms/${encodeURIComponent(id)}/details`, { body: changes });
      },
    },

    staff: {
      list: () => listAll<"staff", Staff>("/management/staff", "staff"),
      create: async (input) =>
        (await request<{ staff: { id: string; userId: string; temporaryPassword?: string } }>("POST", "/management/staff", { body: input })).staff,
      async updateStatus(id, employmentStatus) {
        await request<unknown>("PATCH", `/management/staff/${encodeURIComponent(id)}`, { body: { employmentStatus } });
      },
      updateProfile: (id, changes) => request<{ sessionsRevoked: number }>("PATCH", `/management/staff/${encodeURIComponent(id)}/profile`, { body: changes }),
      resetPassword: (id) => request<{ temporaryPassword: string }>("POST", `/management/staff/${encodeURIComponent(id)}/temporary-password`),
    },

    attendance: {
      self: () => request<{ clockedIn: boolean }>("GET", "/management/attendance/self"),
      async record(eventType) {
        await request<unknown>("POST", "/management/attendance", { body: { eventType } });
      },
    },

    inventory: {
      list: (options) => listAll<"items", InventoryItem>("/management/inventory", "items", options?.includeArchived ? { includeArchived: "true" } : {}),
      createItem: async (input) => (await request<{ item: { id: string } }>("POST", "/management/inventory/items", { body: input })).item,
      async recordMovement(input) {
        await request<unknown>("POST", "/management/inventory/movements", { body: input });
      },
      async updateItem(id, changes) {
        await request<unknown>("PATCH", `/management/inventory/items/${encodeURIComponent(id)}`, { body: changes });
      },
      movements: async (id) => (await request<{ movements: StockMovement[] }>("GET", `/management/inventory/items/${encodeURIComponent(id)}/movements`)).movements,
    },

    menu: {
      list: (options) => listAll<"menu", MenuItem>("/management/menu", "menu", options?.includeArchived ? { includeArchived: "true" } : {}),
      create: async (input) => (await request<{ item: { id: string } }>("POST", "/management/menu", { body: input })).item,
      async update(id, changes) {
        await request<unknown>("PATCH", `/management/menu/${encodeURIComponent(id)}`, { body: changes });
      },
    },

    apartments: {
      list: (options) => listAll<"apartments", Apartment>("/management/apartments", "apartments", options?.status ? { status: options.status } : {}),
      get: async (id) => (await request<{ apartment: Apartment }>("GET", `/management/apartments/${encodeURIComponent(id)}`)).apartment,
      create: async (input) => (await request<{ apartment: Apartment }>("POST", "/management/apartments", { body: input })).apartment,
      update: async (id, changes) => (await request<{ apartment: Apartment }>("PATCH", `/management/apartments/${encodeURIComponent(id)}`, { body: changes })).apartment,
      uploadImages(id, files, caption) {
        const form = new FormData();
        if (caption) form.append("caption", caption);
        for (const file of files) form.append("file", file, file.name);
        return request("POST", `/management/apartments/${encodeURIComponent(id)}/images`, { form });
      },
      updateImage: async (id, imageId, changes) =>
        (await request<{ apartment: Apartment }>("PATCH", `/management/apartments/${encodeURIComponent(id)}/images/${encodeURIComponent(imageId)}`, { body: changes })).apartment,
      reorderImages: async (id, imageIds) =>
        (await request<{ apartment: Apartment }>("PUT", `/management/apartments/${encodeURIComponent(id)}/images/order`, { body: { imageIds } })).apartment,
      deleteImage: async (id, imageId) =>
        (await request<{ apartment: Apartment }>("DELETE", `/management/apartments/${encodeURIComponent(id)}/images/${encodeURIComponent(imageId)}`)).apartment,
      async bookings(filters = {}) {
        const query = new URLSearchParams({ limit: String(PAGE_SIZE), ...(filters.apartmentId ? { apartmentId: filters.apartmentId } : {}), ...(filters.q ? { q: filters.q } : {}) });
        return request<ApartmentBookings>("GET", `/management/apartments/bookings?${query.toString()}`);
      },
    },

    pos: {
      overview: () => request<{ shift: Shift | null; orders: PosOrder[] }>("GET", `/management/pos?limit=${PAGE_SIZE}`),
      createOrder: async (input) =>
        (await request<{ order: CreatedPosOrder }>("POST", "/management/pos", { body: input, idempotencyKey: input.idempotencyKey })).order,
      receipt: async (orderId) => (await request<{ receipt: Receipt }>("GET", `/management/pos/${encodeURIComponent(orderId)}`)).receipt,
      async openShift(openingFloatKobo) {
        await request<unknown>("POST", "/management/pos/shift", { body: { action: "open", openingFloatKobo } });
      },
      closeShift: async (countedCashKobo) =>
        (await request<{ shift: { varianceKobo: string } }>("POST", "/management/pos/shift", { body: { action: "close", countedCashKobo } })).shift,
    },

    settings: {
      get: () => request<SettingsSnapshot>("GET", "/management/settings"),
      update: (changes) => request<SettingsSnapshot>("PATCH", "/management/settings", { body: { changes } }),
      renameProperty: (name) => request<{ name: string }>("PATCH", "/management/settings/property", { body: { name } }),
      verifyPayments: () => request<{ ok: true; provider: string }>("POST", "/management/settings/payments/verify"),
      sendTestEmail: () => request<{ ok: true; to: string }>("POST", "/management/settings/email/test"),
      emailLog: () => request<EmailLog>("GET", "/management/settings/email/messages?limit=25"),
    },

    events: { subscribe },

    reference: {
      get: () => request<Reference>("GET", "/management/reference"),
    },

    publicBooking: {
      property: () => request<Property>("GET", "/public/property", { authenticated: false }),
      async availability({ checkIn, checkOut, guests }) {
        const query = new URLSearchParams({ checkIn, checkOut, guests: String(guests) });
        return (await request<{ roomTypes: AvailableRoomType[] }>("GET", `/public/availability?${query.toString()}`, { authenticated: false })).roomTypes;
      },
      reserve: (input, idempotencyKey) => request<PublicBooking>("POST", "/public/reservations", { body: input, idempotencyKey, authenticated: false }),
      paymentStatus: (reference) => request<PublicPaymentStatus>("GET", `/public/payments/${encodeURIComponent(reference)}`, { authenticated: false }),
      lookup: async (input) => (await request<{ booking: GuestBooking }>("POST", "/public/bookings/lookup", { body: input, authenticated: false })).booking,
      payBooking: (input) => request<{ checkoutUrl: string }>("POST", "/public/bookings/checkout", { body: input, authenticated: false }),
      requestAccessCode: (email) => request<{ expiresMinutes: number }>("POST", "/public/bookings/access-code", { body: { email }, authenticated: false }),
      verifyAccessCode: (input) => request<GuestSession>("POST", "/public/bookings/session", { body: input, authenticated: false }),
      myBookings: (token) => request<{ email: string; bookings: GuestBooking[] }>("GET", "/public/bookings", { authenticated: false, headers: { "x-guest-session": token } }),
      endGuestSession: (token) => request<void>("DELETE", "/public/bookings/session", { authenticated: false, headers: { "x-guest-session": token } }),
      async apartments({ checkIn, checkOut, guests } = {}) {
        const apartments: PublicApartment[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const query = new URLSearchParams({
            limit: String(PAGE_SIZE),
            ...(checkIn && checkOut ? { checkIn, checkOut } : {}),
            ...(guests ? { guests: String(guests) } : {}),
            ...(cursor ? { cursor } : {}),
          });
          const result: { apartments: PublicApartment[]; nextCursor: string | null } = await request("GET", `/public/apartments?${query.toString()}`, { authenticated: false });
          apartments.push(...result.apartments);
          cursor = result.nextCursor;
          if (!cursor) break;
        }
        return apartments;
      },
      apartment: (slug) => request<PublicApartmentDetail>("GET", `/public/apartments/${encodeURIComponent(slug)}`, { authenticated: false }),
    },
  };
}
