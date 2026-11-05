/** A source cannot be clipped (too long, no usable content). Marked failed, not retried. */
export class SourceSkip extends Error {}

/** A platform quota or rate limit was hit. Stop posting to that platform for this run. */
export class PlatformLimit extends Error {}
