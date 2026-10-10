/**
 * An error a job handler throws when it has a specific reason to report.
 * The worker stores `code` on the failed row instead of the generic
 * `PROCESSING_ERROR`, so a later pass can key off it — the nightly
 * platform-scan sweep leaves an image refused for size alone instead of
 * re-queueing it every night until the row ages out of the jobs table.
 */
export class JobFailure extends Error {
    constructor(
        readonly code: string,
        message: string
    ) {
        super(message);
        this.name = "JobFailure";
    }
}

/** A platform scan refused before the pull: the manifest declares more compressed bytes than `PLATFORM_SCAN_MAX_IMAGE_BYTES`. */
export const IMAGE_TOO_LARGE = "IMAGE_TOO_LARGE";
