import {
  type AdaptiveConcurrencyConfig,
  createFusion,
  createRouter,
  MemoryRouterHealthStore,
  RouterConcurrencyError,
  type RouterRetryBudgetSnapshot,
  RouterTimeoutError,
} from "@minpeter/ai-router";
import { createFriendli } from "@minpeter/ai-router/friendli";
import { createFusion as createFusionSubpath } from "@minpeter/ai-router/fusion";
import { createOpenGateway } from "@minpeter/ai-router/opengateway";
import { createOpenRouter } from "@minpeter/ai-router/openrouter";
import { createWafer } from "@minpeter/ai-router/wafer";

const adaptive = { max: 4, min: 1 } satisfies AdaptiveConcurrencyConfig;
const router = createRouter({
  fallback: { retryBudget: true },
  models: { chat: [] },
});
const snapshots: RouterRetryBudgetSnapshot[] = router.getRetryBudgetSnapshot();

export const packageApiSmoke = [
  adaptive,
  snapshots,
  new MemoryRouterHealthStore(10),
  RouterConcurrencyError,
  RouterTimeoutError,
  createFriendli,
  createFusion,
  createFusionSubpath,
  createOpenGateway,
  createOpenRouter,
  createWafer,
];
