# Camino a producción

Hoja de ruta para pasar de la PC local a un servicio en internet que usen iglesias reales. Está **en orden**: cada etapa necesita la anterior.

- **Qué hay**: el código de las fases 0 a 9 está terminado y probado (cientos de tests de integración y CI en cada PR). El producto funciona completo en local: ver [uso-local.md](uso-local.md).
- **Qué falta**: crear las cuentas, publicar en Azure y validar el cobro y los textos legales.
- **Documentos de detalle**:
  - [produccion.md](produccion.md): qué se eligió y por qué;
  - [deploy.md](deploy.md): cómo se publica, paso a paso;
  - [seguridad.md](seguridad.md): revisión de seguridad.

Cada paso dice **quién** lo hace:

- **Vos**: lo hacés vos porque pide tarjeta, datos personales o una decisión de negocio.
- **Juntos**: lo hacemos en una sesión con Claude.
- **Claude**: es código y lo resuelve Claude.

## Etapa 0 — Validar el producto (ahora)

Antes de gastar en infraestructura:

- [ ] **Vos**: presentarlo en tu iglesia desde la PC ([uso-local.md](uso-local.md), sección 4) y juntar devoluciones.
- [ ] **Claude**: convertir las devoluciones en tramos de trabajo (mejorar, cambiar, quitar o agregar), con el mismo flujo de siempre: PR de la API, PR de la web, CI y prueba en el navegador.
- [ ] **Claude**: corregir la fusión de personas. Hoy no mueve las membresías de ministerio, los turnos, las inscripciones a eventos ni los diezmos nominales de la ficha duplicada (`mergePeople` en `src/modules/people/people.service.ts`). Hay que resolverlo antes de que alguien fusione datos reales.

## Etapa 1 — Decisiones de negocio

- [ ] **Vos**: **nombre y dominio**. Chequear que esté libre (por ejemplo `shaddaiapp.com`) y comprarlo en Cloudflare Registrar (un `.com` ronda USD 10 por año).
- [ ] **Vos**: **precios** de los planes Básico, Estándar y Pro:
  - en dólares de referencia y en pesos para el débito automático;
  - límites por defecto: la propuesta es 5/15/40 usuarios y 1/5/20 GB.
- [ ] **Vos**: **casilla de soporte real** (por ejemplo `soporte@<dominio>.com`). Va en `SUPPORT_EMAIL` (API) y `VITE_SUPPORT_EMAIL` (web).
- [ ] **Vos**: **gestor de contraseñas** (Bitwarden, 1Password…). Ahí van todos los secretos; nunca al repo ni al chat.
- [ ] **Vos**: **abogado**, que revise la política de privacidad y los términos (Ley 25.326, datos sensibles de iglesias).
  - Los textos están en `shaddai-web/src/locales/*/legal.json`.
  - **Claude**, después: poner `LEGAL_DRAFT = false` y la fecha en `src/features/legal/constants.ts`.

## Etapa 2 — Cuentas

Todas las crea el dueño, porque piden tarjeta o datos personales. Ver [deploy.md](deploy.md), secciones 1 y 2.

- [ ] **Vos**: **Cloudflare**: dominio, activar R2 (pide medio de pago aunque el uso chico sea gratis) y Turnstile.
- [ ] **Vos**: **Azure**: suscripción de pago por uso. En la beta el costo es casi nulo (oferta gratuita de SQL serverless y cuota gratuita de Container Apps); con varias iglesias, entre USD 30 y 80 por mes.
- [ ] **Vos**: **Brevo** (mail): cuenta gratuita, 300 mails por día.
- [ ] **Vos**: **Sentry** (errores): plan Developer gratuito.
- [ ] **Vos**: **GitHub**: un token para que Azure baje las imágenes (deploy.md, "Imágenes").
- [ ] **Vos**: **Mercado Pago**: cuenta de vendedor en Argentina y una aplicación con el producto Suscripciones. Puede esperar a la etapa 5.

## Etapa 3 — Staging (copia de prueba en internet)

- [ ] **Vos**: instalar Azure CLI en la PC (`winget install --id Microsoft.AzureCLI -e`; pide administrador) y `az login`.
- [ ] **Juntos**: crear staging siguiendo [deploy.md](deploy.md), secciones 3 a 5:
  - generar los secretos (van al gestor) y aplicar la infraestructura en Bicep;
  - crear los usuarios de la base;
  - cargar los registros DNS de `app-staging` y `api-staging`, y los de Brevo (SPF, DKIM, DMARC);
  - configurar la publicación automática desde GitHub: identidad OIDC y entornos.
- [ ] **Juntos**: probar staging de punta a punta:
  - login;
  - alta de una iglesia desde el panel;
  - un mail real;
  - subir una foto;
  - un error de prueba que aparezca en Sentry.
- [ ] **Juntos**: escaneo de seguridad ZAP (deploy.md, sección 7) sin hallazgos altos.
- [ ] **Juntos**: simulacro de restauración de un backup (deploy.md, sección 6).

## Etapa 4 — Producción

- [ ] **Juntos**: crear producción igual que staging, con su propia base, bucket y secretos, y la aprobación obligatoria en GitHub para publicar.
- [ ] **Juntos**: dominios `app` y `api` con sus certificados (deploy.md, sección 4).
- [ ] **Vos**: el primer ingreso del superadmin real. La contraseña temporal se ve una sola vez; después hay que enrolar el 2FA y guardar los códigos de recuperación en el gestor.
- [ ] **Vos**: cargar los precios en Plataforma → Planes.

## Etapa 5 — Cobro con Mercado Pago

El código está listo; falta probarlo con Mercado Pago de verdad. Mientras tanto, los pagos se registran a mano desde la ficha de cada iglesia en el panel de plataforma (`BILLING_PROVIDER=none`).

- [ ] **Vos**: pasar las **credenciales de prueba** de Mercado Pago (access token y secreto del webhook), por el gestor y no por el chat.
- [ ] **Juntos**: prueba en sandbox sobre staging ([produccion.md](produccion.md), "Cobro del servicio"):
  - configurar el webhook en el panel de Mercado Pago;
  - suscribirse con un comprador de prueba;
  - ver el cobro aprobado y cancelar.

  **Hay que confirmar** cómo informa Mercado Pago a qué suscripción pertenece cada cobro y que la firma coincida.

- [ ] **Juntos**: pasar a las **credenciales de producción**.

## Etapa 6 — Beta con iglesia piloto

- [ ] **Juntos**: dar de alta la iglesia piloto (puede ser la tuya) desde el panel. Si ya cargaron datos en tu PC, los pasamos con la exportación o el import de personas.
- [ ] **Vos**: acompañarla **2 semanas** de uso real. Es el criterio de cierre de la Fase 8.
- [ ] **Claude**: corregir lo que aparezca. Cada cambio pasa por staging antes de producción.

## Después

- **Fase 10** (a priorizar según lo que pidan las iglesias): documentos, niños con check-in, presupuesto, campos personalizados, modo offline completo, avisos push o por WhatsApp, seguridad a nivel de fila en SQL Server.
- **Mantenimiento mensual**:
  - revisar las PRs de Dependabot;
  - hacer un simulacro de restauración;
  - mirar Sentry y el uso de Azure.
