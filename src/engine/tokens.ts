// Autoregressive token semantics used throughout the simulator.
//
// - A prefill chunk appends its prompt tokens to the KV cache.
// - The final prefill chunk produces logits and emits output token 1.
// - An emitted token has no KV entry until a later decode consumes it.
// - Decode k (k = 1..G-1) consumes output token k, appends its K/V, and emits token k+1.
// - Just before completion a request holds P + G - 1 populated KV positions.
// - G = 1 completes right after prefill with no decode iterations.

export function blocksFor(tokens: number, blockSizeTokens: number): number {
  return tokens <= 0 ? 0 : Math.ceil(tokens / blockSizeTokens);
}

/** Populated KV positions immediately before a request completes. */
export function finalCachedPositions(promptTokens: number, outputTokens: number): number {
  return promptTokens + outputTokens - 1;
}

/** Blocks reserved at admission: enough to finish without further admission checks. */
export function reservationBlocks(promptTokens: number, outputTokens: number, blockSizeTokens: number): number {
  return blocksFor(finalCachedPositions(promptTokens, outputTokens), blockSizeTokens);
}

/** Number of decode iterations a request needs. */
export function decodeIterations(outputTokens: number): number {
  return Math.max(0, outputTokens - 1);
}

/** Populated KV positions from prefill progress and generated-token count. */
export function cachedPositions(prefilledTokens: number, generatedTokens: number): number {
  return prefilledTokens + Math.max(0, generatedTokens - 1);
}

/** Token slots allocated but not populated in a request's last block. */
export function internalFragmentationTokens(cachedTokens: number, allocatedBlocks: number, blockSizeTokens: number): number {
  return Math.max(0, allocatedBlocks * blockSizeTokens - cachedTokens);
}
