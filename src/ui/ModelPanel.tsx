import { memoryModel } from '../engine/memory';
import type { SimConfig } from '../engine/types';
import { t } from '../i18n';
import { formatBytes, formatInt } from './format';

const REFERENCES = [
  { href: 'https://arxiv.org/abs/2309.06180', label: 'Kwon et al., Efficient Memory Management for LLM Serving with PagedAttention (2023)' },
  { href: 'https://docs.vllm.ai/en/stable/configuration/optimization/', label: 'vLLM docs: Optimization and tuning (chunked prefill, preemption)' },
  { href: 'https://docs.vllm.ai/en/stable/usage/metrics/', label: 'vLLM docs: Production metrics (TTFT, TPOT/ITL, E2E, queue time)' },
  { href: 'https://docs.vllm.ai/en/stable/features/automatic_prefix_caching/', label: 'vLLM docs: Automatic prefix caching (out of scope here)' },
];

export function ModelPanel({ config }: { config: SimConfig }) {
  const { architecture: a, precision: p, memory: m, cost: c } = config;
  const mem = memoryModel(a, p, m);
  return (
    <details className="card model-panel" id="model">
      <summary>
        <span>
          <strong>{t.model.title}</strong>
          <span className="caption"> · {t.model.caption}</span>
        </span>
      </summary>
      <div className="model-grid">
        <article>
          <h3>Token conventions</h3>
          <ul>
            <li>A prefill chunk appends its prompt tokens to the KV cache. Only the final chunk produces logits and emits output token 1.</li>
            <li>An emitted token has no KV entry until the next decode consumes it. Decode <i>k</i> appends one position and emits token <i>k</i> + 1.</li>
            <li>Before completion a request holds <code>P + G − 1</code> populated positions. With <code>G = 1</code> it finishes after prefill with no decode.</li>
            <li>Every request produces exactly <code>G</code> tokens (no stochastic EOS). <code>P + G ≤ max context</code> is required as a conservative input rule.</li>
          </ul>
        </article>
        <article>
          <h3>Memory</h3>
          <p className="formula">kvBytesPerToken = 2 × layers × kvHeads × headDim × kvElementBytes<br />= 2 × {a.numLayers} × {a.numKVHeads} × {a.headDim} × {p.kvElementBytes} = <b>{formatBytes(mem.kvBytesPerToken)}</b></p>
          <p className="formula">weights = params × bits / 8 × (1 + metadata%) = <b>{formatBytes(mem.weightBytes)}</b></p>
          <p className="formula">KV pool = device − weights − runtime = {formatBytes(mem.kvPoolBytes)} → <b>{formatInt(mem.totalBlocks)}</b> blocks of {formatBytes(mem.kvBlockBytes)}</p>
          <p>The factor 2 stores keys and values; KV heads (not query heads) set the size. Weight precision does not change KV precision or speed. Bytes are binary (1 GiB = 2<sup>30</sup> B).</p>
        </article>
        <article>
          <h3>Allocator and admission</h3>
          <ul>
            <li>Blocks are allocated per request: <code>allocated = ceil(cached / blockSize)</code>, so each request rounds up separately. Unused slots in last blocks are internal fragmentation.</li>
            <li>FIFO admission reserves <code>ceil((P + G − 1) / blockSize)</code> blocks. A reservation is an accounting guarantee, not physical memory: occupied blocks never exceed it, so admitted requests always finish.</li>
            <li>The queue head waits when the sequence limit is reached or its reservation does not fit. Requests behind it wait too (head-of-line blocking). A head that cannot fit an empty pool is marked infeasible and removed.</li>
            <li>This is this simulator’s policy, not vLLM’s admission algorithm, which admits optimistically and can preempt.</li>
          </ul>
        </article>
        <article>
          <h3>Scheduling policies</h3>
          <ul>
            <li><b>Whole-prefill baseline:</b> admitted prompts go first in FIFO order, each in full. The first prompt that does not fit the remaining budget waits with everything behind it; decodes use what is left. Every prompt must fit the token budget, or the panel reports an incompatible configuration.</li>
            <li><b>Decode-first chunked prefill:</b> decodes go first, then FIFO prompt chunks of at most the max chunk size, continuing from each prompt’s cached prefix.</li>
            <li>Decodes are ordered round-robin by admission order, starting after the last request served. A request runs at most once per iteration, so it cannot finish prefill and decode in the same iteration.</li>
            <li>Arrivals during an iteration wait for the next boundary. These are simplified educational policies, not a replay of a vLLM version; finite traces complete, but there is no starvation guarantee under unbounded load.</li>
          </ul>
        </article>
        <article>
          <h3>Execution cost (modeled ms)</h3>
          <p className="formula">duration = overhead + linear × tokens + prefillAttn × Σ(q·c + q(q+1)/2) / 10⁶ + decodeAttn × Σ(c + 1) / 10³</p>
          <ul>
            <li><b>overhead</b> = {c.iterationOverheadMs} ms per nonempty iteration (scheduling, launches, streaming weights once).</li>
            <li><b>linear</b> = {c.linearMsPerToken} ms per new token, prefill or decode (projections and MLP).</li>
            <li><b>prefillAttn</b> = {c.prefillAttentionMsPerMillionPairs} ms per million causal query-key pairs; a chunk of <i>q</i> tokens after <i>c</i> cached positions has q·c + q(q+1)/2 pairs.</li>
            <li><b>decodeAttn</b> = {c.decodeAttentionMsPerThousandPositions} ms per thousand attended positions; a decode after <i>c</i> positions reads c + 1.</li>
            <li>Mixed batches sum their parts; no compute/memory overlap is modeled. Outputs appear at iteration end. Coefficients are illustrative, not measurements, and busy time is not GPU utilization or MFU.</li>
          </ul>
        </article>
        <article>
          <h3>Metrics</h3>
          <ul>
            <li>Queue delay: arrival → first execution. TTFT: arrival → first token. E2E: arrival → last token. ITL: gaps between consecutive tokens. TPOT: (last − first) / (G − 1), N/A when G = 1.</li>
            <li>Percentiles use nearest rank: the smallest sample with at least p% of samples at or below it. Empty samples show N/A.</li>
            <li>Throughput window: first arrival to the cursor or the end of the run. SLO attainment counts unfinished and infeasible requests as not met.</li>
          </ul>
        </article>
        <article>
          <h3>Out of scope</h3>
          <p>MLA, sliding-window attention, recurrent and hybrid models, tensor/pipeline parallelism, disaggregated prefill/decode, prefix caching and sharing, speculative decoding, offloading, preemption and recomputation, autoscaling, and benchmark import. The model has one logical GPU.</p>
        </article>
        <article>
          <h3>References</h3>
          <ul className="refs">
            {REFERENCES.map(r => <li key={r.href}><a href={r.href} target="_blank" rel="noreferrer noopener">{r.label}</a></li>)}
          </ul>
          <p className="small muted">References ground the mechanisms. The simplifications above belong to this simulator, not to a production engine.</p>
        </article>
      </div>
    </details>
  );
}
