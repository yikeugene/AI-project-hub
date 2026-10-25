import { Router } from 'express';
import { z } from 'zod';
import type { Store } from './db.js';
import { WorkItems } from './work-items.js';
import { createWorkItemSchema, workCommandSchema } from '../shared/work-items.js';

export function workItemsRouter(store: Store) {
  const router = Router(), items = new WorkItems(store), uuid = z.string().uuid();
  router.get('/work-items', (req, res) => {
    const query = z.object({ projectId: uuid.optional() }).strict().parse(req.query);
    res.json({ items: items.list(query.projectId) });
  });
  router.post('/projects/:id/work-items', (req, res) => {
    res.json(items.createDraft(uuid.parse(req.params.id), createWorkItemSchema.parse(req.body)));
  });
  router.get('/work-items/:id', (req, res) => { res.json(items.detail(uuid.parse(req.params.id))); });
  router.get('/work-items/:id/brief', (req, res) => { res.json(items.preview(uuid.parse(req.params.id))); });
  router.post('/work-items/:id/actions', (req, res) => {
    res.json(items.apply(uuid.parse(req.params.id), workCommandSchema.parse(req.body)));
  });
  return router;
}
