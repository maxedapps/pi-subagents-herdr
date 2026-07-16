import { ensureRuntimeGitExcludes } from "../../src/artifacts/git-ignore.ts";

const checkout = process.argv[2];
if (checkout === undefined) throw new Error("checkout argument required");
const report = await ensureRuntimeGitExcludes({ checkout });
if (!report.applicable || !report.protected) throw new Error("Git exclude protection failed");
