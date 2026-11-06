export interface ErrorDetails {
  /** Field name -> Turkish message, for forms. */
  readonly alanlar?: Readonly<Record<string, string>>;
  /** A list of Turkish messages, e.g. every problem of an approval flow. */
  readonly sorunlar?: readonly string[];
}

/** An error with an HTTP status and a Turkish message that is safe to show to the user. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ErrorDetails | undefined;
  constructor(status: number, code: string, message: string, details?: ErrorDetails) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (message = 'Kayıt bulunamadı.'): HttpError => new HttpError(404, 'bulunamadi', message);
export const forbidden = (message = 'Bu işlem için yetkiniz yok.'): HttpError => new HttpError(403, 'yetki_yok', message);
export const conflict = (code: string, message: string): HttpError => new HttpError(409, code, message);
