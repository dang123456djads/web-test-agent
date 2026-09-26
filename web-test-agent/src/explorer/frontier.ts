import { StateNode } from './types';

// ============================================================
// Frontier Queue – web-test-agent / src/explorer/frontier.ts
// Standard FIFO Queue ensuring strict Breadth-First Search.
// ============================================================

export class FrontierQueue {
  private queue: StateNode[] = [];

  /**
   * Enqueue a StateNode at the end of the FIFO queue.
   */
  enqueue(node: StateNode): void {
    this.queue.push(node);
  }

  /**
   * Dequeue the oldest StateNode from the front of the queue.
   */
  dequeue(): StateNode | undefined {
    return this.queue.shift();
  }

  /**
   * Inspect the head of the queue without removing it.
   */
  peek(): StateNode | undefined {
    return this.queue[0];
  }

  /**
   * Whether the queue is currently empty.
   */
  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /**
   * Total number of nodes waiting in the queue.
   */
  size(): number {
    return this.queue.length;
  }

  /**
   * Reset the queue.
   */
  clear(): void {
    this.queue = [];
  }
}
