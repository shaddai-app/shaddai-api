# Usar y presentar Shaddai desde tu PC

Guía para explorar la app en tu entorno local y mostrarla en una iglesia antes de pensar en producción. La puesta en marcha desde cero (SQL Server, `.env`, base) está en el [README](../README.md). Cuando decidas salir a producción, seguí [camino-a-produccion.md](camino-a-produccion.md).

## 1. Levantar todo

Dos terminales:

```powershell
# shaddai-api
npm run dev          # http://localhost:3000/api/v1/health

# shaddai-web
npm run dev          # http://localhost:5173
```

Abrí `http://localhost:5173`.

## 2. La iglesia de ejemplo

Con `SEED_DEMO=true` en el `.env` de la API, el seed crea **Iglesia Demo** con datos para recorrer todos los módulos:

- **Personas**: unas 30 personas con familias, estados, etiquetas e hitos.
- **Células**: redes, zonas y células con reportes semanales.
- **Seguimiento**: casos de consolidación.
- **Finanzas**: cajas, unos 3 meses de movimientos, arqueos y cierres.
- **Calendario y ministerios**: eventos con inscripciones, ministerios con turnos, canciones y listas.
- **Inventario**: equipos y préstamos.
- **Comunicación**: anuncios y peticiones de oración.
- **Discipulado**: Escuela de líderes con clases y asistencia, y Clases de bautismo.

```powershell
npm run db:seed      # idempotente: crea lo que falta, no duplica
```

### Usuarios de ejemplo

Todos usan la contraseña `SEED_DEMO_PASSWORD` del `.env` de la API (la generó `npm run env:init`).

| Usuario                       | Rol             | Para mostrar                                                                    |
| ----------------------------- | --------------- | ------------------------------------------------------------------------------- |
| `demo-admin@shaddai.local`    | Administrador   | Todo, incluida la administración (usuarios, roles, configuración, facturación)  |
| `demo-pastor@shaddai.local`   | Pastor          | Visión pastoral: personas, células, seguimiento, oración, discipulado, anuncios |
| `demo-tesorero@shaddai.local` | Tesorero        | Finanzas completas: movimientos, arqueos, cierres, reportes                     |
| `demo-lider@shaddai.local`    | Líder de célula | Su célula desde el celular: reporte semanal, integrantes, maestro del Nivel 1   |

Entrar con cada uno muestra cómo cambia la app según el rol: el menú solo ofrece lo que ese rol puede usar.

### Panel de plataforma (tu lado como dueño del SaaS)

El superadmin (`SEED_SUPERADMIN_EMAIL`) entra al **panel de plataforma** en `/plataforma`. Ahí se dan de alta iglesias, se cambian planes y estados, se registran pagos y se ve la auditoría. Exige 2FA con una app de autenticación desde el primer ingreso.

## 3. Recorrido sugerido para una presentación

Unos 20 minutos, de lo más visible a lo más administrativo:

1. **Inicio** (pastor): resumen con anuncios, tareas de seguimiento y números de la semana.
2. **Personas**: buscar a alguien (Ctrl+K), abrir la ficha y mostrar las pestañas: datos, familia, hitos, seguimiento y formación.
3. **Células**: mapa, semáforo de reportes, genealogía y multiplicación.
4. **Mi célula** (líder, desde el celular): cargar el reporte semanal con asistencia y ofrenda. También funciona sin señal: lo manda cuando vuelve la conexión.
5. **Nuevos**: el formulario "Soy nuevo" con QR, y cómo cae en la bandeja y en el tablero de seguimiento.
6. **Calendario y ministerios**: eventos, inscripciones y turnos del equipo de alabanza.
7. **Oración y anuncios**: el muro de oración, una petición "para mi líder" y un anuncio para un ministerio.
8. **Discipulado**: los niveles, tomar asistencia de una clase y completar un nivel, que carga el hito en la ficha.
9. **Finanzas** (tesorero): un arqueo de ofrendas, el cierre de mes y un reporte.
10. **Administración** (admin): roles y permisos, con la matriz; idioma y tema (claro u oscuro); colores de la iglesia.

