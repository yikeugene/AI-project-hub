import { Router, type Request } from 'express';
import { z } from 'zod';
import { gitDiffInputSchema, gitDigestSchema, gitOperationSchema } from '../shared/git.js';
import { deviceRoleSchema, statusSharingPolicySchema } from '../shared/governance.js';
import { PROFILE_HEADER } from '../shared/devices.js';
import type { GitApprovalService } from './git-approvals.js';
import type { GovernanceService } from './governance.js';

const uuid = z.string().uuid();
const confirmed = z.object({ confirm: z.literal(true) }).strict();
const digestConfirmation = confirmed.extend({ digest: gitDigestSchema });
const requiredProfile = (req: Request) => uuid.parse(req.get(PROFILE_HEADER));
// No header is an explicit local-only read, never the mutable management selection.
const optionalProfile = (req: Request) => req.get(PROFILE_HEADER) === undefined ? null : requiredProfile(req);
export function gitRouter(git: GitApprovalService, governance: GovernanceService) {
  const router = Router();
  router.get('/governance', (req, res) => res.json(governance.state(optionalProfile(req))));
  router.post('/governance/refresh', async (req, res) => { confirmed.parse(req.body); res.json(await governance.refresh(requiredProfile(req))); });
  router.patch('/governance/roles/:id', async (req, res) => {
    const input = confirmed.extend({ role: deviceRoleSchema }).parse(req.body);
    res.json(await governance.setRole(requiredProfile(req), uuid.parse(req.params.id), input.role));
  });
  router.post('/governance/sharing/preview', (req, res) => {
    const { policy } = z.object({ policy: statusSharingPolicySchema }).strict().parse(req.body);
    res.json(governance.previewSharing(requiredProfile(req), policy));
  });
  router.post('/governance/sharing', (req, res) => {
    const input = digestConfirmation.extend({ policy: statusSharingPolicySchema }).parse(req.body);
    res.json(governance.saveSharing(requiredProfile(req), input.policy, input.digest));
  });
  // Local repository inspection does not need a network membership or a profile header.
  router.get('/projects/:id/git/details', async (req, res) => res.json(await git.details(uuid.parse(req.params.id))));
  router.post('/projects/:id/git/diff', async (req, res) => res.json(await git.diff(uuid.parse(req.params.id), gitDiffInputSchema.parse(req.body))));
  router.post('/projects/:id/git/preview', async (req, res) => {
    const { operation } = z.object({ operation: gitOperationSchema }).strict().parse(req.body);
    res.json(await git.preview(requiredProfile(req), uuid.parse(req.params.id), operation));
  });
  router.get('/projects/:id/git/requests', (req, res) => res.json(git.list(optionalProfile(req), uuid.parse(req.params.id))));
  router.post('/git/requests', async (req, res) => {
    const input = digestConfirmation.extend({ previewId: uuid, reviewerDeviceId: uuid }).parse(req.body);
    res.json(await git.submit(requiredProfile(req), input.previewId, input.reviewerDeviceId, input.digest));
  });
  router.post('/git/requests/:id/execute', async (req, res) => {
    const input = digestConfirmation.parse(req.body);
    res.json(await git.execute(requiredProfile(req), uuid.parse(req.params.id), input.digest));
  });
  router.post('/git/requests/:id/cancel', async (req, res) => {
    const input = digestConfirmation.parse(req.body);
    res.json(await git.cancel(requiredProfile(req), uuid.parse(req.params.id), input.digest));
  });
  // Unknown/partial execution journals remain recoverable even after leaving their group.
  // The service requires a matching live profile for every other audit record.
  router.get('/git/requests/:id/audit', (req, res) => res.json(git.audit(optionalProfile(req), uuid.parse(req.params.id))));
  router.post('/git/requests/:id/acknowledge', async (req, res) => {
    confirmed.parse(req.body); res.json(await git.acknowledge(optionalProfile(req), uuid.parse(req.params.id)));
  });
  router.get('/git/approvals', (req, res) => res.json(git.approvals(optionalProfile(req))));
  router.post('/git/approvals/:id/decision', async (req, res) => {
    const input = digestConfirmation.extend({ decision: z.enum(['approved', 'rejected']), reason: z.string().max(1000) }).parse(req.body);
    res.json(await git.decide(requiredProfile(req), uuid.parse(req.params.id), input.digest, input.decision, input.reason));
  });
  return router;
}
