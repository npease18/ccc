export const AUTHOR = "Nicholas Pease";
export const COMMIT_HASH = process.env.COMMIT_HASH ?? "dev";

export function printVersion(programName: string): void {
    console.log(`${programName}`);
    console.log(`Author: ${AUTHOR}`);
    console.log(`Commit: ${COMMIT_HASH}`);
}
