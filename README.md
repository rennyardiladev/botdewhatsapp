# WhatsApp SaaS multi-tenant — starter

Base de proyecto TypeScript para administrar varias sesiones de WhatsApp mediante Baileys desde un mismo código. Incluye gestor de tenants, sesiones aisladas, plugins, API HTTP autenticada por token, almacenamiento SQLite de configuración e historial básico y métricas del proceso.

> **Estado:** starter de desarrollo. No es una plataforma lista para producción ni garantiza 100 sesiones en un VPS de 2 vCPU / 4 GB. La capacidad depende del tráfico, versión de Baileys, red y uso de multimedia. Prueba primero con cuentas autorizadas y aumenta la carga gradualmente.

## Requisitos

- Node.js 20.11 o superior
- npm
- Un número de WhatsApp de prueba que controles

## Instalar

```bash
cp .env.example .env
npm install
npm run dev
```

Antes de usar la API, edita `.env` y establece `API_TOKEN` con un secreto aleatorio largo. Por defecto, la API escucha en `127.0.0.1`, no en toda la red.

## API

Todas las rutas `/api` requieren `Authorization: Bearer <API_TOKEN>`.

Crear un tenant:

```bash
curl -X POST http://127.0.0.1:3000/api/tenants \
  -H "Authorization: Bearer TU_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id":"tienda-001","name":"Tienda de prueba","config":{"ignoreGroups":true,"autoRejectCalls":true}}'
```

Listar tenants:

```bash
curl http://127.0.0.1:3000/api/tenants -H "Authorization: Bearer TU_TOKEN"
```

Conectar una sesión (muestra el QR en el terminal):

```bash
curl -X POST http://127.0.0.1:3000/api/tenants/tienda-001/start \
  -H "Authorization: Bearer TU_TOKEN"
```

Estado y QR textual:

```bash
curl http://127.0.0.1:3000/api/tenants/tienda-001/status -H "Authorization: Bearer TU_TOKEN"
```

El endpoint de QR devuelve el texto del QR, no una imagen. Para escanearlo, en esta primera versión usa el QR que aparece en la terminal del servidor.

Detener:

```bash
curl -X POST http://127.0.0.1:3000/api/tenants/tienda-001/stop \
  -H "Authorization: Bearer TU_TOKEN"
```

Eliminar un tenant (detiene la instancia y elimina su configuración; **no elimina automáticamente** los archivos de sesión):

```bash
curl -X DELETE http://127.0.0.1:3000/api/tenants/tienda-001 \
  -H "Authorization: Bearer TU_TOKEN"
```

## Respuestas automáticas

Por defecto, cada tenant recibe reglas iniciales. Edita `src/app.ts` para registrar otros plugins o modifica la configuración del plugin. Ejemplo de mensaje:

- `hola` → respuesta de bienvenida
- `precio` → respuesta sobre precios
- `!ayuda` → menú de comandos

Los plugins devuelven `true` si atendieron el mensaje y `false` para permitir que otros plugins lo procesen.

## Arquitectura

- `BotCore`: conexión Baileys para **una sesión** y registro de handlers.
- `BotInstance`: contenedor de un BotCore, configuración y ciclo de vida.
- `TenantManager`: administra muchas instancias dentro del proceso.
- `FlowManager`: reglas por tenant, sin código ejecutable suministrado por clientes.
- `TenantQueue`: cola limitada por tenant con concurrencia configurable.
- `Database`: SQLite para tenants e historial.
- `http.ts`: API administrativa autenticada por token.
- `plugins/`: funcionalidades enchufables.

## Límites y seguridad

- Esta versión usa una cola en memoria; los trabajos pendientes se pierden al reiniciar.
- La autenticación de la API es un único token administrativo, no un sistema multiusuario con roles. No la expongas públicamente sin implementar usuarios, permisos, TLS, rate limits y auditoría.
- Las credenciales de Baileys quedan en `data/sessions/<tenantId>`. Protege el disco, copias de seguridad y permisos del usuario del sistema. No sirvas esa carpeta por HTTP.
- El historial básico guarda texto entrante y saliente en SQLite. Añade políticas de retención, consentimiento y controles de acceso antes de usarlo con datos reales.
- No almacenes contenido multimedia por defecto.
- No hay proveedor de IA conectado aún: se deja como extensión para no añadir coste ni dependencia de proveedor.
- No ejecutes código arbitrario enviado por tenants dentro de plugins.
- Respeta las condiciones de WhatsApp y evita spam o mensajes no solicitados.

## Pruebas de carga

`npm run loadtest` prueba la cola aislada del socket, con trabajos sintéticos. **No simula 100 conexiones Baileys**. Primero mide el coste de la lógica de colas; después debes hacer una prueba de integración gradual con sesiones reales autorizadas.

Recomendación de escalado: 1 → 5 → 10 → 25 → 50 → 100 sesiones, registrando RSS, heap, CPU, event-loop lag, latencia p95/p99, desconexiones y profundidad de cola. No avances si la memoria crece sin estabilizarse.

## Producción

Antes de venderlo como SaaS:
1. Sustituir el token único por usuarios, sesiones seguras y roles.
2. Añadir cifrado de credenciales en reposo y copias de seguridad probadas.
3. Persistir trabajos críticos (Redis/cola durable) y añadir idempotencia.
4. Añadir límites de tasa, cuotas por tenant y circuit breakers.
5. Separar workers de multimedia/IA del proceso de sockets.
6. Añadir monitorización externa, alertas y apagado/reinicio controlado.
7. Validar límites y políticas actuales de Baileys/WhatsApp.

## Nota sobre reconexión

Cada `BotCore` administra su propio socket. No se llama a `start()` recursivamente al reconectar: se crea una única instancia de socket por ciclo y la instancia gestiona reintentos con backoff. En despliegues reales, usa un supervisor (systemd/Docker) y evita ejecutar dos réplicas que escriban en la misma carpeta de sesión.
