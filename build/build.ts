import { emitArtifact } from "./emit.ts";
import { piPackageDir, claudePluginDir } from "./paths.ts";

emitArtifact("pi", piPackageDir);
emitArtifact("claude", claudePluginDir);

console.log("built:");
console.log("  pi package:    " + piPackageDir);
console.log("  claude plugin: " + claudePluginDir);
