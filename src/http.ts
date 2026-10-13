import express, {
  type Request,
  type Response,
  type NextFunction
} from 'express';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TenantManager } from './core/TenantManager.js';
import type { Database } from './database/Database.js';
import { TenantQueue } from './core/TenantQueue.js';

export function createHttpApp(options: {
  tenantManager: TenantManager;
  db: Database;
  apiToken: string;
  queue: TenantQueue;
}) {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  // Carpeta public relativa a este archivo compilado.
  // Compatible con proyectos TypeScript que compilan a dist.
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);

  // Si este archivo se compila a dist/http/app.js y public
  // está en la raíz del proyecto, ajusta esta ruta a tu estructura.
  app.use(express.static(path.resolve(process.cwd(), 'public')));

  // Comprobar que el servidor está vivo.
  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      uptimeSeconds: process.uptime()
    });
  });

  // Autenticación para todas las rutas /api.
  app.use(
    '/api',
    (req: Request, res: Response, next: NextFunction) => {
      const auth = req.header('authorization') ?? '';
      const token = auth.startsWith('Bearer ')
        ? auth.slice(7)
        : '';

      if (
        !options.apiToken ||
        options.apiToken === 'replace-with-a-long-random-secret'
      ) {
        res.status(503).json({
          error: 'Configura API_TOKEN en .env antes de usar la API'
        });
        return;
      }

      const provided = Buffer.from(token);
      const expected = Buffer.from(options.apiToken);

      if (
        provided.length !== expected.length ||
        !provided.equals(expected)
      ) {
        res.status(401).json({ error: 'No autorizado' });
        return;
      }

      next();
    }
  );

  // Listar instancias.
  app.get('/api/tenants', (_req, res) => {
    res.json({
      tenants: options.tenantManager.listTenants()
    });
  });

  // Crear una instancia.
  app.post('/api/tenants', (req, res) => {
    const body = req.body as {
      id?: unknown;
      name?: unknown;
      config?: unknown;
    };

    if (
      typeof body.id !== 'string' ||
      typeof body.name !== 'string' ||
      !body.id.trim() ||
      !body.name.trim()
    ) {
      res.status(400).json({
        error: 'Se requieren id y name como texto no vacío'
      });
      return;
    }

    try {
      const config =
        body.config &&
        typeof body.config === 'object' &&
        !Array.isArray(body.config)
          ? body.config as never
          : {};

      const tenant = options.tenantManager.createTenant({
        id: body.id.trim(),
        name: body.name.trim(),
        config
      });

      res.status(201).json({ tenant });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error
          ? error.message
          : 'Error creando tenant'
      });
    }
  });

   // Consultar el estado de una instancia.
  app.get('/api/tenants/:id/status', (req, res) => {
    const status = options.tenantManager.getStatus(req.params.id);

    if (!status) {
      res.status(404).json({
        error: 'Tenant no encontrado'
      });
      return;
    }

    res.json(status);
  });

  // Listar flujos de una instancia.
  app.get('/api/tenants/:id/flows', (req, res) => {
    const flows = options.tenantManager.listFlows(req.params.id);
    if (!flows) {
      res.status(404).json({ error: 'Tenant no encontrado' });
      return;
    }
    res.json({ flows });
  });

  // Crear un flujo.
  app.post('/api/tenants/:id/flows', (req, res) => {
    const body = req.body as { trigger?: unknown; response?: unknown; exact?: unknown; enabled?: unknown };
    if (typeof body.trigger !== 'string' || !body.trigger.trim() ||
        typeof body.response !== 'string' || !body.response.trim()) {
      res.status(400).json({ error: 'trigger y response son obligatorios' });
      return;
    }
    try {
      const flow = options.tenantManager.createFlow(req.params.id, {
        trigger: body.trigger.trim(),
        response: body.response.trim(),
        exact: body.exact === true,
        enabled: body.enabled !== false
      });
      res.status(201).json({ flow });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : 'Error creando flujo'
      });
    }
  });

  // Actualizar un flujo.
  app.patch('/api/tenants/:id/flows/:flowId', (req, res) => {
    const body = req.body as { trigger?: unknown; response?: unknown; exact?: unknown; enabled?: unknown };
    const flowId = Number(req.params.flowId);
    if (!Number.isInteger(flowId) || flowId <= 0) {
      res.status(400).json({ error: 'ID de flujo inválido' });
      return;
    }
    try {
      const ok = options.tenantManager.updateFlow(req.params.id, flowId, {
        trigger: typeof body.trigger === 'string' ? body.trigger.trim() : undefined,
        response: typeof body.response === 'string' ? body.response.trim() : undefined,
        exact: body.exact === true || body.exact === false ? body.exact : undefined,
        enabled: body.enabled === true || body.enabled === false ? body.enabled : undefined
      });
      if (!ok) {
        res.status(404).json({ error: 'Flujo no encontrado' });
        return;
      }
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : 'Error actualizando flujo'
      });
    }
  });

  // Eliminar un flujo.
  app.delete('/api/tenants/:id/flows/:flowId', (req, res) => {
    const flowId = Number(req.params.flowId);
    if (!Number.isInteger(flowId) || flowId <= 0) {
      res.status(400).json({ error: 'ID de flujo inválido' });
      return;
    }
    try {
      const ok = options.tenantManager.deleteFlow(req.params.id, flowId);
      if (!ok) {
        res.status(404).json({ error: 'Flujo no encontrado' });
        return;
      }
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : 'Error eliminando flujo'
      });
    }
  });

  // Iniciar una instancia.
  app.post('/api/tenants/:id/start', async (req, res, next) => {
    try {
      await options.tenantManager.startTenant(req.params.id);

      res.json({
        ok: true,
        status: options.tenantManager.getStatus(req.params.id)
      });
    } catch (error) {
      if (error instanceof Error) {
        res.status(400).json({ error: error.message });
      } else {
        next(error);
      }
    }
  });

  // Detener una instancia.
  app.post('/api/tenants/:id/stop', async (req, res, next) => {
    try {
      await options.tenantManager.stopTenant(req.params.id);

      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  // Eliminar una instancia.
  app.delete('/api/tenants/:id', async (req, res, next) => {
    try {
      const deleted = await options.tenantManager.deleteTenant(
        req.params.id
      );

      if (!deleted) {
        res.status(404).json({
          error: 'Tenant no encontrado'
        });
        return;
      }

      res.json({
        ok: true,
        note: 'Los archivos de sesión se conservan por seguridad.'
      });
    } catch (error) {
      next(error);
    }
  });

  // Consultar mensajes recientes.
  app.get('/api/tenants/:id/messages', (req, res, next) => {
    try {
      if (!options.tenantManager.getTenant(req.params.id)) {
        res.status(404).json({
          error: 'Tenant no encontrado'
        });
        return;
      }

      const requestedLimit = Number(req.query.limit ?? 50);

      if (
        !Number.isInteger(requestedLimit) ||
        requestedLimit < 1
      ) {
        res.status(400).json({
          error: 'limit debe ser un entero positivo'
        });
        return;
      }

      const limit = Math.min(requestedLimit, 200);

      res.json({
        messages: options.db.getRecentMessages(
          req.params.id,
          limit
        )
      });
    } catch (error) {
      next(error);
    }
  });

  // Métricas del servidor.
  app.get('/api/metrics', (_req, res) => {
    const memory = process.memoryUsage();
    const tenants = options.tenantManager.listTenants();

    res.json({
      uptimeSeconds: process.uptime(),
      tenantCount: tenants.length,
      connected: tenants.filter(
        (tenant) => tenant.status === 'open'
      ).length,
      memory: {
        rssMB: Math.round(memory.rss / 1024 / 1024),
        heapUsedMB: Math.round(memory.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(memory.heapTotal / 1024 / 1024)
      },
      queue: options.queue.metrics()
    });
  });

  // Manejador de errores.
  app.use((
    error: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    console.error('HTTP error:', error);

    if (res.headersSent) {
      return;
    }

    res.status(500).json({
      error: 'Error interno'
    });
  });

  return app;
}
