// Paged KV block allocator with admission-time reservations.
//
// Reservations are an accounting guarantee, not physical blocks. A request's physical
// blocks grow with its populated positions and may never exceed its reservation, so the
// sum of reservations bounds physical use and an admitted request can always finish.

export class AllocatorError extends Error {}

export class BlockAllocator {
  readonly totalBlocks: number;
  private readonly owner: Int32Array;
  private readonly freeQueue: number[];
  private freeHead = 0;
  private readonly reservations = new Map<number, number>();
  private readonly owned = new Map<number, number[]>();
  private reservedTotal = 0;
  private allocatedTotal = 0;

  constructor(totalBlocks: number) {
    if (!Number.isInteger(totalBlocks) || totalBlocks < 0) throw new AllocatorError(`Invalid block count ${totalBlocks}`);
    this.totalBlocks = totalBlocks;
    this.owner = new Int32Array(totalBlocks).fill(-1);
    this.freeQueue = Array.from({ length: totalBlocks }, (_, i) => i);
  }

  get reserved(): number { return this.reservedTotal; }
  get allocated(): number { return this.allocatedTotal; }
  /** Blocks not promised to any admitted request. */
  get unreserved(): number { return this.totalBlocks - this.reservedTotal; }
  /** Blocks with no physical owner. */
  get physicallyFree(): number { return this.totalBlocks - this.allocatedTotal; }

  reservationOf(req: number): number { return this.reservations.get(req) ?? 0; }
  blocksOf(req: number): readonly number[] { return this.owned.get(req) ?? []; }
  ownerOf(block: number): number { return this.owner[block]; }

  canReserve(blocks: number): boolean { return this.reservedTotal + blocks <= this.totalBlocks; }

  reserve(req: number, blocks: number): void {
    if (this.reservations.has(req)) throw new AllocatorError(`Request ${req} already holds a reservation`);
    if (!Number.isInteger(blocks) || blocks <= 0) throw new AllocatorError(`Invalid reservation ${blocks}`);
    if (!this.canReserve(blocks)) throw new AllocatorError(`Reservation of ${blocks} exceeds ${this.unreserved} unreserved blocks`);
    this.reservations.set(req, blocks);
    this.owned.set(req, []);
    this.reservedTotal += blocks;
  }

  /** Allocate physical blocks in FIFO free-queue order. Never exceeds the request's reservation. */
  allocate(req: number, count: number): number[] {
    const reservation = this.reservations.get(req);
    const list = this.owned.get(req);
    if (reservation === undefined || !list) throw new AllocatorError(`Request ${req} has no reservation`);
    if (count < 0 || !Number.isInteger(count)) throw new AllocatorError(`Invalid allocation ${count}`);
    if (list.length + count > reservation) throw new AllocatorError(`Request ${req} would exceed its reservation (${list.length + count} > ${reservation})`);
    if (this.freeQueue.length - this.freeHead < count) throw new AllocatorError('Physical pool exhausted');
    const fresh: number[] = [];
    for (let i = 0; i < count; i++) {
      const block = this.freeQueue[this.freeHead++];
      if (this.owner[block] !== -1) throw new AllocatorError(`Block ${block} already owned by ${this.owner[block]}`);
      this.owner[block] = req;
      fresh.push(block);
      list.push(block);
    }
    this.allocatedTotal += count;
    this.compact();
    return fresh;
  }

  /** Release a request's physical blocks and reservation exactly once. */
  release(req: number): { blocks: number; reservedBlocks: number } {
    const reservation = this.reservations.get(req);
    const list = this.owned.get(req);
    if (reservation === undefined || !list) throw new AllocatorError(`Double release or unknown request ${req}`);
    for (const block of list) {
      if (this.owner[block] !== req) throw new AllocatorError(`Block ${block} is not owned by ${req}`);
      this.owner[block] = -1;
      this.freeQueue.push(block);
    }
    this.allocatedTotal -= list.length;
    this.reservedTotal -= reservation;
    this.reservations.delete(req);
    this.owned.delete(req);
    return { blocks: list.length, reservedBlocks: reservation };
  }

  /** Throws if any accounting invariant is broken. Used by tests and debug assertions. */
  checkInvariants(): void {
    let owned = 0;
    let reserved = 0;
    const seen = new Set<number>();
    for (const [req, list] of this.owned) {
      const reservation = this.reservations.get(req) ?? 0;
      if (list.length > reservation) throw new AllocatorError(`Request ${req} occupies more than it reserved`);
      reserved += reservation;
      for (const block of list) {
        if (seen.has(block)) throw new AllocatorError(`Block ${block} has two owners`);
        if (this.owner[block] !== req) throw new AllocatorError(`Owner map disagrees for block ${block}`);
        seen.add(block);
      }
      owned += list.length;
    }
    if (owned !== this.allocatedTotal) throw new AllocatorError('Allocated count drifted');
    if (reserved !== this.reservedTotal) throw new AllocatorError('Reserved count drifted');
    if (this.reservedTotal > this.totalBlocks || this.allocatedTotal > this.reservedTotal) throw new AllocatorError('Capacity exceeded');
    if (this.allocatedTotal < 0 || this.reservedTotal < 0) throw new AllocatorError('Negative capacity');
    if (this.freeQueue.length - this.freeHead + this.allocatedTotal !== this.totalBlocks) throw new AllocatorError('Free queue size drifted');
  }

  private compact(): void {
    if (this.freeHead > 4096 && this.freeHead * 2 > this.freeQueue.length) {
      this.freeQueue.splice(0, this.freeHead);
      this.freeHead = 0;
    }
  }
}
