# Arquitectura y decisiones

## Modelo
- Un proceso Node.js administra N objetos `TenantInstance`.
- Cada `TenantInstance` crea un `BotCore` y un socket Baileys independiente.
- `TenantManager` controla creación, arranque, parada y estado.
- Cada tenant tiene directorio de sesión propio: `DATA_DIR/sessions/<tenantId>`.
- La base de datos guarda configuración e historial con `tenant_id`.

## No confundir
Un único motor de código no significa un único socket. Cada cuenta conectada requiere su propia sesión/socket. El límite práctico debe obtenerse mediante benchmark.

## Orden de ejecución
1. Validar tenant.
2. Enrutar el mensaje al contexto de ese tenant.
3. Guardar historial mínimo.
4. Evaluar plugins y reglas.
5. Encolar tareas costosas (IA/media) en workers separados.
6. Registrar métricas.

## Antes de producción
- Implementar autenticación real por usuario y roles.
- Cifrar secretos y credenciales en reposo.
- Sustituir cola en memoria para trabajos críticos por cola persistente.
- Añadir rate limiting y cuotas por tenant.
- Configurar TLS, proxy, firewall y backups.
- Prueba de recuperación de sesiones y de restauración de backup.
- Definir retención de mensajes y consentimiento.
