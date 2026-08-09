export type RuntimeDrainState = "draining" | "running";

const defaultDrainReason = () => new DOMException("The gateway is draining.", "AbortError");

export type RuntimeDrainMetadata = string | undefined;

/**
 * Owns the process-wide transition from accepting work to draining work.
 * The transition is deliberately one-way so every caller observes the same
 * abort signal once shutdown has started.
 */
export class RuntimeDrainCoordinator {
  #metadata: RuntimeDrainMetadata;
  #reason: DOMException | undefined;
  #state: RuntimeDrainState = "running";
  readonly #controller = new AbortController();

  get metadata(): RuntimeDrainMetadata {
    return this.#metadata;
  }

  get reason(): DOMException | undefined {
    return this.#reason;
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get state(): RuntimeDrainState {
    return this.#state;
  }

  beginDrain(metadata?: unknown): boolean {
    if (this.#state === "draining") return false;

    this.#state = "draining";
    this.#metadata =
      typeof metadata === "string"
        ? metadata
        : metadata instanceof Error
          ? metadata.message
          : undefined;
    this.#reason = defaultDrainReason();
    this.#controller.abort(this.#reason);
    return true;
  }
}

export function createRuntimeDrainCoordinator() {
  return new RuntimeDrainCoordinator();
}
