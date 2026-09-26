import { z } from 'zod';
import { ElementDescriptorSchema, ElementDescriptor } from '../models/schemas';

// ============================================================
// Observer Types and Schemas – web-test-agent / src/observer/types.ts
// Data contracts for Page, DOM, Network, and Console observations.
// ============================================================

// ─── Console Message ──────────────────────────────────────────
export const ConsoleMessageSchema = z.object({
  type: z.enum(['log', 'info', 'warn', 'error', 'debug']),
  text: z.string(),
  timestamp: z.string().datetime(),
});
export type ConsoleMessage = z.infer<typeof ConsoleMessageSchema>;

// ─── Network Request ──────────────────────────────────────────
export const NetworkRequestSchema = z.object({
  url: z.string(),
  method: z.string(),
  status: z.number().int().optional(),
  resourceType: z.string().optional(),
  timestamp: z.string().datetime(),
});
export type NetworkRequest = z.infer<typeof NetworkRequestSchema>;

// ─── Page State ───────────────────────────────────────────────
export const PageObservationSchema = z.object({
  url: z.string(),
  title: z.string(),
  dom: z.string(),
});
export type PageObservation = z.infer<typeof PageObservationSchema>;

// ─── Complete Observation Contract ───────────────────────────
export const ObservationSchema = z.object({
  page: PageObservationSchema,
  elements: z.array(ElementDescriptorSchema),
  network: z.array(NetworkRequestSchema),
  console: z.array(ConsoleMessageSchema),
  captured_at: z.string().datetime(),
});
export type Observation = z.infer<typeof ObservationSchema>;

// ─── Observer Configuration ──────────────────────────────────
export interface ObserverConfig {
  /** Maximum length of HTML DOM string to prevent huge payloads (default: 200,000) */
  maxDomLength?: number;
  /** Maximum number of interactive elements to collect (default: 150) */
  maxElements?: number;
  /** Whether to capture full DOM HTML (default: true) */
  captureDom?: boolean;
}
