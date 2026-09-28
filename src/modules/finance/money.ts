import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';

// Dinero: se suma siempre en Decimal (nunca en float) y se presenta como número con 2 decimales.

export const Decimal = Prisma.Decimal;
export type Money = Prisma.Decimal;

export const ZERO = new Decimal(0);

/** Monto de entrada: positivo, hasta 2 decimales y un tope razonable. */
export const amount = z
  .number()
  .positive()
  .max(999_999_999_999)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, { message: 'max 2 decimals' });

/** Saldo de apertura: puede ser negativo (ej. un banco en descubierto). */
export const signedAmount = z.number().min(-999_999_999_999).max(999_999_999_999);

export const toMoney = (v: number | string | Money) => new Decimal(v).toDecimalPlaces(2);
export const present = (v: Money | null | undefined) => (v == null ? null : Number(v.toFixed(2)));

/** Tipos que suman al saldo de la caja; el resto resta. */
export const INFLOW = new Set(['income', 'transfer_in']);
