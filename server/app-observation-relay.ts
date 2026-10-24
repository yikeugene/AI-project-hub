import { z } from 'zod';
import {
  APP_OBSERVATION_MAX_BYTES, appObservationCapabilitySchema, appObservationPublicationSchema,
  remoteAppObservationSchema, type AppObservationCapability, type AppObservationRelay,
} from '../shared/app-observation.js';
import { tokenSchema } from '../shared/devices.js';
import { RelayError } from './relay.js';

/** An internal binding to the existing bounded native-fetch transport, not a public RPC proxy. */
export interface AppObservationRpcOptions<T> {
  maxResponseBytes: number;
  /** Used only for hub_app_v1_capability and only for recognized missing-function errors. */
  absentCapability?: () => T;
}
export type AppObservationRpc = <T>(
  name: 'hub_app_v1_capability' | 'hub_app_v1_publish' | 'hub_app_v1_statuses',
  body: Record<string, unknown>, schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  signal?: AbortSignal, options?: AppObservationRpcOptions<T>,
) => Promise<T>;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RelayError('invalid', '雲端設定或請求格式無效。');
  return result.data;
}
const publicationSchema = appObservationPublicationSchema.refine(value => Buffer.byteLength(JSON.stringify(value), 'utf8') <= APP_OBSERVATION_MAX_BYTES);
const statusesSchema = z.array(remoteAppObservationSchema.refine(value => publicationSchema.safeParse({
  protocol: value.protocol, sequence: value.sequence, observation: value.observation,
}).success)).max(100).refine(values => new Set(values.map(value => value.deviceId)).size === values.length);
const authenticated = (token: string) => ({ p_token: parse(tokenSchema, token) });
const empty = z.null().transform(() => undefined);

export function createAppObservationRelay(rpc: AppObservationRpc): AppObservationRelay {
  return {
    capability(token, signal) {
      // A successful JSON null is malformed, not an unsupported backend.
      return rpc<AppObservationCapability | null>('hub_app_v1_capability', authenticated(token), appObservationCapabilitySchema, signal,
        { maxResponseBytes: 1024, absentCapability: () => null });
    },
    publish(token, publication, signal) {
      const value = parse(publicationSchema, publication);
      return rpc('hub_app_v1_publish', { ...authenticated(token), p_payload: JSON.stringify(value) }, empty, signal, { maxResponseBytes: 1024 });
    },
    statuses(token, signal) {
      return rpc('hub_app_v1_statuses', authenticated(token), statusesSchema, signal, { maxResponseBytes: 150 * 1024 });
    },
  };
}
