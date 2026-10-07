import { LegacyBaseline1791158400000 } from "./1791158400000-legacy-baseline.js";
import { CreateApiSessions1791158400001 } from "./1791158400001-create-api-sessions.js";
import { BookingIntegrityAndPaymentExceptions1791158400002 } from "./1791158400002-booking-integrity-and-payment-exceptions.js";
import { CreateSettings1791158400003 } from "./1791158400003-create-settings.js";
import { CreateEmailMessages1791158400004 } from "./1791158400004-create-email-messages.js";
import { CreateApartments1791158400005 } from "./1791158400005-create-apartments.js";
import { ApartmentImagesObjectStorage1791158400006 } from "./1791158400006-apartment-images-object-storage.js";

/**
 * Ordered list of migrations. Registered explicitly (not by glob) so the same
 * list works from compiled JS, tsx and tests. Append new migrations here.
 */
export const migrations = [LegacyBaseline1791158400000, CreateApiSessions1791158400001, BookingIntegrityAndPaymentExceptions1791158400002, CreateSettings1791158400003, CreateEmailMessages1791158400004, CreateApartments1791158400005, ApartmentImagesObjectStorage1791158400006];