## 4. Mostrarla en la iglesia

### En una pantalla o proyector

Alcanza con la notebook: `http://localhost:5173`. El tema claro se ve mejor proyectado.

### Que la prueben desde sus celulares (misma red WiFi)

Probado: login, navegación y la sesión al recargar funcionan por la IP de la red. Pasos:

1. **Conocé la IP de tu PC** en el WiFi de la iglesia (por ejemplo, `192.168.0.228`):

   ```powershell
   ipconfig    # "Dirección IPv4" del adaptador Wi-Fi
   ```

2. **Permití ese origen en la API.** En el `.env` de shaddai-api, agregá la dirección a `CORS_ORIGINS`, separada por coma (sin barra al final), y reiniciá la API:

   ```
   CORS_ORIGINS=http://localhost:5173,http://192.168.0.228:5173
   ```

   Sin este paso, el login funciona pero la sesión se pierde al recargar (la API rechaza la renovación desde un origen que no conoce).

3. **Levantá la web abierta a la red** (en lugar de `npm run dev`):

   ```powershell
   npm run dev:lan      # muestra la URL "Network: http://192.168.0.228:5173/"
   ```

4. La primera vez, Windows pregunta si permite que Node.js acepte conexiones: **permitilo en redes privadas** (pide permisos de administrador). Si la red del lugar está marcada como "pública", cambiala a privada en la configuración del WiFi.

5. Desde el celular, abrí `http://192.168.0.228:5173`. Un QR con esa dirección ayuda (cualquier generador de QR sirve).

Limitaciones de este modo:

- **No se puede instalar como app**: la PWA necesita HTTPS. En el navegador se usa igual.
- **La notebook tiene que quedar prendida y en la misma red.** Si cambia la IP (otro WiFi), repetí los pasos 1 y 2.
- Es tu base local: todo lo que carguen queda en tu PC. Para que la prueben sin mezclar datos, creá una iglesia aparte desde el panel de plataforma (ver la sección 6).

## 5. Qué se ve distinto en local

- **Mails**: no salen. Con `MAIL_TRANSPORT=console`, el contenido (por ejemplo, el enlace para recuperar la contraseña) se escribe en la consola de la API.
- **Pagos**: el cobro usa un **proveedor de prueba**. En Administración → Facturación aparece "Modo prueba", con botones para simular un pago aprobado o rechazado, sin dinero real. Para probarlo, el plan necesita precio en pesos: cargalo en Plataforma → Planes.
- **Archivos** (fotos, logos, comprobantes): se guardan en la carpeta `storage/` de la API.
- **Geocodificación**: apagada. Al ubicar una célula no se busca la dirección; el punto se marca en el mapa a mano.
- **Captcha** del formulario público: apagado.

## 6. Datos: copias, limpieza e iglesias de prueba

- **Antes de una presentación**, hacé una copia de la base:

  ```powershell
  npm run db:backup                            # .bak verificado
  npm run db:restore -- -File <ruta del .bak>  # restaura en una base nueva y compara
  ```

- **Volver a cero** (borra todo, solo en desarrollo): `npm run db:reset`, que recrea la base y corre el seed. El superadmin vuelve a crearse con una contraseña temporal nueva, que se muestra una sola vez.
- **Una iglesia limpia para tu iglesia local**: desde Plataforma → Iglesias → Nueva iglesia. Se crea con sus roles, catálogos y sede, vacía. Así cargan sus datos reales sin mezclarlos con la demo.

## 7. Anotar lo que surja

Para no perder las ideas de la presentación (qué mejorar, cambiar, quitar o agregar), anotalas en una lista. Un issue por idea en GitHub (`shaddai-app/shaddai-web` o `shaddai-app/shaddai-api`) sirve para priorizarlas después y convertirlas en tramos de trabajo.
