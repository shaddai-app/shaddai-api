/** Error de aplicación con código estable; el front traduce por `code`. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
    public readonly details?: unknown,
  ) {
    super(message ?? code);
    this.name = 'AppError';
  }

  static badRequest(code = 'BAD_REQUEST', details?: unknown) {
    return new AppError(400, code, undefined, details);
  }
  static unauthorized(code = 'UNAUTHORIZED') {
    return new AppError(401, code);
  }
  static forbidden(code = 'FORBIDDEN', details?: unknown) {
    return new AppError(403, code, undefined, details);
  }
  static notFound(code = 'NOT_FOUND') {
    return new AppError(404, code);
  }
  static conflict(code = 'CONFLICT', details?: unknown) {
    return new AppError(409, code, undefined, details);
  }
  /** Falló un servicio externo (ej. el proveedor de cobros). */
  static badGateway(code = 'BAD_GATEWAY') {
    return new AppError(502, code);
  }
}
