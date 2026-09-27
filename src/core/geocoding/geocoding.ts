import { env } from '../../config/env.js';
import { AppError } from '../http/errors.js';
import { logger } from '../logger.js';

export interface GeocodeResult {
  lat: number;
  lng: number;
  label: string;
}

export const geocodingEnabled = () => env.GEOCODING_PROVIDER !== 'none' && Boolean(env.GEOCODING_API_KEY);

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(6000),
    headers: { Accept: 'application/json' },
  });
  if (res.status === 404) return []; // LocationIQ responde 404 cuando no encuentra nada
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Busca coordenadas para una dirección libre. El proveedor se elige por env; sin proveedor la API
 * responde GEOCODING_DISABLED y el front deja marcar el punto a mano en el mapa.
 */
export async function geocode(query: string): Promise<GeocodeResult[]> {
  if (!geocodingEnabled()) throw new AppError(503, 'GEOCODING_DISABLED');
  const q = encodeURIComponent(query);
  const key = encodeURIComponent(env.GEOCODING_API_KEY!);
  const country = env.GEOCODING_COUNTRY.toLowerCase();
  try {
    if (env.GEOCODING_PROVIDER === 'locationiq') {
      const data = (await getJson(
        `https://us1.locationiq.com/v1/search?key=${key}&q=${q}&format=json&limit=5&countrycodes=${country}`,
      )) as { lat: string; lon: string; display_name: string }[];
      return data.map((r) => ({ lat: Number(r.lat), lng: Number(r.lon), label: r.display_name }));
    }
    const data = (await getJson(
      `https://api.geoapify.com/v1/geocode/search?text=${q}&apiKey=${key}&limit=5&filter=countrycode:${country}&format=json`,
    )) as { results?: { lat: number; lon: number; formatted: string }[] };
    return (data.results ?? []).map((r) => ({ lat: r.lat, lng: r.lon, label: r.formatted }));
  } catch (err) {
    logger.warn({ err, provider: env.GEOCODING_PROVIDER }, 'Falló la geocodificación');
    throw new AppError(502, 'GEOCODING_FAILED');
  }
}

/** Distancia en km entre dos puntos (fórmula del haversine). */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}
