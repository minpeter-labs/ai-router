export { createRouter } from './core/router';
export { detectModalities } from './core/modality';
export {
  defaultShouldRetryThisError,
  normalizeError,
  surfaceFailure,
} from './core/retry';
export type {
  Modality,
  ProviderEntry,
  ProviderEntryFactory,
  ProviderEntryInstance,
  ProviderFactory,
  CreateRouterOptions,
  OnRouterError,
  ShouldRetryThisError,
  CooldownConfig,
} from './core/types';
