// Compatibility bridge for v0.1 callers. Knowledge is the only writable store.
export {
  applyFeedback,
  finalizeRun,
  mergeCandidate,
  rebuildKnowledge as rebuildBrain,
  searchKnowledge as searchBrain,
} from "./knowledge.mjs";
