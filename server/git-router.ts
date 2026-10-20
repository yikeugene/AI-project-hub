import { Router } from 'express';
import { z } from 'zod';
import { gitDiffInputSchema, gitDigestSchema, gitOperationSchema } from '../shared/git.js';
import { deviceRoleSchema, statusSharingPolicySchema } from '../shared/governance.js';
import type { GitApprovalService } from './git-approvals.js';
import type { GovernanceService } from './governance.js';

const uuid = z.string().uuid();
const confirmed = z.object({ confirm: z.literal(true) }).strict();
const digestConfirmation = confirmed.extend({ digest: gitDigestSchema });
export function gitRouter(git: GitApprovalService, governance: GovernanceService) {
  const router = Router();
  router.get('/governance', (_req, res) => res.json(governance.state()));
  router.post('/governance/refresh', async (req, res) => { confirmed.parse(req.body); res.json(await governance.refresh()); });
  router.patch('/governance/roles/:id', async (req, res) => {
    const input = confirmed.extend({ role: deviceRoleSchema }).parse(req.body);
    res.json(await governance.setRole(uuid.parse(req.params.id), input.role));
  });
  router.post('/governance/sharing/preview', (req, res) => {
    const { policy } = z.object({ policy: statusSharingPolicySchema }).strict().parse(req.body);
    res.json(governance.previewSharing(policy));
  });
  router.post('/governance/sharing', (req, res) => {
    const input = digestConfirmation.extend({ policy: statusSharingPolicySchema }).parse(req.body);
    res.json(governance.saveSharing(input.policy, input.digest));
  });
  router.get('/projects/:id/git/details', async (req, res) => res.json(await git.details(uuid.parse(req.params.id))));
  router.post('/projects/:id/git/diff', async (req, res) => res.json(await git.diff(uuid.parse(req.params.id), gitDiffInputSchema.parse(req.body))));
  router.post('/projects/:id/git/preview', async (req, res) => {
    const { operation } = z.object({ operation: gitOperationSchema }).strict().parse(req.body);
    res.json(await git.preview(uuid.parse(req.params.id), operation));
  });
  router.get('/projects/:id/git/requests', (req, res) => res.json(git.list(uuid.parse(req.params.id))));
  router.post('/git/requests', async (req, res) => {
    const input = digestConfirmation.extend({ previewId: uuid, reviewerDeviceId: uuid }).parse(req.body);
    res.json(await git.submit(input.previewId, input.reviewerDeviceId, input.digest));
  });
  router.post('/git/requests/:id/execute', async (req, res) => {
    const input = digestConfirmation.parse(req.body);
    res.json(await git.execute(uuid.parse(req.params.id), input.digest));
  });
  router.post('/git/requests/:id/cancel', async (req, res) => {
    const input = digestConfirmation.parse(req.body);
    res.json(await git.cancel(uuid.parse(req.params.id), input.digest));
  });
  router.get('/git/requests/:id/audit', (req, res) => res.json(git.audit(uuid.parse(req.params.id))));
  router.post('/git/requests/:id/acknowledge', async (req, res) => {
    confirmed.parse(req.body); res.json(await git.acknowledge(uuid.parse(req.params.id)));
  });
  router.get('/git/approvals', (_req, res) => res.json(git.approvals()));
  router.post('/git/approvals/:id/decision', async (req, res) => {
    const input = digestConfirmation.extend({ decision: z.enum(['approved', 'rejected']), reason: z.string().max(1000) }).parse(req.body);
    res.json(await git.decide(uuid.parse(req.params.id), input.digest, input.decision, input.reason));
  });
  return router;
}
