import type { ErrorEvent } from '@sentry/node';
import { describe, expect, it } from 'vitest';
import { scrubBreadcrumb, scrubEvent, stripQuery } from './sentry.js';

describe('Sentry sin datos personales', () => {
  it('saca query string y fragmento', () => {
    expect(stripQuery('https://api.x.com/api/v1/people?q=Juan#a')).toBe('https://api.x.com/api/v1/people');
    expect(stripQuery('/auth/reset')).toBe('/auth/reset');
  });

  it('del pedido quedan solo el método y la ruta; del usuario, el id', () => {
    const event = scrubEvent({
      type: undefined,
      request: {
        method: 'POST',
        url: 'https://api.x.com/api/v1/auth/reset?token=secreto',
        data: { password: 'x' },
        cookies: { refresh: 'y' },
        headers: { authorization: 'Bearer z' },
        query_string: 'token=secreto',
      },
      user: { id: '7', email: 'a@b.com', ip_address: '1.2.3.4' },
    } as ErrorEvent);
    expect(event.request).toEqual({ method: 'POST', url: 'https://api.x.com/api/v1/auth/reset' });
    expect(event.user).toEqual({ id: '7' });
  });

  it('las URLs de los breadcrumbs no llevan parámetros (claves de terceros, búsquedas)', () => {
    const crumb = scrubBreadcrumb({
      category: 'http',
      data: { url: 'https://us1.locationiq.com/v1/search?key=SECRETA&q=Calle 1', method: 'GET' },
    });
    expect(crumb.data).toEqual({ url: 'https://us1.locationiq.com/v1/search', method: 'GET' });
  });
});
